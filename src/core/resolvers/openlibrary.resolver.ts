// src/core/resolvers/openlibrary.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';

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
  }
};
