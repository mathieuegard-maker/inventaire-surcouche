// src/core/services/book-cache.service.ts
import { databaseService } from '../database/database.service';
import { imageService } from './image.service';
import type { HumanizedBook } from '../types';

export const bookCacheService = {
  /**
   * Gère la sauvegarde d'un livre en base locale avec préservation des données 
   * et déclenchement du worker de compression d'image.
   */
  async saveAndProcessImage(book: HumanizedBook, targetStatus?: 'owned' | 'wish' | 'none'): Promise<void> {
    try {
      // 1. Fusion pour préserver l'image Base64 si elle existe déjà
      const existingBook = await databaseService.getBookFromCache(book.uri);
      
      if (existingBook && existingBook.localCover) {
        book.localCover = existingBook.localCover;
      }

      // 2. Mise à jour de l'état de possession si demandé
      if (targetStatus) {
        book.ownershipStatus = targetStatus;
      }

      // 3. Sauvegarde principale
      await databaseService.saveBookToCache(book);

      // 4. Compression Asynchrone (Non-bloquant / Fire and Forget)
      if (book.coverUrl && !book.localCover) {
        setTimeout(async () => {
          try {
            const base64 = await imageService.compressAndEncode(book.coverUrl!);
            if (base64) {
              const updatedBook = await databaseService.getBookFromCache(book.uri);
              if (updatedBook) {
                updatedBook.localCover = base64;
                await databaseService.saveBookToCache(updatedBook);
              }
            }
          } catch (e) {
            console.error(`[BOOK CACHE] Erreur compression image pour ${book.uri}`, e);
          }
        }, 0);
      }
    } catch (error) {
      console.error(`[BOOK CACHE] Erreur lors de la sauvegarde de ${book.uri}`, error);
    }
  }
};