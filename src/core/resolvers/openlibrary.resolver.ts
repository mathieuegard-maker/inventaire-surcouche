// src/core/resolvers/openlibrary.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';
import { isbnUtil } from '../utils/isbn.util';
import type { BookSearchHints } from './googlebooks.resolver';

function pickBestIsbnFromList(rawList?: unknown[]): string | null {
  if (!Array.isArray(rawList)) return null;
  const valid13: string[] = [];
  const valid10: string[] = [];

  for (const raw of rawList) {
    if (typeof raw !== 'string') continue;
    if (!isbnUtil.isValidFormat(raw)) continue;
    const norm = isbnUtil.normalize(raw);
    if (norm.length === 13) valid13.push(norm);
    else if (norm.length === 10) valid10.push(isbnUtil.toIsbn13(norm));
  }

  const all = [...valid13, ...valid10];
  const french = all.find((code) => code.startsWith('9782') || code.startsWith('97910'));
  return french || all[0] || null;
}

export const openLibraryResolver = {
  async resolve(isbn: string): Promise<ExternalBookMetadata | null> {
    try {
      console.log(`[OPEN LIBRARY RESOLVER] Recherche par ISBN : ${isbn}`);
      const gatewayUrl = `/api/gateway?action=external-lookup&isbn=${encodeURIComponent(isbn)}&source=openlibrary`;
      
      const res = await fetchWithTimeout(gatewayUrl);
      if (!res.ok) {
        console.warn(`[OPEN LIBRARY RESOLVER] Erreur API Open Library (Status ${res.status})`);
        return null;
      }
      
      const data = await res.json();
      const bibKey = `ISBN:${isbn}`;
      const bookData = data[bibKey];
      
      if (!bookData) {
        console.log(`[OPEN LIBRARY RESOLVER] Aucun résultat pour l'ISBN ${isbn}`);
        return null;
      }

      // Extraction des auteurs
      const authors: string[] = [];
      if (bookData.authors && Array.isArray(bookData.authors)) {
        bookData.authors.forEach((a: any) => {
          if (a.name) authors.push(a.name.trim());
        });
      }

      // Extraction de l'éditeur
      let publisher: string | undefined = undefined;
      if (bookData.publishers && Array.isArray(bookData.publishers) && bookData.publishers.length > 0) {
        publisher = bookData.publishers[0].name?.trim();
      }

      // Extraction de la date de publication (année sur 4 chiffres)
      let publishDate: string | undefined = undefined;
      if (bookData.publish_date) {
        const match = String(bookData.publish_date).match(/\d{4}/);
        if (match) publishDate = match[0];
      }

      // Extraction de la couverture
      let coverUrl: string | undefined = undefined;
      if (bookData.cover) {
        coverUrl = bookData.cover.large || bookData.cover.medium || bookData.cover.small;
      }

      return {
        isbn,
        title: bookData.title?.trim() || '',
        authors,
        publisher,
        publishDate,
        pageCount: bookData.number_of_pages ? parseInt(bookData.number_of_pages, 10) : undefined,
        coverUrl
      };
    } catch (e: any) {
      console.error(`[OPEN LIBRARY RESOLVER] Erreur lors de la résolution de l'ISBN ${isbn}:`, e.message);
      return null;
    }
  },

  /**
   * Recherche textuelle croisée sur Open Library (utilisée pour confirmer un livre à partir d'une tranche)
   */
  async searchCandidatesByHints(hints: BookSearchHints, maxCandidates = 8): Promise<ExternalBookMetadata[]> {
    try {
      const mainTerms = [hints.series, hints.title, hints.subtitle, hints.volumeNumber]
        .filter(Boolean)
        .join(' ')
        .trim();
      const authorTerm = (hints.author || hints.illustrator || '').trim();
      const queries: string[] = [];

      if (mainTerms && authorTerm) queries.push(`${mainTerms} ${authorTerm}`);
      if (mainTerms) queries.push(mainTerms);
      if (hints.rawSpineText?.trim() && hints.rawSpineText.trim() !== mainTerms) {
        queries.push(hints.rawSpineText.trim());
      }

      const byIsbn = new Map<string, ExternalBookMetadata>();
      const seenQueries = new Set<string>();

      for (const q of queries) {
        if (!q || seenQueries.has(q)) continue;
        seenQueries.add(q);

        const res = await fetchWithTimeout(
          `/api/gateway?action=external-lookup&source=openlibrary&q=${encodeURIComponent(q)}`
        );
        if (!res.ok) continue;

        const data = await res.json();
        const docs: any[] = data?.docs || [];
        for (const doc of docs) {
          if (!doc?.title) continue;
          if (Array.isArray(doc.language) && doc.language.length > 0 && !doc.language.includes('fre')) {
            continue;
          }
          const isbn13 = pickBestIsbnFromList(doc.isbn);
          if (!isbn13 || byIsbn.has(isbn13)) continue;

          const coverUrl = doc.cover_i
            ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
            : undefined;

          byIsbn.set(isbn13, {
            isbn: isbn13,
            title: String(doc.title).trim(),
            authors: Array.isArray(doc.author_name) ? doc.author_name.map((a: any) => String(a).trim()).filter(Boolean) : [],
            publisher: Array.isArray(doc.publisher) && doc.publisher[0] ? String(doc.publisher[0]).trim() : undefined,
            publishDate: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
            coverUrl
          });
        }

        if (byIsbn.size >= maxCandidates) break;
      }

      return Array.from(byIsbn.values()).slice(0, maxCandidates);
    } catch (e: any) {
      console.warn('[OPEN LIBRARY RESOLVER] Échec searchCandidatesByHints:', e?.message || e);
      return [];
    }
  }
};
