// src/core/services/byok-vision.service.ts
// Service optionnel "Bring Your Own Key" (BYOK) — 0€ de coût serveur.
// L'utilisateur peut coller une clé API gratuite (Google Gemini Flash via AI Studio ou Groq)
// stockée uniquement sur son téléphone (localStorage) pour :
// 1. Identifier un livre à partir d'une photo de couverture
// 2. Identifier toute une étagère de livres avec validation livre par livre.

import { compressImageToWebpDataUrl } from '../utils/webp-compressor.util';

export type ByokProvider = 'gemini' | 'groq';

export interface ByokSettings {
  provider: ByokProvider;
  apiKey: string;
}

export interface RecognizedBookCandidate {
  spineIndex?: number;
  rawSpineText?: string;
  title: string;
  subtitle?: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  illustrator?: string;
  publisher?: string;
  collection?: string;
  isbn?: string;
  confidence?: 'high' | 'medium' | 'low';
  selected?: boolean;
}

const STORAGE_KEY = 'biblio_byok_vision_settings';

const PREFERRED_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash',
  'gemini-3.0-flash',
  'gemini-2.5-flash'
];

const PREFERRED_GROQ_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3.8-27b'
];

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1500, 3000, 5500];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatApiError(provider: ByokProvider, status: number, rawBody: string): string {
  if (status === 402 || rawBody.includes('prepayment credits are depleted')) {
    return `${provider === 'gemini' ? 'Gemini' : 'Groq'} (402) : Crédits prépayés épuisés sur ce projet Cloud. Utilisez un projet sans facturation (Free Tier) ou Groq.`;
  }
  if (status === 503 || status === 502 || status === 504) {
    return `${provider === 'gemini' ? 'Gemini' : 'Groq'} (${status}) : Serveurs temporairement saturés même après plusieurs tentatives automatiques. Réessayez dans quelques secondes ou utilisez Groq.`;
  }
  if (status === 429) {
    return `${provider === 'gemini' ? 'Gemini' : 'Groq'} (429) : Quota gratuit dépassé ou non disponible sur ce projet dans cette région. Essayez Groq (gratuit) dans le sélecteur ci-dessus.`;
  }
  if (status === 403) {
    return `${provider === 'gemini' ? 'Gemini' : 'Groq'} (403) : Clé refusée ou API non activée sur ce projet.`;
  }
  return `Erreur API ${provider === 'gemini' ? 'Gemini' : 'Groq'} (${status}): ${rawBody.slice(0, 180)}`;
}

async function callModelsWithRetry(params: {
  provider: ByokProvider;
  models: string[];
  requestForModel: (modelId: string) => Promise<Response>;
  extractText: (json: any) => string;
  onStatus?: (msg: string) => void;
}): Promise<RecognizedBookCandidate[]> {
  let activeModels = [...params.models];
  let lastStatus = 503;
  let lastErrText = 'Serveur temporairement indisponible.';
  const maxCycles = RETRY_DELAYS_MS.length + 1;

  for (let cycle = 0; cycle < maxCycles && activeModels.length > 0; cycle++) {
    if (cycle > 0) {
      const waitMs = RETRY_DELAYS_MS[cycle - 1] ?? 5500;
      params.onStatus?.(
        `Serveur ${params.provider === 'gemini' ? 'Gemini' : 'Groq'} saturé (${lastStatus}) — nouvelle tentative ${cycle + 1}/${maxCycles} dans ${Math.round(waitMs / 100) / 10}s...`
      );
      await sleep(waitMs);
    }

    const nextCycleModels: string[] = [];
    for (let idx = 0; idx < activeModels.length; idx++) {
      const modelId = activeModels[idx];
      try {
        const res = await params.requestForModel(modelId);
        if (res.ok) {
          const json = await res.json();
          return parseCandidatesJson(params.extractText(json));
        }

        lastStatus = res.status;
        lastErrText = await res.text();

        // 404 = modèle indisponible pour cette clé -> bascule immédiate sans le réessayer au cycle suivant
        if (res.status === 404) {
          continue;
        }

        // Erreurs bloquantes (clé invalide, crédits prépayés épuisés, etc.) -> arrêt immédiat
        if (!TRANSIENT_STATUSES.has(res.status)) {
          throw new Error(formatApiError(params.provider, res.status, lastErrText));
        }

        nextCycleModels.push(modelId);
        // Petite pause avant d'essayer un modèle alternatif sur le même cycle
        if (idx < activeModels.length - 1) {
          params.onStatus?.(
            `Modèle ${modelId} occupé (${res.status}), essai d'un modèle alternatif...`
          );
          await sleep(450);
        }
      } catch (err: any) {
        // Relance immédiate si c'est une erreur métier déjà formatée
        if (err instanceof Error && err.message.startsWith('Erreur API')) {
          throw err;
        }
        if (
          err instanceof Error &&
          /(402|403|Crédits prépayés|Clé refusée)/.test(err.message)
        ) {
          throw err;
        }
        lastStatus = 503;
        lastErrText = err instanceof Error ? err.message : 'Erreur réseau';
        nextCycleModels.push(modelId);
      }
    }

    activeModels = nextCycleModels;
  }

  throw new Error(formatApiError(params.provider, lastStatus, lastErrText));
}

async function resolveAvailableGeminiModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) return PREFERRED_GEMINI_MODELS;
    const json = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const usable = (json.models || [])
      .filter(
        (m) =>
          m.name &&
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent')
      )
      .map((m) => String(m.name).replace(/^models\//, ''))
      .filter(
        (id) =>
          id.startsWith('gemini-') &&
          !id.includes('embedding') &&
          !id.includes('tts') &&
          !id.includes('audio') &&
          !id.includes('imagen') &&
          !id.includes('veo')
      );

    if (usable.length === 0) return PREFERRED_GEMINI_MODELS;

    const ordered: string[] = [];
    for (const pref of PREFERRED_GEMINI_MODELS) {
      if (usable.includes(pref) && !ordered.includes(pref)) ordered.push(pref);
    }
    const otherFlash = usable
      .filter((id) => id.includes('flash') && !ordered.includes(id))
      .sort()
      .reverse();
    const otherGemini = usable.filter((id) => !id.includes('flash') && !ordered.includes(id));
    return [...ordered, ...otherFlash, ...otherGemini];
  } catch {
    return PREFERRED_GEMINI_MODELS;
  }
}

export const byokVisionService = {
  getSettings(): ByokSettings | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ByokSettings;
      if (!parsed.apiKey?.trim()) return null;
      return {
        provider: parsed.provider || 'gemini',
        apiKey: parsed.apiKey.trim()
      };
    } catch {
      return null;
    }
  },

  saveSettings(settings: ByokSettings): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        provider: settings.provider,
        apiKey: settings.apiKey.trim()
      })
    );
  },

  clearSettings(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
  },

  async testKey(settings: ByokSettings): Promise<{ ok: boolean; message: string }> {
    const key = settings.apiKey.trim();
    if (!key) return { ok: false, message: 'Clé API vide.' };

    try {
      if (settings.provider === 'gemini') {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
        );
        if (!res.ok) {
          return { ok: false, message: 'Clé Gemini refusée. Vérifiez que vous avez bien copié toute la clé.' };
        }
        const available = await resolveAvailableGeminiModels(key);
        return {
          ok: true,
          message: `Clé Google Gemini validée (${available[0] || 'modèle prêt'}) !`
        };
      } else {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${key}` }
        });
        if (!res.ok) {
          return { ok: false, message: 'Clé Groq refusée. Vérifiez la clé.' };
        }
        return { ok: true, message: 'Clé Groq validée avec succès !' };
      }
    } catch (err: unknown) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Erreur réseau lors du test de la clé.'
      };
    }
  },

  async compressForMode(fileOrBlob: Blob | File, mode: 'cover' | 'shelf'): Promise<string> {
    return compressImageToWebpDataUrl(fileOrBlob, {
      maxWidth: mode === 'shelf' ? 2048 : 1024,
      maxHeight: mode === 'shelf' ? 2048 : 1280,
      quality: mode === 'shelf' ? 0.88 : 0.86
    });
  },

  async analyzePhoto(
    fileOrDataUrl: Blob | File | string,
    mode: 'cover' | 'shelf',
    onStatus?: (msg: string) => void
  ): Promise<RecognizedBookCandidate[]> {
    const settings = this.getSettings();
    if (!settings) {
      throw new Error("Aucune clé API configurée. Configurez votre clé gratuite dans l'assistant.");
    }

    let dataUrl: string;
    if (typeof fileOrDataUrl === 'string' && fileOrDataUrl.startsWith('data:')) {
      dataUrl = fileOrDataUrl;
    } else {
      onStatus?.('Compression WebP haute netteté de la photo en cours...');
      dataUrl = await this.compressForMode(fileOrDataUrl as Blob | File, mode);
    }

    const base64Data = dataUrl.split(',')[1] || '';
    const mimeMatch = /^data:([^;]+);base64,/.exec(dataUrl);
    const mimeType = mimeMatch?.[1] || 'image/jpeg';

    const prompt =
      mode === 'cover'
        ? `Analyse cette couverture (ou 4e de couverture) de livre ou bande dessinée. Extrais TOUS les éléments textuels visibles sans rien inventer de mémoire. Réponds UNIQUEMENT avec un tableau JSON valide d'un seul objet au format : [{"spineIndex":1,"rawSpineText":"Tout le texte exact visible sur la couverture/tranche","title":"Titre exact de l'album ou du livre","subtitle":"Sous-titre éventuel ou vide","series":"Nom de la série si BD/manga/saga ou vide","volumeNumber":"Numéro de tome en chiffres si visible ou vide","author":"Auteur ou scénariste visible ou vide","illustrator":"Dessinateur si distinct et visible ou vide","publisher":"Éditeur ou logo visible (Dupuis, Dargaud, Glénat, Lombard, Delcourt, Soleil, Casterman, Gallimard...) ou vide","collection":"Nom de collection éditoriale si distinct de la série (ex: Aire Libre, Repérages) ou vide","isbn":"ISBN-13 ou ISBN-10 si visible ou vide","confidence":"high|medium|low"}]. RÈGLE STRICTE : si un champ n'est pas lisible sur l'image, laisse "" ; n'invente jamais un auteur.`
        : `Analyse cette photo d'étagère ou de pile de livres/BD en travaillant STRICTEMENT TRANCHE PAR TRANCHE (de gauche à droite, ou de haut en bas pour une pile), sans jamais mélanger les informations de deux tranches voisines. Pour CHAQUE tranche, extrais d'abord TOUT le texte lisible sur cette tranche (y compris logos d'éditeur, numéros, sous-titres, auteurs/dessinateurs) dans rawSpineText, puis remplis les champs structurés. Réponds UNIQUEMENT avec un tableau JSON valide : [{"spineIndex":1,"rawSpineText":"Texte intégral lu sur cette tranche uniquement","title":"Titre du tome ou livre","subtitle":"Sous-titre si présent ou vide","series":"Nom de la série si BD/manga/saga ou vide","volumeNumber":"Numéro de tome en chiffres ou vide","author":"Auteur/scénariste lisible sur CETTE tranche ou vide","illustrator":"Dessinateur si lisible ou vide","publisher":"Éditeur ou logo visible sur CETTE tranche ou vide","collection":"Collection éditoriale si visible ou vide","isbn":"ISBN si visible ou vide","confidence":"high|medium|low"}]. RÈGLE STRICTE : n'invente et ne devine JAMAIS un auteur ou un titre absent/illisible ; laisse "" si tu n'es pas sûr.`;

    onStatus?.('Analyse visuelle des livres par l’IA...');

    if (settings.provider === 'gemini') {
      const candidateModels = (await resolveAvailableGeminiModels(settings.apiKey)).slice(0, 4);
      return callModelsWithRetry({
        provider: 'gemini',
        models: candidateModels,
        onStatus,
        requestForModel: (modelId) =>
          fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      { text: prompt },
                      { inline_data: { mime_type: mimeType, data: base64Data } }
                    ]
                  }
                ],
                generationConfig: {
                  temperature: 0.1,
                  responseMimeType: 'application/json'
                }
              })
            }
          ),
        extractText: (json) => json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]'
      });
    } else {
      return callModelsWithRetry({
        provider: 'groq',
        models: PREFERRED_GROQ_MODELS,
        onStatus,
        requestForModel: (modelId) =>
          fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
              model: modelId,
              temperature: 0.1,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: dataUrl } }
                  ]
                }
              ]
            })
          }),
        extractText: (json) => json?.choices?.[0]?.message?.content || '[]'
      });
    }
  }
};

function parseCandidatesJson(rawText: string): RecognizedBookCandidate[] {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const startBracket = cleaned.indexOf('[');
  const endBracket = cleaned.lastIndexOf(']');
  const jsonSlice =
    startBracket !== -1 && endBracket !== -1 ? cleaned.slice(startBracket, endBracket + 1) : cleaned;

  const parsed = JSON.parse(jsonSlice);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((item) => item && (item.title || item.series || item.rawSpineText))
    .map((item, idx) => {
      const conf = item.confidence === 'low' || item.confidence === 'medium' || item.confidence === 'high'
        ? item.confidence
        : undefined;
      return {
        spineIndex: typeof item.spineIndex === 'number' ? item.spineIndex : idx + 1,
        rawSpineText: item.rawSpineText ? String(item.rawSpineText).trim() : undefined,
        title: String(item.title || item.series || item.rawSpineText || '').trim(),
        subtitle: item.subtitle ? String(item.subtitle).trim() : undefined,
        series: item.series ? String(item.series).trim() : undefined,
        volumeNumber: item.volumeNumber ? String(item.volumeNumber).trim() : undefined,
        author: item.author ? String(item.author).trim() : undefined,
        illustrator: item.illustrator ? String(item.illustrator).trim() : undefined,
        publisher: item.publisher ? String(item.publisher).trim() : undefined,
        collection: item.collection ? String(item.collection).trim() : undefined,
        isbn: item.isbn ? String(item.isbn).replace(/[^0-9Xx]/g, '').trim() : undefined,
        confidence: conf,
        selected: true
      };
    });
}
