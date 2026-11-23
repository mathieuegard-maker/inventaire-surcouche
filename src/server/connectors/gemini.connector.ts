// src/server/connectors/gemini.connector.ts
// Connecteur Gemini Vision OCR (clé serveur GEMINI_API_KEY, ordre strict gauche->droite avec spineIndex/rawText, cascade multi-modèles).

export interface GeminiExtractedBookHint {
  /** Position d'ordre visuel (1 = 1er livre à gauche ou en haut d'une pile). */
  spineIndex?: number;
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

function extractBase64Payload(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2].replace(/\s+/g, '') };
}

function buildPrompt(mode: 'shelf' | 'cover'): string {
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
    'Tu es un moteur OCR spécialisé dans les étagères et piles de livres / bandes dessinées.',
    'Analyse la photo STRICTEMENT TRANCHE PAR TRANCHE dans l’ordre visuel : de GAUCHE À DROITE pour une rangée (ou de HAUT EN BAS pour une pile).',
    '1. Délimite chaque livre individuellement (bords, couleur, ombre). Si des livres sont penchés, suis strictement l’angle de chaque tranche sans mélanger deux livres voisins.',
    '2. Attribue `spineIndex` dans l’ordre strict (1 = le plus à gauche, 2 = le suivant, etc.).',
    '3. Mets dans `rawText` tout le texte lisible sur CETTE tranche uniquement.',
    '4. Extrais `title`, `series`, `volumeNumber` (chiffre de tome uniquement, jamais une année/prix), `author`, `publisher`, `isbn` (si lisible), `confidence`.',
    'Retourne UNIQUEMENT un tableau JSON strict (sans markdown) :',
    '[{"spineIndex": 1, "rawText": "...", "title": "...", "series": "...", "volumeNumber": "...", "author": "...", "publisher": "...", "isbn": "...", "confidence": "high|medium|low"}]',
    'RÈGLE ANTI-HALLUCINATION : laisse vides les champs illisibles ou incertains.'
  ].join('\n');
}

function normalizeHints(raw: unknown): GeminiExtractedBookHint[] {
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

    out.push({
      spineIndex,
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

  out.sort((a, b) => (a.spineIndex ?? 0) - (b.spineIndex ?? 0));
  return out.slice(0, 60).map((item, idx) => ({ ...item, spineIndex: idx + 1 }));
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

      const requestBody = JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildPrompt(input.mode) },
              { inline_data: { mime_type: payload.mimeType, data: payload.data } }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });

      let lastStatus = 0;
      let lastErrorText = '';

      for (let round = 1; round <= 2; round++) {
        if (round > 1) {
          await new Promise((r) => setTimeout(r, 1500));
        }

        for (const modelId of PREFERRED_GEMINI_MODELS) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(cleanKey)}`;
          try {
            const res = await fetchImpl(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: requestBody,
              signal: AbortSignal.timeout(35000)
            });

            if (res.ok) {
              const data = (await res.json()) as {
                candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
              };
              const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
              const cleanedJson = rawText.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
              const parsed = JSON.parse(cleanedJson);
              return normalizeHints(parsed);
            }

            lastStatus = res.status;
            lastErrorText = (await res.text().catch(() => '')).slice(0, 200);

            if (res.status === 404 || res.status === 429 || res.status === 503 || res.status >= 500) {
              continue;
            }
            throw new Error(`Erreur Gemini Vision (HTTP ${res.status}).`);
          } catch (err) {
            if (err instanceof Error && err.message.startsWith('Erreur Gemini Vision')) {
              throw err;
            }
            lastErrorText = err instanceof Error ? err.message : 'Erreur réseau';
          }
        }
      }

      throw new Error(
        lastStatus
          ? `Erreur Gemini Vision (HTTP ${lastStatus}${lastErrorText ? ` — ${lastErrorText}` : ''}).`
          : `Erreur Gemini Vision (${lastErrorText || 'indisponible'}).`
      );
    }
  };
}
