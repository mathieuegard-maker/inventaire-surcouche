// src/core/orchestrators/search.orchestrator.ts
import { databaseService } from '../database/database.service';
import { wishlistService } from '../services/wishlist.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { seriesResolver } from '../resolvers/series.resolver';
import { workUriResolver } from '../resolvers/workUri.resolver';
import { bookCacheService } from '../services/book-cache.service';
import { isbnUtil } from '../utils/isbn.util';
import { syncOrchestrator } from './sync.orchestrator';
import type { SearchResponse, HumanizedBook } from '../types';

export const searchService = {
  /**
   * Orchestration complète d'une recherche par ISBN
   * Local-First -> Network Fallback -> Double Check -> Série -> Paquet UI
   */
  async searchByIsbn(rawIsbn: string): Promise<SearchResponse | null> {
    const isbn = isbnUtil.normalize(rawIsbn);

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
      book = await entityResolver.resolvePhysicalEntity(`isbn:${isbn}`);
      
      if (!book) {
        console.error(`[SEARCH] Échec de la résolution réseau pour : ${isbn}`);
        console.groupEnd();
        return null;
      }
      
      source = 'network';
      await bookCacheService.saveAndProcessImage(book);
    } else {
      console.log("[SEARCH] Trouvé en cache local.");
    }

    // 2. PHASE ANALYSE D'APPARTENANCE
    const isEditionOwned = await databaseService.isUriInRegistry('inventory', book.uri);
    let isWorkOwned = isEditionOwned;
    const isWished = await wishlistService.isUriWished(book.uri, book.workUri);
    let duplicateEdition = undefined;

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
      
      // CORRECTION DU TYPAGE : Forcer l'utilisation de l'interface HumanizedBook
      let tomes: HumanizedBook[] = await databaseService.getBooksBySeriesId(book.seriesId);
      
      // Lancement de l'aspiration en tâche de fond pour ne pas bloquer l'UI
      syncOrchestrator.hydrateSeriesInBackground(book.seriesId);
      
      tomes.sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
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
        isLent,
        details: loanDetails || undefined
      },
      source
    };
  }
};