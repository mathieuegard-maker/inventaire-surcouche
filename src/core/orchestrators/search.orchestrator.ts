// src/services/search.service.ts
import { databaseService } from '../database/database.service';
import { wishlistService } from '../services/wishlist.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { entityHumanizer } from '../resolvers/humanizer';
import { seriesResolver } from '../resolvers/series.resolver';
import type { SearchResponse, HumanizedBook } from '../types';

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
      
      // SONDE DEBUG : AVANT SAUVEGARDE CACHE
      console.log(`[DEBUG-SEARCH] Livre humanisé, prêt pour le cache. coverUrl:`, book.coverUrl);

      // Sauvegarde immédiate dans le cache books
      await databaseService.saveBookToCache(book);
      source = 'network';
    } else {
      console.log("[SEARCH] Trouvé en cache local.");
    }

    // 2. PHASE ANALYSE DE POSSESSION (Double Check)
    // CORRECTION : On passe systématiquement le workUri pour la conscience de l'œuvre
    const isEditionOwned = await databaseService.isUriInRegistry('inventory', book.uri);
    const isWished = await wishlistService.isUriWished(book.uri, book.workUri);
    
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

    // Mise à jour du statut temps réel pour l'affichage (L'œuvre prime sur le souhait)
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

    // 5. PHASE UI : Calcul des indicateurs pour le Frontend
    const ui = {
      showAddButton: !isWorkOwned, // On ne propose l'ajout que si on ne possède aucune édition
      showWishButton: !isWorkOwned && !isWished,
      alertDuplicate: !isEditionOwned && isWorkOwned,
      hasBulkActions: !!seriesContext && seriesContext.tomes.some(t => t.ownershipStatus === 'none'),
      showLoanButton: isEditionOwned && !isLent,
      showReturnButton: isLent
    };

    // SONDE DEBUG : OBJET FINAL
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
      ui,
      source
    };
  }
};