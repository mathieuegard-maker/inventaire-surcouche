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
        return { ok: true, message: 'Clé Google Gemini validée avec succès !' };
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
    const mimeType = dataUrl.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';

    const prompt =
      mode === 'cover'
        ? `Analyse cette couverture de livre ou bande dessinée. Réponds UNIQUEMENT avec un tableau JSON valide d'un seul objet au format : [{"title":"Titre exact","series":"Nom de la série si BD/saga ou vide","volumeNumber":"Numéro de tome si présent ou vide","author":"Auteur principal","publisher":"Éditeur si lisible"}]. Aucun texte autour.`
        : `Analyse cette photo d'étagère ou de pile de livres/BD. Liste chaque livre lisible sur les tranches ou couvertures. Réponds UNIQUEMENT avec un tableau JSON valide au format : [{"title":"Titre du livre ou tome","series":"Nom de la série si applicable","volumeNumber":"Numéro de tome si lisible","author":"Auteur si lisible","publisher":"Éditeur si lisible"}]. Aucun texte autour.`;

    if (settings.provider === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
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

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Erreur API Gemini (${res.status}): ${errText.slice(0, 150)}`);
      }
      const json = await res.json();
      const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      return parseCandidatesJson(rawText);
    } else {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
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

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Erreur API Groq (${res.status}): ${errText.slice(0, 150)}`);
      }
      const json = await res.json();
      const rawText = json?.choices?.[0]?.message?.content || '[]';
      return parseCandidatesJson(rawText);
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
