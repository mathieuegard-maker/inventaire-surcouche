// src/server/connectors/gemini.connector.ts
// Connecteur Gemini Vision OCR (clé API serveur GEMINI_API_KEY, terme BYOK supprimé, 100 % mockable).

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

const GEMINI_MODEL = 'gemini-2.5-flash';

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

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        }),
        signal: AbortSignal.timeout(45000)
      });

      if (!res.ok) {
        throw new Error(`Erreur Gemini Vision (HTTP ${res.status}).`);
      }

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
      const cleanedJson = rawText.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
      const parsed = JSON.parse(cleanedJson);
      return normalizeHints(parsed);
    }
  };
}
