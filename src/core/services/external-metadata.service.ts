// src/core/services/external-metadata.service.ts
import { bnfResolver } from '../resolvers/bnf.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';
import type { ExternalBookMetadata } from '../types';

export const externalMetadataService = {
  /**
   * Récupère et fusionne en parallèle les métadonnées de la BNF et d'Open Library.
   */
  async fetchFromExternalSources(isbn: string): Promise<ExternalBookMetadata | null> {
    if (!isbn) return null;
    
    console.log(`[EXTERNAL METADATA SERVICE] Lancement de la récupération pour l'ISBN : ${isbn}`);

    try {
      // Lancement en parallèle pour maximiser les performances
      const [bnfData, olData] = await Promise.all([
        bnfResolver.resolve(isbn).catch((err) => {
          console.warn("[EXTERNAL METADATA SERVICE] Erreur résolveur BNF :", err);
          return null;
        }),
        openLibraryResolver.resolve(isbn).catch((err) => {
          console.warn("[EXTERNAL METADATA SERVICE] Erreur résolveur Open Library :", err);
          return null;
        })
      ]);

      // Si aucune des deux sources n'a renvoyé de notice, on abandonne
      if (!bnfData && !olData) {
        console.log(`[EXTERNAL METADATA SERVICE] Aucun résultat trouvé sur la BNF et Open Library pour l'ISBN : ${isbn}`);
        return null;
      }

      // Fusion sémantique intelligente :
      // 1. Priorité textuelle à la BNF (idéal pour les éditions francophones, romans et BDs)
      const title = bnfData?.title || olData?.title || '';
      const authors = (bnfData?.authors && bnfData.authors.length > 0) ? bnfData.authors : (olData?.authors || []);
      const publisher = bnfData?.publisher || olData?.publisher;
      const publishDate = bnfData?.publishDate || olData?.publishDate;
      const pageCount = bnfData?.pageCount || olData?.pageCount;

      // 2. Priorité de l'image de couverture à Open Library (la BNF n'en fournit pas)
      const coverUrl = olData?.coverUrl || bnfData?.coverUrl;

      console.log(`[EXTERNAL METADATA SERVICE] ✅ Données agrégées avec succès pour l'ISBN ${isbn}`);

      return {
        isbn,
        title,
        authors,
        publisher,
        publishDate,
        pageCount,
        coverUrl
      };
    } catch (e: any) {
      console.error(`[EXTERNAL METADATA SERVICE] Erreur d'agrégation globale pour l'ISBN ${isbn}:`, e.message);
      return null;
    }
  }
};
