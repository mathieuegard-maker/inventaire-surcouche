// src/server/connectors/gemini.connector.ts
// Connecteur Gemini Vision OCR (clé serveur GEMINI_API_KEY, ancrage géométrique & chromatique anti-mélange sur tranches penchées,
// Vision HD MEDIA_RESOLUTION_HIGH, thinking Gemini 3 léger, repli automatique HTTP 400, cascade multi-modèles).

export type GeminiSpineTilt = 'vertical' | 'lean_left' | 'lean_right' | 'horizontal';

export interface GeminiExtractedBookHint {
  /** Position d'ordre visuel (1 = 1er livre à gauche ou en haut d'une pile). */
  spineIndex?: number;
  /** Inclinaison détectée de la tranche sur la photo. */
  tilt?: GeminiSpineTilt;
  /** Couleur / motif dominant du dos (verrou visuel de continuité haut -> bas). */
  spineColor?: string;
  /** Position horizontale normalisée (0..1000) du centre du sommet de la tranche. */
  topX?: number;
  /** Position horizontale normalisée (0..1000) du centre du pied de la tranche. */
  bottomX?: number;
  /** Texte brut exact lu sur cette tranche / couverture. */
  rawText?: string;
  title: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  publisher?: string;
  isbn?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface GeminiConnector {
  isConfigured(): boolean;
  extractBooksFromImage(input: {
    imageDataUrl: string;
    mimeType: string;
    mode: 'shelf' | 'cover';
  }): Promise<GeminiExtractedBookHint[]>;
}

export const PREFERRED_GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-flash-lite'
] as const;

const GEMINI_TIMEOUT_MS = 55_000;
const TILT_DELTA_THRESHOLD = 35;

const SHELF_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      spineIndex: { type: 'INTEGER' },
      tilt: { type: 'STRING', enum: ['vertical', 'lean_left', 'lean_right', 'horizontal'] },
      spineColor: { type: 'STRING' },
      topX: { type: 'INTEGER' },
      bottomX: { type: 'INTEGER' },
      rawText: { type: 'STRING' },
      title: { type: 'STRING' },
      series: { type: 'STRING' },
      volumeNumber: { type: 'STRING' },
      author: { type: 'STRING' },
      publisher: { type: 'STRING' },
      isbn: { type: 'STRING' },
      confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] }
    },
    propertyOrdering: [
      'spineIndex',
      'tilt',
      'spineColor',
      'topX',
      'bottomX',
      'rawText',
      'title',
      'series',
      'volumeNumber',
      'author',
      'publisher',
      'isbn',
      'confidence'
    ],
    required: ['spineIndex', 'tilt', 'spineColor', 'topX', 'bottomX', 'rawText', 'title', 'confidence']
  }
} as const;

function isGemini3Model(modelId: string): boolean {
  return /^gemini-3/i.test(modelId);
}

function extractBase64Payload(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2].replace(/\s+/g, '') };
}

export function buildGeminiPrompt(mode: 'shelf' | 'cover'): string {
  if (mode === 'cover') {
    return [
      'Tu es un moteur OCR spécialisé dans les livres et bandes dessinées.',
      'Cette photo montre la couverture (ou 4e de couverture) d’un livre unique.',
      'Extrais STRICTEMENT le texte visible sans rien inventer, sous forme de tableau JSON (1 objet) :',
      '[{"spineIndex": 1, "rawText": "texte exact visible", "title": "...", "series": "...", "volumeNumber": "...", "author": "...", "publisher": "...", "isbn": "...", "confidence": "high|medium|low"}]',
      'Laisse vides les champs illisibles. Ne devine jamais un ISBN absent.'
    ].join('\n');
  }

  return [
    'Tu es un moteur OCR expert en étagères et piles de livres, bandes dessinées, comics et mangas.',
    '',
    'MÉTHODE D’ANALYSE OBLIGATOIRE (NE PAS SAUTER D’ÉTAPE) :',
    'Étape 1 — Repérage par contraste et blocs parallèles :',
    '- Repère d’abord les frontières nettes entre les tranches (fort contraste de couleur de fond, liserés d’ombre, arêtes, épaisseurs).',
    '- Identifie les groupes de livres qui partagent le même angle d’inclinaison (bloc vertical, bloc penché à gauche, bloc penché à droite, pile horizontale). Dans un bloc penché, les tranches sont parallèles entre elles : suis cet axe oblique, JAMAIS la verticale pure de la photo.',
    '',
    'Étape 2 — Suivi strict du haut vers le bas pour CHAQUE tranche :',
    '- Pour chaque livre, repère le centre de son sommet (`topX`, entier de 0 à 1000) et le centre de son pied (`bottomX`, entier de 0 à 1000), ainsi que la couleur/motif de son dos (`spineColor`).',
    '- Si le livre est penché (`topX` différent de `bottomX`), suis STRICTEMENT le segment diagonal reliant `topX` à `bottomX` en vérifiant que la couleur de fond et les bords restent continus jusqu’en bas.',
    '- PIÈGE FRÉQUENT À ÉVITER : sur un livre penché, le logo éditeur ou le numéro de tome situé à la verticale directe sous le titre appartient souvent au livre VOISIN. Ne mélange JAMAIS le haut d’un livre avec le bas du livre d’à côté.',
    '',
    'Étape 3 — Extraction JSON stricte (ordre de GAUCHE À DROITE selon le pied du livre, ou HAUT EN BAS pour une pile) :',
    'Pour chaque livre, remplis les champs DANS CET ORDRE EXACT :',
    '1. `spineIndex` (1, 2, 3...)',
    '2. `tilt` ("vertical" | "lean_left" | "lean_right" | "horizontal")',
    '3. `spineColor` (description courte du fond du dos, ex: "jaune", "noir filet rouge")',
    '4. `topX` (entier 0..1000, position horizontale du haut de la tranche)',
    '5. `bottomX` (entier 0..1000, position horizontale du bas de la tranche)',
    '6. `rawText` (tout le texte lisible le long de CE segment oblique uniquement, du haut vers le bas)',
    '7. `title`, `series`, `volumeNumber` (chiffre de tome uniquement, jamais une année/prix), `author`, `publisher`, `isbn` (si lisible), `confidence` ("high" | "medium" | "low")',
    '',
    'Retourne UNIQUEMENT un tableau JSON strict (sans markdown) :',
    '[{"spineIndex": 1, "tilt": "vertical", "spineColor": "...", "topX": 120, "bottomX": 120, "rawText": "...", "title": "...", "series": "...", "volumeNumber": "...", "author": "...", "publisher": "...", "isbn": "...", "confidence": "high|medium|low"}]',
    'RÈGLE ANTI-HALLUCINATION : laisse vides les champs illisibles ou incertains ; si le bas d’une tranche est masqué ou ambigu, laisse `publisher` ou `volumeNumber` vide plutôt que d’emprunter celui du voisin.'
  ].join('\n');
}

function parseNormalizedCoord(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(0, Math.min(1000, Math.round(num)));
}

function parseTilt(value: unknown): GeminiSpineTilt | undefined {
  if (typeof value !== 'string') return undefined;
  const norm = value.trim().toLowerCase();
  if (norm === 'vertical' || norm === 'lean_left' || norm === 'lean_right' || norm === 'horizontal') {
    return norm;
  }
  return undefined;
}

function normalizeHints(raw: unknown, mode: 'shelf' | 'cover'): GeminiExtractedBookHint[] {
  if (!Array.isArray(raw)) return [];
  const out: GeminiExtractedBookHint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const series = typeof obj.series === 'string' ? obj.series.trim() || undefined : undefined;
    const rawText = typeof obj.rawText === 'string' ? obj.rawText.trim() || undefined : undefined;
    if (!title && !series && !rawText) continue;

    const confRaw = typeof obj.confidence === 'string' ? obj.confidence.toLowerCase() : 'medium';
    const confidence: 'high' | 'medium' | 'low' =
      confRaw === 'high' || confRaw === 'low' ? confRaw : 'medium';

    const rawIndex = Number(obj.spineIndex);
    const spineIndex = Number.isInteger(rawIndex) && rawIndex > 0 ? rawIndex : out.length + 1;

    const topX = parseNormalizedCoord(obj.topX);
    const bottomX = parseNormalizedCoord(obj.bottomX);
    let tilt = parseTilt(obj.tilt);
    if ((!tilt || tilt === 'vertical') && topX !== undefined && bottomX !== undefined) {
      const delta = topX - bottomX;
      if (delta >= TILT_DELTA_THRESHOLD) {
        tilt = 'lean_right';
      } else if (delta <= -TILT_DELTA_THRESHOLD) {
        tilt = 'lean_left';
      }
    }

    const spineColorRaw = typeof obj.spineColor === 'string' ? obj.spineColor.trim() : '';
    const spineColor = spineColorRaw ? spineColorRaw.slice(0, 80) : undefined;

    out.push({
      spineIndex,
      ...(tilt ? { tilt } : {}),
      ...(spineColor ? { spineColor } : {}),
      ...(topX !== undefined ? { topX } : {}),
      ...(bottomX !== undefined ? { bottomX } : {}),
      rawText,
      title: title || series || rawText || '',
      series,
      volumeNumber:
        typeof obj.volumeNumber === 'string' || typeof obj.volumeNumber === 'number'
          ? String(obj.volumeNumber).trim() || undefined
          : undefined,
      author: typeof obj.author === 'string' ? obj.author.trim() || undefined : undefined,
      publisher: typeof obj.publisher === 'string' ? obj.publisher.trim() || undefined : undefined,
      isbn: typeof obj.isbn === 'string' ? obj.isbn.trim() || undefined : undefined,
      confidence
    });
  }

  // En mode étagère (hors pile horizontale), trier par coordonnée spatiale `bottomX` si toutes les tranches sont géolocalisées
  // avec un étalement horizontal significatif (garantit l'ordre strict gauche -> droite même sur livres penchés).
  const horizontalCount = out.filter((item) => item.tilt === 'horizontal').length;
  const isHorizontalStack = out.length > 0 && horizontalCount >= Math.ceil(out.length / 2);
  const allHaveSpatialX =
    mode === 'shelf' &&
    !isHorizontalStack &&
    out.length >= 2 &&
    out.every((item) => typeof item.bottomX === 'number' || typeof item.topX === 'number');

  let useSpatialSort = false;
  if (allHaveSpatialX) {
    const xs = out.map((item) => item.bottomX ?? item.topX ?? 0);
    const spread = Math.max(...xs) - Math.min(...xs);
    useSpatialSort = spread >= 80;
  }

  if (useSpatialSort) {
    out.sort((a, b) => {
      const xa = a.bottomX ?? a.topX ?? 0;
      const xb = b.bottomX ?? b.topX ?? 0;
      if (xa !== xb) return xa - xb;
      return (a.spineIndex ?? 0) - (b.spineIndex ?? 0);
    });
  } else {
    out.sort((a, b) => (a.spineIndex ?? 0) - (b.spineIndex ?? 0));
  }

  return out.slice(0, 60).map((item, idx) => ({ ...item, spineIndex: idx + 1 }));
}

function extractResponseJsonText(data: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
}): string {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const answerParts = parts.filter((p) => !p.thought && typeof p.text === 'string' && p.text.trim().length > 0);
  if (answerParts.length > 0) {
    return answerParts.map((p) => p.text!).join('\n');
  }
  const fallbackPart = parts.find((p) => typeof p.text === 'string' && p.text.trim().length > 0);
  return fallbackPart?.text ?? '[]';
}

function parseGeminiJsonArray(rawText: string): unknown {
  const cleaned = rawText.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new SyntaxError('Réponse JSON Gemini invalide');
  }
}

function buildRequestBody(params: {
  modelId: string;
  mode: 'shelf' | 'cover';
  payload: { mimeType: string; data: string };
  enhanced: boolean;
}): string {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    temperature: 0.1
  };

  if (params.enhanced) {
    generationConfig.mediaResolution = 'MEDIA_RESOLUTION_HIGH';
    if (params.mode === 'shelf') {
      generationConfig.responseSchema = SHELF_RESPONSE_SCHEMA;
      if (isGemini3Model(params.modelId)) {
        generationConfig.thinkingConfig = { thinkingLevel: 'low' };
      }
    }
  }

  return JSON.stringify({
    contents: [
      {
        parts: [
          { inline_data: { mime_type: params.payload.mimeType, data: params.payload.data } },
          { text: buildGeminiPrompt(params.mode) }
        ]
      }
    ],
    generationConfig
  });
}

function formatFriendlyGeminiError(status: number, rawDetail: string): string {
  const lower = rawDetail.toLowerCase();
  if (status === 503 || lower.includes('high demand') || lower.includes('unavailable') || lower.includes('overloaded')) {
    return "Le service d'analyse photo (IA Gemini) est momentanément surchargé. Patientez quelques secondes puis cliquez sur « Réessayer ».";
  }
  if (status === 429 || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return 'Limite temporaire du service IA atteinte. Patientez une minute puis cliquez sur « Réessayer ».';
  }
  if (status === 401 || status === 403) {
    return 'Accès au service IA Gemini refusé côté serveur (vérifiez la clé API).';
  }
  if (lower.includes('timeout') || lower.includes('aborted')) {
    return 'Le service IA met trop de temps à répondre. Cliquez sur « Réessayer ».';
  }
  if (status >= 500) {
    return `Le service IA Gemini rencontre une erreur temporaire (HTTP ${status}). Cliquez sur « Réessayer ».`;
  }
  return "Impossible d'analyser la photo pour le moment. Cliquez sur « Réessayer ».";
}

export function createGeminiConnector(apiKey: string, fetchImpl: typeof fetch = fetch): GeminiConnector {
  const cleanKey = (apiKey || '').trim();

  return {
    isConfigured(): boolean {
      return cleanKey.length > 0;
    },

    async extractBooksFromImage(input): Promise<GeminiExtractedBookHint[]> {
      if (!cleanKey) {
        throw new Error('Clé serveur GEMINI_API_KEY non configurée.');
      }

      const payload = extractBase64Payload(input.imageDataUrl);
      if (!payload) {
        throw new Error('Format image data URL invalide.');
      }

      let lastStatus = 0;
      let lastErrorText = '';

      for (let round = 1; round <= 2; round++) {
        if (round > 1) {
          await new Promise((r) => setTimeout(r, 1500));
        }

        for (const modelId of PREFERRED_GEMINI_MODELS) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(cleanKey)}`;
          try {
            let res = await fetchImpl(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: buildRequestBody({ modelId, mode: input.mode, payload, enhanced: true }),
              signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
            });

            // Repli de compatibilité automatique si un modèle rejette un paramètre Vision HD / Thinking / Schema (HTTP 400)
            if (res.status === 400) {
              res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: buildRequestBody({ modelId, mode: input.mode, payload, enhanced: false }),
                signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
              });
            }

            if (res.ok) {
              const data = (await res.json()) as {
                candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
              };
              const rawText = extractResponseJsonText(data);
              const parsed = parseGeminiJsonArray(rawText);
              return normalizeHints(parsed, input.mode);
            }

            lastStatus = res.status;
            lastErrorText = (await res.text().catch(() => '')).slice(0, 200);

            if (res.status === 404 || res.status === 429 || res.status === 503 || res.status >= 500) {
              continue;
            }
            throw new Error(formatFriendlyGeminiError(res.status, lastErrorText));
          } catch (err) {
            if (err instanceof Error && err.message.startsWith('Accès au service IA')) {
              throw err;
            }
            lastErrorText = err instanceof Error ? err.message : 'Erreur réseau';
          }
        }
      }

      throw new Error(formatFriendlyGeminiError(lastStatus, lastErrorText));
    }
  };
}
