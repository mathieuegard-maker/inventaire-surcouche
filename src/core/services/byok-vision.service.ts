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
  title: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  publisher?: string;
  isbn?: string;
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

function formatApiError(provider: ByokProvider, status: number, rawBody: string): string {
  if (status === 402 || rawBody.includes('prepayment credits are depleted')) {
    return `${provider === 'gemini' ? 'Gemini' : 'Groq'} (402) : Crédits prépayés épuisés sur ce projet Cloud. Utilisez un projet sans facturation (Free Tier) ou Groq.`;
  }
  if (status === 429) {
    return `${provider === 'gemini' ? 'Gemini' : 'Groq'} (429) : Quota gratuit dépassé ou non disponible sur ce projet dans cette région. Essayez Groq (gratuit) dans le sélecteur ci-dessus.`;
  }
  if (status === 403) {
    return `${provider === 'gemini' ? 'Gemini' : 'Groq'} (403) : Clé refusée ou API non activée sur ce projet.`;
  }
  return `Erreur API ${provider === 'gemini' ? 'Gemini' : 'Groq'} (${status}): ${rawBody.slice(0, 180)}`;
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

  async analyzePhoto(
    fileOrBlob: Blob | File,
    mode: 'cover' | 'shelf'
  ): Promise<RecognizedBookCandidate[]> {
    const settings = this.getSettings();
    if (!settings) {
      throw new Error("Aucune clé API configurée. Configurez votre clé gratuite dans l'assistant.");
    }

    const dataUrl = await compressImageToWebpDataUrl(fileOrBlob, {
      maxWidth: mode === 'shelf' ? 1280 : 800,
      maxHeight: mode === 'shelf' ? 1280 : 1000,
      quality: 0.82
    });

    const base64Data = dataUrl.split(',')[1] || '';
    const mimeMatch = /^data:([^;]+);base64,/.exec(dataUrl);
    const mimeType = mimeMatch?.[1] || 'image/jpeg';

    const prompt =
      mode === 'cover'
        ? `Analyse cette couverture de livre ou bande dessinée. Réponds UNIQUEMENT avec un tableau JSON valide d'un seul objet au format : [{"title":"Titre exact","series":"Nom de la série si BD/saga ou vide","volumeNumber":"Numéro de tome si présent ou vide","author":"Auteur principal","publisher":"Éditeur si lisible"}]. Aucun texte autour.`
        : `Analyse cette photo d'étagère ou de pile de livres/BD. Liste chaque livre lisible sur les tranches ou couvertures. Réponds UNIQUEMENT avec un tableau JSON valide au format : [{"title":"Titre du livre ou tome","series":"Nom de la série si applicable","volumeNumber":"Numéro de tome si lisible","author":"Auteur si lisible","publisher":"Éditeur si lisible"}]. Aucun texte autour.`;

    if (settings.provider === 'gemini') {
      const candidateModels = await resolveAvailableGeminiModels(settings.apiKey);
      let lastStatus = 404;
      let lastErrText = 'Aucun modèle Gemini compatible trouvé.';

      for (const modelId of candidateModels.slice(0, 6)) {
        const res = await fetch(
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
        );

        if (res.ok) {
          const json = await res.json();
          const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
          return parseCandidatesJson(rawText);
        }

        lastStatus = res.status;
        lastErrText = await res.text();
        // Si le modèle est obsolète / non accessible pour cette clé (404), on essaie automatiquement le suivant
        if (res.status !== 404) {
          throw new Error(formatApiError('gemini', res.status, lastErrText));
        }
      }

      throw new Error(formatApiError('gemini', lastStatus, lastErrText));
    } else {
      let lastStatus = 404;
      let lastErrText = 'Aucun modèle Groq vision compatible trouvé.';

      for (const modelId of PREFERRED_GROQ_MODELS) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
        });

        if (res.ok) {
          const json = await res.json();
          const rawText = json?.choices?.[0]?.message?.content || '[]';
          return parseCandidatesJson(rawText);
        }

        lastStatus = res.status;
        lastErrText = await res.text();
        if (res.status !== 404) {
          throw new Error(formatApiError('groq', res.status, lastErrText));
        }
      }

      throw new Error(formatApiError('groq', lastStatus, lastErrText));
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
    .filter((item) => item && (item.title || item.series))
    .map((item) => ({
      title: String(item.title || item.series || '').trim(),
      series: item.series ? String(item.series).trim() : undefined,
      volumeNumber: item.volumeNumber ? String(item.volumeNumber).trim() : undefined,
      author: item.author ? String(item.author).trim() : undefined,
      publisher: item.publisher ? String(item.publisher).trim() : undefined,
      selected: true
    }));
}
