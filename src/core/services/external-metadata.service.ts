// src/core/services/external-metadata.service.ts
import { bnfResolver } from '../resolvers/bnf.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';
import { classifyBookMetadata, buildCombinedGenres } from '../utils/category-classifier.util';
import { imageUtil } from '../utils/image.util';
import type { ExternalBookMetadata } from '../types';

function isMetadataComplete(meta: ExternalBookMetadata): boolean {
  return !!(
    meta.title?.trim() &&
    meta.authors && meta.authors.length > 0 &&
    meta.publisher?.trim() &&
    meta.publishDate?.trim() &&
    meta.pageCount &&
    meta.coverUrl?.trim() &&
    meta.series?.trim() &&
    meta.rawSubjects && meta.rawSubjects.length > 0
  );
}

function mergeSubjects(existing?: string[], incoming?: string[]): string[] | undefined {
  const combined = [...(existing || []), ...(incoming || [])]
    .map((s) => s.trim())
    .filter(Boolean);
  if (combined.length === 0) return undefined;
  const seen = new Set<string>();
  return combined.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finalizeMetadataGenres(
  metadata: ExternalBookMetadata,
  extraCoverCandidates: Array<string | undefined> = []
): ExternalBookMetadata {
  const classification = classifyBookMetadata({
    title: metadata.title,
    series: metadata.series,
    publisher: metadata.publisher,
    collection: metadata.collection,
    deweyCode: metadata.deweyCode,
    rawSubjects: metadata.rawSubjects
  });
  const genres = buildCombinedGenres(classification);
  const coverFallbackUrls = imageUtil.buildCoverCandidates(metadata.isbn, [
    metadata.coverUrl,
    ...extraCoverCandidates
  ]);
  return {
    ...metadata,
    ...(coverFallbackUrls.length ? { coverFallbackUrls } : {}),
    ...(genres.length ? { genres } : {})
  };
}

export const externalMetadataService = {
  /**
   * Récupère et fusionne les métadonnées de la BNF, d'Open Library et de Google Books,
   * puis croise leurs sujets/indices pour calculer des genres multiples fiables.
   */
  async fetchFromExternalSources(isbn: string): Promise<ExternalBookMetadata | null> {
    if (!isbn) return null;

    console.log(`[EXTERNAL METADATA SERVICE] Lancement de la récupération en cascade pour l'ISBN : ${isbn}`);

    let metadata: ExternalBookMetadata = {
      isbn,
      title: '',
      authors: []
    };

    let hasFoundAny = false;

    // --- ÉTAPE 1 : BNF (Priorité 1) ---
    try {
      const bnfData = await bnfResolver.resolve(isbn);
      if (bnfData) {
        hasFoundAny = true;
        metadata = {
          ...metadata,
          title: bnfData.title || metadata.title,
          authors: bnfData.authors && bnfData.authors.length > 0 ? bnfData.authors : metadata.authors,
          publisher: bnfData.publisher || metadata.publisher,
          publishDate: bnfData.publishDate || metadata.publishDate,
          pageCount: bnfData.pageCount || metadata.pageCount,
          coverUrl: bnfData.coverUrl || metadata.coverUrl,
          series: bnfData.series || metadata.series,
          seriesNumber: bnfData.seriesNumber || metadata.seriesNumber,
          collection: bnfData.collection || metadata.collection,
          deweyCode: bnfData.deweyCode || metadata.deweyCode,
          rawSubjects: mergeSubjects(metadata.rawSubjects, bnfData.rawSubjects)
        };

        if (isMetadataComplete(metadata)) {
          console.log(`[EXTERNAL METADATA SERVICE] 🎉 Notice BNF complète pour l'ISBN ${isbn}`);
          return finalizeMetadataGenres(metadata);
        }
      }
    } catch (err) {
      console.warn('[EXTERNAL METADATA SERVICE] Erreur résolveur BNF :', err);
    }

    // --- ÉTAPES 2 & 3 : OPEN LIBRARY + GOOGLE BOOKS (croisement complémentaire & sujets) ---
    const [olRes, gbRes] = await Promise.allSettled([
      openLibraryResolver.resolve(isbn),
      googleBooksResolver.resolve(isbn)
    ]);

    const extraCovers: Array<string | undefined> = [];
    const olData = olRes.status === 'fulfilled' ? olRes.value : null;
    if (olData) {
      hasFoundAny = true;
      if (olData.coverUrl) extraCovers.push(olData.coverUrl);
      metadata = {
        ...metadata,
        isbn,
        title: metadata.title || olData.title || '',
        authors: metadata.authors.length > 0 ? metadata.authors : (olData.authors || []),
        publisher: metadata.publisher || olData.publisher,
        publishDate: metadata.publishDate || olData.publishDate,
        pageCount: metadata.pageCount || olData.pageCount,
        coverUrl: metadata.coverUrl || olData.coverUrl,
        series: metadata.series || olData.series,
        seriesNumber: metadata.seriesNumber || olData.seriesNumber,
        rawSubjects: mergeSubjects(metadata.rawSubjects, olData.rawSubjects)
      };
    }

    const gbData = gbRes.status === 'fulfilled' ? gbRes.value : null;
    if (gbData) {
      hasFoundAny = true;
      if (gbData.coverUrl) extraCovers.push(gbData.coverUrl);
      metadata = {
        ...metadata,
        isbn,
        title: metadata.title || gbData.title || '',
        authors: metadata.authors.length > 0 ? metadata.authors : (gbData.authors || []),
        publisher: metadata.publisher || gbData.publisher,
        publishDate: metadata.publishDate || gbData.publishDate,
        pageCount: metadata.pageCount || gbData.pageCount,
        coverUrl: metadata.coverUrl || gbData.coverUrl,
        series: metadata.series || gbData.series,
        seriesNumber: metadata.seriesNumber || gbData.seriesNumber,
        rawSubjects: mergeSubjects(metadata.rawSubjects, gbData.rawSubjects)
      };
    }

    if (!hasFoundAny) {
      console.log(`[EXTERNAL METADATA SERVICE] Aucun résultat trouvé sur aucune source pour l'ISBN : ${isbn}`);
      return null;
    }

    console.log(`[EXTERNAL METADATA SERVICE] ✅ Données agrégées finales pour l'ISBN ${isbn}`);
    return finalizeMetadataGenres(metadata, extraCovers);
  }
};
