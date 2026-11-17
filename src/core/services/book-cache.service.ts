// src/core/services/book-cache.service.ts
import { databaseService } from '../database/database.service';
import { imageService } from './image.service';
import { imageUtil } from '../utils/image.util';
import { isbnUtil } from '../utils/isbn.util';
import type { HumanizedBook } from '../types';

async function uploadCompressedCoverToCentralStorage(params: {
  isbn?: string;
  url?: string;
  dataUrl: string;
}): Promise<void> {
  if (typeof fetch !== 'function' || !params.dataUrl.startsWith('data:image/')) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const rawNorm = params.isbn ? isbnUtil.normalize(params.isbn) : '';
  const isbn13 = rawNorm.length === 10 ? isbnUtil.toIsbn13(rawNorm) : rawNorm;
  try {
    await fetch('/api/gateway?action=cover-store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isbn13: isbn13.length === 13 ? isbn13 : undefined,
        url: params.url && !params.url.startsWith('data:') ? params.url : undefined,
        dataUrl: params.dataUrl
      })
    });
  } catch {
    // Non bloquant : la copie locale IndexedDB reste active
  }
}

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

      // 4. Compression Asynchrone multi-candidats + sauvegarde centrale WebP (R2 / D1)
      if (book.localCover && book.localCover.startsWith('data:image/')) {
        void uploadCompressedCoverToCentralStorage({
          isbn: book.isbn13 || book.isbn10,
          url: book.coverUrl,
          dataUrl: book.localCover
        });
      } else if (!book.localCover) {
        setTimeout(async () => {
          try {
            let resolvedBase64: string | null = null;
            let resolvedUrl: string | undefined;
            let allCandidates = [...candidates];

            for (const candidateUrl of allCandidates) {
              const base64 = await imageService.compressAndEncode(candidateUrl);
              if (base64) {
                resolvedBase64 = base64;
                resolvedUrl = candidateUrl;
                break;
              }
            }

            // Repli orienté Œuvre : si aucune couverture n'a fonctionné sur cet ISBN,
            // interroger `/api/gateway?action=work-edition-covers` + `knownIsbns` (comme dans BookEdit).
            if (!resolvedBase64 && typeof fetch === 'function' && (book.title || book.workUri || book.isbn13)) {
              try {
                const extraUrls: string[] = [];
                for (const altIsbn of (book.knownIsbns || []).slice(0, 6)) {
                  extraUrls.push(...imageUtil.buildCoverCandidates(altIsbn, []));
                }
                const params = new URLSearchParams({
                  isbn: book.isbn13 || book.isbn10 || '',
                  workUri: book.workUri || '',
                  title: book.title || '',
                  author: book.authors?.[0] || ''
                });
                const res = await fetch(`/api/gateway?action=work-edition-covers&${params.toString()}`).catch(() => null);
                if (res && res.ok) {
                  const data = (await res.json()) as { coverUrls?: string[] };
                  if (Array.isArray(data?.coverUrls)) {
                    extraUrls.push(...data.coverUrls);
                  }
                }
                const dedupExtra = Array.from(new Set(extraUrls)).filter((u) => !allCandidates.includes(u));
                for (const candidateUrl of dedupExtra.slice(0, 10)) {
                  const base64 = await imageService.compressAndEncode(candidateUrl);
                  if (base64) {
                    resolvedBase64 = base64;
                    resolvedUrl = candidateUrl;
                    allCandidates = [candidateUrl, ...allCandidates, ...dedupExtra];
                    break;
                  }
                }
              } catch {
                // Ignorer si hors-ligne ou environnement de test sans réseau
              }
            }

            if (resolvedBase64 && resolvedUrl) {
              const updatedBook = await databaseService.getBookFromCache(book.uri);
              if (updatedBook) {
                updatedBook.localCover = resolvedBase64;
                updatedBook.coverUrl = resolvedUrl;
                updatedBook.coverFallbackUrls = Array.from(new Set(allCandidates));
                await databaseService.saveBookToCache(updatedBook);
              }
              await uploadCompressedCoverToCentralStorage({
                isbn: book.isbn13 || book.isbn10,
                url: resolvedUrl,
                dataUrl: resolvedBase64
              });
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