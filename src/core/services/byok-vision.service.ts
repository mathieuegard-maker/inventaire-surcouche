// src/core/services/byok-vision.service.ts
// Service optionnel "Bring Your Own Key" (BYOK) — 0€ de coût serveur.
// L'utilisateur peut coller une clé API gratuite (Google Gemini Flash via AI Studio ou Groq)
// stockée uniquement sur son téléphone (localStorage) pour :
// 1. Identifier un livre à partir d'une photo de couverture
// 2. Identifier toute une étagère de livres avec validation livre par livre.

import { compressImageToWebpDataUrl } from '../utils/webp-compressor.util';
import { sessionStore } from '../../state/session';

export interface ServerVisionStatus {
  serverAvailable: boolean;
  totalUsed: number;
  monthUsed: number;
  monthlyQuota: number;
  remainingQuota: number;
}

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

  async compressForMode(fileOrBlob: Blob | File, mode: 'cover' | 'shelf'): Promise<string> {
    return compressImageToWebpDataUrl(fileOrBlob, {
      maxWidth: mode === 'shelf' ? 2048 : 1024,
      maxHeight: mode === 'shelf' ? 2048 : 1280,
      quality: mode === 'shelf' ? 0.88 : 0.86
    });
  },

  async fetchServerVisionStatus(): Promise<ServerVisionStatus> {
    try {
      const savedUri = sessionStore.getUserUri() || '';
      const query = savedUri ? `&uri=${encodeURIComponent(savedUri)}` : '';
      const res = await fetch(`/api/gateway?action=vision-status${query}`);
      if (!res.ok) {
        return { serverAvailable: false, totalUsed: 0, monthUsed: 0, monthlyQuota: 100, remainingQuota: 0 };
      }
      return (await res.json()) as ServerVisionStatus;
    } catch {
      return { serverAvailable: false, totalUsed: 0, monthUsed: 0, monthlyQuota: 100, remainingQuota: 0 };
    }
  },

  async analyzePhoto(
    fileOrDataUrl: Blob | File | string,
    mode: 'cover' | 'shelf',
    onStatus?: (msg: string) => void
  ): Promise<RecognizedBookCandidate[]> {
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

    onStatus?.('Analyse visuelle des livres par l’IA...');
    const res = await fetch('/api/gateway?action=vision-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: base64Data,
        mimeType,
        mode,
        userUri: sessionStore.getUserUri() || ''
      })
    });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) {
      throw new Error(data?.error || "Impossible d'analyser la photo pour le moment.");
    }
    return parseCandidatesJson(data.text || '[]');
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
