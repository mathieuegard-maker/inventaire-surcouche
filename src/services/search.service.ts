// src/services/search.service.ts
import { databaseService } from './database.service';
import { inventoryService } from './inventory.service';
import { wishlistService } from './wishlist.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { entityHumanizer } from '../resolvers/humanizer';
import { seriesResolver } from '../resolvers/series.resolver';
import type { SearchResponse, HumanizedBook } from '../resolvers/types';

export const searchService = {
  /**
   * Orchestration complète d'une recherche par ISBN
   * Local-First -> Network Fallback -> Double Check -> Série -> Paquet UI
   */
  async searchByIsbn(isbn: string): Promise<SearchResponse | null> {
    console.group(`[SEARCH SERVICE] Orchestration pour ISBN: ${isbn}`);
    
    // 1. PHASE IDENTIFICATION : Local-First
    let book = await databaseService.getBookByIsbn(isbn);
    let source: 'cache' | 'network' = 'cache';

    if (!book) {
      console.log("[SEARCH] Absent du cache, interrogation réseau...");
      // Appel au résolveur intelligent (qui rebondit sur l'œuvre)
      const raw = await entityResolver.fromIsbn(isbn);
      
      if (!raw) {
        console.warn("[SEARCH] Livre introuvable.");
        console.groupEnd();
        return null;
      }
      
      // Humanisation (Traductions + Compression d'image)
      book = await entityHumanizer.humanize(raw);
      
      // Sauvegarde immédiate dans le cache books
      await databaseService.saveBookToCache(book);
      source = 'network';
    } else {
      console.log("[SEARCH] Trouvé en cache local.");
    }

    // 2. PHASE ANALYSE DE POSSESSION (Double Check)
    const isEditionOwned = await inventoryService.isUriOwned(book.uri);
    const isWished = await wishlistService.isUriWished(book.uri);
    
    // Mise à jour du statut temps réel (car les registres changent plus vite que le cache)
    book.ownershipStatus = isEditionOwned ? 'owned' : (isWished ? 'wish' : 'none');

    let isWorkOwned = isEditionOwned;
    let duplicateEdition: HumanizedBook | undefined = undefined;

    // Si on n'a pas cet exemplaire précis, on cherche si on a une autre édition de la même œuvre
    if (!isEditionOwned && book.workUri) {
      const other = await databaseService.getOtherOwnedEdition(book.workUri, book.uri);
      if (other) {
        isWorkOwned = true;
        duplicateEdition = other;
      }
    }

    // 3. PHASE EXPANSION : Contexte de Série
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

    // 4. PHASE UI : Calcul des indicateurs pour le Frontend
    const ui = {
      showAddButton: !isEditionOwned,
      showWishButton: !isEditionOwned && !isWished,
      alertDuplicate: !isEditionOwned && isWorkOwned,
      hasBulkActions: !!seriesContext && seriesContext.tomes.some(t => t.ownershipStatus === 'none')
    };

    console.log("[SEARCH] Orchestration terminée avec succès.");
    console.groupEnd();

    // 5. RÉSULTAT : Le "Paquet" final prêt à l'emploi
    return {
      mainBook: book,
      ownership: {
        isEditionOwned,
        isWorkOwned,
        isWished,
        duplicateEdition
      },
      series: seriesContext,
      ui,
      source
    };
  }
};