// src/core/resolvers/googlebooks.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';
import { isbnUtil } from '../utils/isbn.util';

export interface BookSearchHints {
  title?: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  publisher?: string;
}

function extractVolumeMetadata(isbn: string, volumeInfo: any): ExternalBookMetadata {
  const title = volumeInfo.title?.trim() || '';
  const authors: string[] = volumeInfo.authors || [];
  const publisher = volumeInfo.publisher?.trim() || undefined;

  let publishDate: string | undefined = undefined;
  if (volumeInfo.publishedDate) {
    const match = String(volumeInfo.publishedDate).match(/\d{4}/);
    if (match) publishDate = match[0];
  }

  const pageCount = volumeInfo.pageCount ? parseInt(volumeInfo.pageCount, 10) : undefined;

  let coverUrl: string | undefined = undefined;
  if (volumeInfo.imageLinks) {
    const links = volumeInfo.imageLinks;
    const rawCover = links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail;
    if (rawCover) {
      coverUrl = rawCover.replace(/^http:\/\//i, 'https://');
    }
  }

  return {
    isbn,
    title,
    authors,
    publisher,
    publishDate,
    pageCount,
    coverUrl
  };
}

function extractBestIsbnFromVolume(volumeInfo: any): string | null {
  const identifiers: Array<{ type?: string; identifier?: string }> = volumeInfo?.industryIdentifiers || [];
  const isbn13 = identifiers.find((id) => id.type === 'ISBN_13' && id.identifier)?.identifier;
  if (isbn13 && isbnUtil.isValidFormat(isbn13)) {
    return isbnUtil.normalize(isbn13);
  }
  const isbn10 = identifiers.find((id) => id.type === 'ISBN_10' && id.identifier)?.identifier;
  if (isbn10 && isbnUtil.isValidFormat(isbn10)) {
    const norm = isbnUtil.normalize(isbn10);
    return norm.length === 10 ? isbnUtil.toIsbn13(norm) : norm;
  }
  return null;
}

export const googleBooksResolver = {
  async resolve(isbn: string): Promise<ExternalBookMetadata | null> {
    try {
      console.log(`[GOOGLE BOOKS RESOLVER] Recherche par ISBN : ${isbn}`);
      const gatewayUrl = `/api/gateway?action=google-books&isbn=${encodeURIComponent(isbn)}`;

      const res = await fetchWithTimeout(gatewayUrl);
      if (!res.ok) {
        console.warn(`[GOOGLE BOOKS RESOLVER] Erreur API Google Books (Status ${res.status})`);
        return null;
      }

      const data = await res.json();
      if (!data.items || data.items.length === 0) {
        console.log(`[GOOGLE BOOKS RESOLVER] Aucun résultat pour l'ISBN ${isbn}`);
        return null;
      }

      const volumeInfo = data.items[0].volumeInfo;
      if (!volumeInfo) return null;

      return extractVolumeMetadata(isbn, volumeInfo);
    } catch (e: any) {
      console.error(`[GOOGLE BOOKS RESOLVER] Erreur lors de la résolution de l'ISBN ${isbn}:`, e.message);
      return null;
    }
  },

  /**
   * Repli textuel par titre / série / auteur / éditeur pour retrouver un ISBN-13 officiel
   */
  async searchByHints(hints: BookSearchHints): Promise<ExternalBookMetadata | null> {
    try {
      const terms: string[] = [];
      const mainText = [hints.series, hints.title, hints.volumeNumber]
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!mainText) return null;

      terms.push(`intitle:${mainText}`);
      if (hints.author?.trim()) terms.push(`inauthor:${hints.author.trim()}`);
      if (hints.publisher?.trim()) terms.push(hints.publisher.trim());

      const q = terms.join(' ');
      const gatewayUrl = `/api/gateway?action=google-books&q=${encodeURIComponent(q)}`;
      const res = await fetchWithTimeout(gatewayUrl);
      if (!res.ok) return null;

      const data = await res.json();
      const items: any[] = data?.items || [];
      if (items.length === 0) return null;

      const scored: Array<{ score: number; meta: ExternalBookMetadata }> = [];
      for (const item of items) {
        const info = item?.volumeInfo;
        if (!info?.title) continue;
        const isbn13 = extractBestIsbnFromVolume(info);
        if (!isbn13) continue;

        let score = 0;
        if (info.language === 'fr') score += 20;
        if (isbn13.startsWith('9782') || isbn13.startsWith('97910')) score += 15;
        if (info.imageLinks) score += 8;

        const yearMatch = String(info.publishedDate || '').match(/\d{4}/);
        if (yearMatch) {
          const year = Math.min(Math.max(parseInt(yearMatch[0], 10), 1900), 2035);
          score += (year - 1900) * 0.2;
        }

        const candTitleLower = String(info.title).toLowerCase();
        if (hints.title && candTitleLower.includes(hints.title.toLowerCase())) score += 20;
        if (hints.series && candTitleLower.includes(hints.series.toLowerCase())) score += 15;
        if (hints.volumeNumber && new RegExp(`\\b0*${hints.volumeNumber.trim()}\\b`).test(candTitleLower)) {
          score += 20;
        }

        scored.push({ score, meta: extractVolumeMetadata(isbn13, info) });
      }

      if (scored.length === 0) return null;
      scored.sort((a, b) => b.score - a.score);
      return scored[0].meta;
    } catch (e: any) {
      console.warn('[GOOGLE BOOKS RESOLVER] Échec searchByHints:', e?.message || e);
      return null;
    }
  }
};
