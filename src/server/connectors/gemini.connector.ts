// src/server/connectors/gemini.connector.ts
// Connecteur Gemini Vision OCR (clé API serveur GEMINI_API_KEY, cascade multi-modèles avec bascule auto sur 404/429/503).

export interface GeminiExtractedBookHint {
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
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite'
] as const;

function extractBase64Payload(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2].replace(/\s+/g, '') };
}

function buildPrompt(mode: 'shelf' | 'cover'): string {
  const scope =
    mode === 'cover'
      ? 'Cette photo montre la couverture (ou le dos) d’un livre unique.'
      : 'Cette photo montre une étagère ou une pile de livres (tranches et/ou couvertures).';
  return [
    scope,
    'Extrais chaque livre lisible sous forme de tableau JSON strict (sans markdown) :',
    '[{"title": "...", "series": "...", "volumeNumber": "...", "author": "...", "publisher": "...", "isbn": "...", "confidence": "high|medium|low"}]',
    'Ne devine pas d’ISBN absent. Laisse vides les champs illisibles.'
  ].join('\n');
}

function normalizeHints(raw: unknown): GeminiExtractedBookHint[] {
  if (!Array.isArray(raw)) return [];
  const out: GeminiExtractedBookHint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const series = typeof obj.series === 'string' ? obj.series.trim() || undefined : undefined;
    if (!title && !series) continue;
    const confRaw = typeof obj.confidence === 'string' ? obj.confidence.toLowerCase() : 'medium';
    const confidence: 'high' | 'medium' | 'low' =
      confRaw === 'high' || confRaw === 'low' ? confRaw : 'medium';

    out.push({
      title: title || series || '',
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
  return out.slice(0, 60);
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
          await new Promise((r) => setTimeout(r, 800));
        }

        for (const modelId of PREFERRED_GEMINI_MODELS) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(cleanKey)}`;
          try {
            const res = await fetchImpl(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: requestBody,
              signal: AbortSignal.timeout(30000)
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

            // Basculer sur le modèle suivant en cas de 404 (modèle déprécié), 429 ou 503 (surcharge)
            if (res.status === 404 || res.status === 429 || res.status === 503 || res.status >= 500) {
              continue;
            }
            // Erreur client bloquante (ex: 400 clé invalide, 403)
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
