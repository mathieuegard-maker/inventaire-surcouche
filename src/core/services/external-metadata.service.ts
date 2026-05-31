// src/core/services/external-metadata.service.ts
import { bnfResolver } from '../resolvers/bnf.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';
import type { ExternalBookMetadata } from '../types';

function isMetadataComplete(meta: ExternalBookMetadata): boolean {
  return !!(
    meta.title?.trim() &&
    meta.authors && meta.authors.length > 0 &&
    meta.publisher?.trim() &&
    meta.publishDate?.trim() &&
    meta.pageCount &&
    meta.coverUrl?.trim() &&
    meta.series?.trim()
  );
}

export const externalMetadataService = {
  /**
   * Récupère et fusionne en cascade séquentielle les métadonnées de la BNF, 
   * d'Open Library et de Google Books. S'arrête dès que les métadonnées sont complètes.
   */
  async fetchFromExternalSources(isbn: string): Promise<ExternalBookMetadata | null> {
    if (!isbn) return null;
    
    console.log(`[EXTERNAL METADATA SERVICE] Lancement de la récupération en cascade pour l'ISBN : ${isbn}`);

    let metadata: ExternalBookMetadata = {
      isbn,
      title: '',
      authors: [],
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
          authors: (bnfData.authors && bnfData.authors.length > 0) ? bnfData.authors : metadata.authors,
          publisher: bnfData.publisher || metadata.publisher,
          publishDate: bnfData.publishDate || metadata.publishDate,
          pageCount: bnfData.pageCount || metadata.pageCount,
          coverUrl: bnfData.coverUrl || metadata.coverUrl,
          series: bnfData.series || metadata.series,
          seriesNumber: bnfData.seriesNumber || metadata.seriesNumber,
        };

        if (isMetadataComplete(metadata)) {
          console.log(`[EXTERNAL METADATA SERVICE] 🎉 Arrêt précoce : Notice BNF complète pour l'ISBN ${isbn}`);
          return metadata;
        }
      }
    } catch (err) {
      console.warn("[EXTERNAL METADATA SERVICE] Erreur résolveur BNF :", err);
    }

    // --- ÉTAPE 2 : OPEN LIBRARY (Priorité 2) ---
    try {
      console.log(`[EXTERNAL METADATA SERVICE] Métadonnées partielles après BNF. Interrogation d'Open Library...`);
      const olData = await openLibraryResolver.resolve(isbn);
      if (olData) {
        hasFoundAny = true;
        metadata = {
          isbn,
          title: metadata.title || olData.title || '',
          authors: (metadata.authors && metadata.authors.length > 0) ? metadata.authors : (olData.authors || []),
          publisher: metadata.publisher || olData.publisher,
          publishDate: metadata.publishDate || olData.publishDate,
          pageCount: metadata.pageCount || olData.pageCount,
          coverUrl: metadata.coverUrl || olData.coverUrl,
          series: metadata.series || olData.series,
          seriesNumber: metadata.seriesNumber || olData.seriesNumber,
        };

        if (isMetadataComplete(metadata)) {
          console.log(`[EXTERNAL METADATA SERVICE] 🎉 Arrêt précoce : Notice complétée par Open Library pour l'ISBN ${isbn}`);
          return metadata;
        }
      }
    } catch (err) {
      console.warn("[EXTERNAL METADATA SERVICE] Erreur résolveur Open Library :", err);
    }

    // --- ÉTAPE 3 : GOOGLE BOOKS (Priorité 3) ---
    try {
      console.log(`[EXTERNAL METADATA SERVICE] Métadonnées partielles après Open Library. Interrogation de Google Books...`);
      const gbData = await googleBooksResolver.resolve(isbn);
      if (gbData) {
        hasFoundAny = true;
        metadata = {
          isbn,
          title: metadata.title || gbData.title || '',
          authors: (metadata.authors && metadata.authors.length > 0) ? metadata.authors : (gbData.authors || []),
          publisher: metadata.publisher || gbData.publisher,
          publishDate: metadata.publishDate || gbData.publishDate,
          pageCount: metadata.pageCount || gbData.pageCount,
          coverUrl: metadata.coverUrl || gbData.coverUrl,
          series: metadata.series || gbData.series,
          seriesNumber: metadata.seriesNumber || gbData.seriesNumber,
        };
      }
    } catch (err) {
      console.warn("[EXTERNAL METADATA SERVICE] Erreur résolveur Google Books :", err);
    }

    if (!hasFoundAny) {
      console.log(`[EXTERNAL METADATA SERVICE] Aucun résultat trouvé sur aucune source pour l'ISBN : ${isbn}`);
      return null;
    }

    console.log(`[EXTERNAL METADATA SERVICE] ✅ Données agrégées finales pour l'ISBN ${isbn}`);
    return metadata;
  }
};
