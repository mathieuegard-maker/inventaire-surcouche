// src/core/orchestrators/search.orchestrator.ts
import { databaseService } from '../database/database.service';
import { wishlistService } from '../services/wishlist.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { entityHumanizer } from '../resolvers/humanizer';
import { seriesResolver } from '../resolvers/series.resolver';
import { imageService } from '../services/image.service';
import { syncOrchestrator } from './sync.orchestrator';
import { isbnUtil } from '../utils/isbn.util';
import type { SearchResponse, HumanizedBook } from '../types';

export const searchService = {
  /**
   * Orchestration complète d'une recherche par ISBN
   * Local-First -> Network Fallback -> Double Check -> Série -> Paquet UI
   */
  async searchByIsbn(rawIsbn: string): Promise<SearchResponse | null> {
    // Utilisation de l'utilitaire centralisé pour nettoyer l'entrée
    const isbn = isbnUtil.normalize(rawIsbn);

    // Sécurité supplémentaire grâce à l'utilitaire
    if (!isbnUtil.isValidFormat(isbn)) {
      console.warn(`[SEARCH] Format ISBN invalide : ${isbn}`);
      return null;
    }

    console.group(`[SEARCH SERVICE] Orchestration pour ISBN: ${isbn}`);
    
    // 1. PHASE IDENTIFICATION : Local-First
    let book = await databaseService.getBookByIsbn(isbn);
    let source: 'cache' | 'network' = 'cache';

    if (!book) {
      console.log("[SEARCH] Absent du cache, interrogation réseau...");
      const raw = await entityResolver.fromIsbn(isbn);
      
      if (!raw) {
        console.warn("[SEARCH] Livre introuvable.");
        console.groupEnd();
        return null;
      }
      
      // Humanisation (Traductions groupées ultra-rapides)
      book = await entityHumanizer.humanize(raw);
      
      console.log(`[DEBUG-SEARCH] Livre humanisé, prêt pour le cache. coverUrl:`, book.coverUrl);

      // Sauvegarde immédiate dans le cache (sans bloquer pour l'image locale)
      await databaseService.saveBookToCache(book);
      source = 'network';

      // ========================================================
      // OPTIMISATION "FIRE AND FORGET" : Compression en arrière-plan
      // ========================================================
      if (book.coverUrl) {
        console.log(`[SEARCH] Lancement de la tâche de fond pour l'image...`);
        // Note : Pas de 'await'. L'orchestrateur n'attend pas la fin pour continuer.
        imageService.compressAndEncode(book.coverUrl).then(async (base64) => {
          if (base64) {
            // Sécurité : On recharge le livre pour ne pas écraser d'éventuelles
            // modifications de statut ('owned') faites entre-temps par l'utilisateur.
            const currentBook = await databaseService.getBookFromCache(book!.uri);
            if (currentBook) {
              currentBook.localCover = base64;
              await databaseService.saveBookToCache(currentBook);
              console.log(`[BACKGROUND] Image WebP sauvegardée en silence pour ${book!.uri}`);
            }
          }
        }).catch(e => console.error(`[BACKGROUND] Erreur compression:`, e));
      }
    } else {
      console.log("[SEARCH] Trouvé en cache local.");
      // Vérification du TTL (Time To Live = 30 jours)
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      if (!book.updatedAt || (Date.now() - book.updatedAt > THIRTY_DAYS)) {
        console.log(`[SEARCH] Cache périmé (TTL > 30j) pour ${isbn}. Rafraîchissement fantôme...`);
        // Déclenchement de la mise à jour en tâche de fond (Fire and forget)
        syncOrchestrator.refreshBookInBackground(isbn).catch(e => console.error(e));
      }
    }

    // 2. PHASE ANALYSE DE POSSESSION (Double Check)
    const isEditionOwned = await databaseService.isUriInRegistry('inventory', book.uri);
    const isWished = await wishlistService.isUriWished(book.uri, book.workUri);
    
    let isWorkOwned = isEditionOwned;
    let duplicateEdition: HumanizedBook | undefined = undefined;

    if (!isEditionOwned && book.workUri) {
      const other = await databaseService.getOtherOwnedEdition(book.workUri, book.uri);
      if (other) {
        isWorkOwned = true;
        duplicateEdition = other;
      }
    }

    book.ownershipStatus = isWorkOwned ? 'owned' : (isWished ? 'wish' : 'none');

    // 3. PHASE ANALYSE DES PRÊTS
    const loanDetails = await databaseService.getLoan(book.uri);
    const isLent = !!loanDetails;

    // 4. PHASE EXPANSION : Contexte de Série
    let seriesContext = undefined;
    if (book.seriesId) {
      console.log(`[SEARCH] Dépliage de la série : ${book.seriesId}`);
      const tomes = await seriesResolver.getFullSeries(book.seriesId);
      const ownedCount = tomes.filter(t => t.ownershipStatus === 'owned').length;
      
      seriesContext = {
        id: book.seriesId,
        name: book.series,
        tomes: tomes,
        ownedCount: ownedCount,
        isComplete: tomes.length > 0 && ownedCount === tomes.length
      };
    }

    console.log(`[DEBUG-SEARCH] Objet final renvoyé. localCover présent ? :`, !!book.localCover);
    console.log("[SEARCH] Orchestration terminée avec succès.");
    console.groupEnd();

    // 6. RÉSULTAT : Le "Paquet" final prêt à l'emploi
    return {
      mainBook: book,
      ownership: {
        isEditionOwned,
        isWorkOwned,
        isWished,
        duplicateEdition
      },
      series: seriesContext,
      loan: {
        isLent: isLent,
        details: loanDetails
      },
      source
    };
  }
};