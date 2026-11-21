// src/core/resolvers/googlebooks.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';
import { isbnUtil } from '../utils/isbn.util';
import { cleanSeriesName, isFrancophoneBookIsbn13, normalizeSeriesNumber, parseSeriesFromTitle } from './bnf.resolver';

let googleBooksQuotaDisabledUntil = 0;

export interface BookSearchHints {
  title?: string;
  subtitle?: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  illustrator?: string;
  publisher?: string;
  collection?: string;
  rawSpineText?: string;
}

export function extractSeriesAndVolumeHints(
  rawTitle: string,
  rawSubtitle?: string
): { title: string; series?: string; seriesNumber?: string } {
  const cleanMain = rawTitle.trim();
  const cleanSub = rawSubtitle?.trim() || '';

  // Ex: "Les Aventures de Tintin - Tome 11 : Le Secret de La Licorne" ou "Astérix T.2 - La Serpe d'or"
  const frontVolMatch =
    /^(.+?)\s*(?:,|\s-\s|\s)*\b(?:tome|vol\.?|volume|t\.?|n°)\s*0*(\d+)\b(?:\s*[:\-–]\s*(.+))?$/i.exec(
      cleanMain
    );
  if (frontVolMatch) {
    const candidateSeries = cleanSeriesName(frontVolMatch[1]);
    const volNum = normalizeSeriesNumber(frontVolMatch[2]);
    const candidateAlbum = frontVolMatch[3]?.trim() || cleanSub;
    if (candidateSeries && volNum) {
      return {
        title: candidateAlbum || cleanMain,
        series: candidateSeries,
        seriesNumber: volNum
      };
    }
  }

  // Ex: Title = "Astérix le Gaulois", Subtitle = "Astérix - Tome 1"
  if (cleanSub) {
    const subMatch =
      /^(.+?)\s*(?:,|\s-\s|\s)*\b(?:tome|vol\.?|volume|t\.?|n°)\s*0*(\d+)\b/i.exec(cleanSub);
    if (subMatch) {
      const candidateSeries = cleanSeriesName(subMatch[1]);
      const volNum = normalizeSeriesNumber(subMatch[2]);
      if (candidateSeries && volNum) {
        return { title: cleanMain, series: candidateSeries, seriesNumber: volNum };
      }
    }
  }

  const parsed = parseSeriesFromTitle(cleanMain);
  return {
    title: parsed.title || cleanMain,
    series: parsed.series ? cleanSeriesName(parsed.series) : undefined,
    seriesNumber: parsed.seriesNumber ? normalizeSeriesNumber(parsed.seriesNumber) : undefined
  };
}

function extractVolumeMetadata(isbn: string, volumeInfo: any): ExternalBookMetadata {
  const rawTitle = volumeInfo.title?.trim() || '';
  const rawSubtitle = volumeInfo.subtitle?.trim() || '';
  const parsedSeries = extractSeriesAndVolumeHints(rawTitle, rawSubtitle);
  const title = parsedSeries.title || rawTitle;
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

  const rawSubjects = Array.isArray(volumeInfo.categories)
    ? volumeInfo.categories.map((c: unknown) => String(c).trim()).filter(Boolean)
    : [];

  return {
    isbn,
    title,
    authors,
    publisher,
    publishDate,
    pageCount,
    coverUrl,
    ...(parsedSeries.series ? { series: parsedSeries.series } : {}),
    ...(parsedSeries.seriesNumber ? { seriesNumber: parsedSeries.seriesNumber } : {}),
    ...(rawSubjects.length ? { rawSubjects } : {})
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
      if (Date.now() < googleBooksQuotaDisabledUntil) return null;
      console.log(`[GOOGLE BOOKS RESOLVER] Recherche par ISBN : ${isbn}`);
      const gatewayUrl = `/api/gateway?action=google-books&isbn=${encodeURIComponent(isbn)}`;

      const res = await fetchWithTimeout(gatewayUrl);
      if (res.status === 429) {
        googleBooksQuotaDisabledUntil = Date.now() + 10 * 60 * 1000;
        return null;
      }
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
   * Recherche plusieurs candidats Google Books par indices visuels (avec et sans contrainte d'auteur).
   */
  async searchCandidatesByHints(hints: BookSearchHints, maxCandidates = 10): Promise<ExternalBookMetadata[]> {
    try {
      if (Date.now() < googleBooksQuotaDisabledUntil) return [];
      const mainText = [hints.series, hints.title, hints.subtitle, hints.volumeNumber]
        .filter(Boolean)
        .join(' ')
        .trim() || hints.rawSpineText?.trim() || '';
      if (!mainText) return [];

      const queries: string[] = [];
      const authorTerm = (hints.author || hints.illustrator || '').trim();
      if (authorTerm) {
        const specific = [`intitle:${mainText}`, `inauthor:${authorTerm}`, hints.publisher?.trim()]
          .filter(Boolean)
          .join(' ');
        queries.push(specific);
      }
      // Passe sans auteur au cas où l'IA aurait mal lu le nom d'auteur sur la tranche
      queries.push([`intitle:${mainText}`, hints.publisher?.trim()].filter(Boolean).join(' '));
      if (hints.rawSpineText?.trim() && hints.rawSpineText.trim() !== mainText) {
        queries.push(hints.rawSpineText.trim());
      }

      const byIsbn = new Map<string, { score: number; meta: ExternalBookMetadata }>();
      const seenQueries = new Set<string>();

      for (const q of queries) {
        if (!q || seenQueries.has(q)) continue;
        seenQueries.add(q);

        const res = await fetchWithTimeout(
          `/api/gateway?action=google-books&q=${encodeURIComponent(q)}&maxResults=${Math.min(Math.max(maxCandidates, 20), 40)}`
        );
        if (res.status === 429) {
          googleBooksQuotaDisabledUntil = Date.now() + 10 * 60 * 1000;
          break;
        }
        if (!res.ok) continue;

        const data = await res.json();
        const items: any[] = data?.items || [];
        for (const item of items) {
          const info = item?.volumeInfo;
          if (!info?.title) continue;
          const isbn13 = extractBestIsbnFromVolume(info);
          if (!isbn13) continue;
          if (info.language && info.language !== 'fr' && !isFrancophoneBookIsbn13(isbn13)) continue;

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
          if (hints.volumeNumber) {
            const escapedVol = hints.volumeNumber.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (escapedVol && new RegExp(`\\b0*${escapedVol}\\b`, 'i').test(candTitleLower)) {
              score += 20;
            }
          }

          const existing = byIsbn.get(isbn13);
          if (!existing || score > existing.score) {
            byIsbn.set(isbn13, { score, meta: extractVolumeMetadata(isbn13, info) });
          }
        }

        if (byIsbn.size >= Math.max(4, Math.min(maxCandidates, 40))) break;
      }

      return Array.from(byIsbn.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxCandidates)
        .map((x) => x.meta);
    } catch (e: any) {
      console.warn('[GOOGLE BOOKS RESOLVER] Échec searchCandidatesByHints:', e?.message || e);
      return [];
    }
  },

  /**
   * Recherche large multi-requêtes (mot-clé / série / auteur) avec pagination Google Books pour récupérer tous les tomes d'une série.
   */
  async searchKeywordOrSeriesVolumes(query: string, authorHint?: string, maxTotal = 60): Promise<ExternalBookMetadata[]> {
    const cleanQ = query.trim();
    if (!cleanQ) return [];
    const byIsbn = new Map<string, { score: number; meta: ExternalBookMetadata }>();

    const fetchPage = async (q: string, startIndex: number) => {
      const res = await fetchWithTimeout(
        `/api/gateway?action=google-books&q=${encodeURIComponent(q)}&maxResults=40&startIndex=${startIndex}`
      ).catch(() => null);
      if (!res || !res.ok) return [] as any[];
      const data = await res.json();
      return Array.isArray(data?.items) ? data.items : [];
    };

    try {
      const queries = authorHint?.trim()
        ? [`"${cleanQ}" inauthor:${authorHint.trim()}`, cleanQ]
        : [cleanQ];

      const pages = await Promise.all([
        fetchPage(queries[0], 0),
        fetchPage(queries[0], 40),
        ...(queries[1] ? [fetchPage(queries[1], 0)] : [])
      ]);

      for (const item of pages.flat()) {
        const info = item?.volumeInfo;
        if (!info?.title) continue;
        if (info.language && info.language !== 'fr') continue;
        const isbn13 = extractBestIsbnFromVolume(info);
        if (!isbn13) continue;

        let score = 0;
        if (info.language === 'fr') score += 20;
        if (isbn13.startsWith('9782') || isbn13.startsWith('97910')) score += 15;
        if (info.imageLinks) score += 8;

        const existing = byIsbn.get(isbn13);
        if (!existing || score > existing.score) {
          byIsbn.set(isbn13, { score, meta: extractVolumeMetadata(isbn13, info) });
        }
      }

      return Array.from(byIsbn.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxTotal)
        .map((x) => x.meta);
    } catch (e: any) {
      console.warn('[GOOGLE BOOKS RESOLVER] Échec searchKeywordOrSeriesVolumes:', e?.message || e);
      return [];
    }
  },

  /**
   * Repli textuel par titre / série / auteur / éditeur pour retrouver un ISBN-13 officiel
   */
  async searchByHints(hints: BookSearchHints): Promise<ExternalBookMetadata | null> {
    const candidates = await this.searchCandidatesByHints(hints, 3);
    return candidates[0] || null;
  }
};
