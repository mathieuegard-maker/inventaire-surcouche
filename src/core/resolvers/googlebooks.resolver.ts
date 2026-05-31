// src/core/resolvers/googlebooks.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';

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
      if (!volumeInfo) {
        return null;
      }

      // Extraction du titre
      const title = volumeInfo.title?.trim() || '';

      // Extraction des auteurs
      const authors: string[] = volumeInfo.authors || [];

      // Extraction de l'éditeur
      const publisher = volumeInfo.publisher?.trim() || undefined;

      // Extraction de la date (année uniquement)
      let publishDate: string | undefined = undefined;
      if (volumeInfo.publishedDate) {
        const match = String(volumeInfo.publishedDate).match(/\d{4}/);
        if (match) publishDate = match[0];
      }

      // Extraction du nombre de pages
      const pageCount = volumeInfo.pageCount ? parseInt(volumeInfo.pageCount, 10) : undefined;

      // Extraction de l'image de couverture
      let coverUrl: string | undefined = undefined;
      if (volumeInfo.imageLinks) {
        const links = volumeInfo.imageLinks;
        // Priorité aux images haute résolution de Google Books
        const rawCover = links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail;
        if (rawCover) {
          // Forcer le HTTPS si ce n'est pas le cas pour éviter le mixed content
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
    } catch (e: any) {
      console.error(`[GOOGLE BOOKS RESOLVER] Erreur lors de la résolution de l'ISBN ${isbn}:`, e.message);
      return null;
    }
  }
};
