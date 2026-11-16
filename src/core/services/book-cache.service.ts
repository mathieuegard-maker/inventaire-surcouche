// src/core/services/book-cache.service.ts
import { databaseService } from '../database/database.service';
import { imageService } from './image.service';
import { imageUtil } from '../utils/image.util';
import type { HumanizedBook } from '../types';

export const bookCacheService = {
  /**
   * Gère la sauvegarde d'un livre en base locale avec préservation des données 
   * et déclenchement du worker de compression d'image.
   */
  async saveAndProcessImage(
    book: HumanizedBook,
    targetStatus?: 'owned' | 'wish' | 'none',
    options?: { forceOverwrite?: boolean }
  ): Promise<void> {
    try {
      // 1. Fusion pour préserver l'image Base64 si elle existe déjà
      const existingBook = await databaseService.getBookFromCache(book.uri);
      
      if (existingBook && existingBook.isLocallyEdited && !options?.forceOverwrite) {
        console.log(`[BOOK CACHE] Préservation des modifications locales pour ${book.uri}. Pas d'écrasement.`);
        if (targetStatus && existingBook.ownershipStatus !== targetStatus) {
          existingBook.ownershipStatus = targetStatus;
          await databaseService.saveBookToCache(existingBook);
        }
        return;
      }

      const coverChanged = existingBook && existingBook.coverUrl !== book.coverUrl;
      if (existingBook && existingBook.localCover && !coverChanged) {
        book.localCover = existingBook.localCover;
      } else if (coverChanged) {
        book.localCover = undefined;
      }

      // 2. Mise à jour de l'état de possession si demandé
      if (targetStatus) {
        book.ownershipStatus = targetStatus;
      }

      // 3. Sauvegarde principale avec repli CDN ISBN pré-calculé
      const candidates = imageUtil.buildCoverCandidates(book.isbn13 || book.isbn10, [
        book.coverUrl,
        ...(book.coverFallbackUrls || [])
      ]);
      if (candidates.length > 0) {
        book.coverFallbackUrls = candidates;
        if (!book.coverUrl) {
          book.coverUrl = candidates[0];
        }
      }
      await databaseService.saveBookToCache(book);

      // 4. Compression Asynchrone multi-candidats (Non-bloquant / Fire and Forget)
      if (candidates.length > 0 && !book.localCover) {
        setTimeout(async () => {
          try {
            for (const candidateUrl of candidates) {
              const base64 = await imageService.compressAndEncode(candidateUrl);
              if (base64) {
                const updatedBook = await databaseService.getBookFromCache(book.uri);
                if (updatedBook) {
                  updatedBook.localCover = base64;
                  updatedBook.coverUrl = candidateUrl;
                  updatedBook.coverFallbackUrls = candidates;
                  await databaseService.saveBookToCache(updatedBook);
                }
                break;
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