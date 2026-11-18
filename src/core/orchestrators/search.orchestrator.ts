// src/core/orchestrators/search.orchestrator.ts
import { databaseService } from '../database/database.service';
import { wishlistService } from '../services/wishlist.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { bookCacheService } from '../services/book-cache.service';
import { isbnUtil } from '../utils/isbn.util';
import { findMatchingOwnedWork } from '../utils/series-matcher.util';
import {
  checkLocalIntegralConflict,
  formatV4StatusNotice,
  ingestIsbnsViaV4,
  v4BookRecordToHumanizedBook
} from '../services/v4-client.service';
import { seriesOrchestrator } from './series.orchestrator';
import { syncOrchestrator } from './sync.orchestrator';
import { connectionState } from '../../state/connection';
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
    
    // 1. PHASE IDENTIFICATION : Local-First O(1) via book_isbn_index -> Backend V4 -> Repli legacy
    let book: HumanizedBook | null | undefined = await databaseService.getBookByIsbn(isbn);
    let source: 'cache' | 'network' = 'cache';
    let v4IngestResult: any = null;

    if (!book) {
      if (connectionState.isOffline.value) {
        console.warn(`[SEARCH] Absent du cache local et pas de réseau disponible pour l'ISBN ${isbn}`);
        console.groupEnd();
        return { isOfflineUnavailable: true, isbn } as any;
      }
      console.log("[SEARCH] Absent du cache, interrogation Pipeline V4...");
      try {
        const v4Batch = await ingestIsbnsViaV4({
          isbns: [isbn],
          sourceChannel: /^(330|378|977)\d{10}$/.test(isbn) ? 'canal_1_barcode' : 'canal_2_manual_isbn',
          action: 'preview'
        });
        v4IngestResult = v4Batch?.results?.[0] || null;
        if (v4IngestResult?.book) {
          const initialOwned = v4IngestResult.layer2Status === 'ALREADY_OWNED' ? 'owned' : 'none';
          book = v4BookRecordToHumanizedBook(v4IngestResult.book, initialOwned);
          source = 'network';
          await bookCacheService.saveAndProcessImage(book);
        } else {
          book = await entityResolver.resolvePhysicalEntity(`isbn:${isbn}`);
          if (book) {
            source = 'network';
            await bookCacheService.saveAndProcessImage(book);
          }
        }
      } catch (networkErr: any) {
        if (connectionState.isOffline.value || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
          console.warn(`[SEARCH] Coupure réseau pendant la résolution pour ${isbn}`, networkErr);
          console.groupEnd();
          return { isOfflineUnavailable: true, isbn } as any;
        }
        throw networkErr;
      }

      if (!book) {
        if (connectionState.isOffline.value) {
          console.warn(`[SEARCH] Bascule hors-ligne pendant la recherche pour ${isbn}`);
          console.groupEnd();
          return { isOfflineUnavailable: true, isbn } as any;
        }
        console.warn(`[SEARCH] Échec de la résolution réseau pour : ${isbn}. Bascule vers l'agrégation de création.`);
        console.groupEnd();
        return { isUnknown: true, isbn } as any;
      }
    } else {
      console.log("[SEARCH] Trouvé en cache local.");
      
      // AJOUT (TTL) : Si le livre en cache a plus de 30 jours, on lance une mise à jour en arrière-plan
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      if (book.updatedAt && (Date.now() - book.updatedAt > THIRTY_DAYS)) {
        console.log(`[SEARCH] Cache périmé (> 30 jours) pour l'ISBN ${isbn}. Lancement du rafraîchissement fantôme.`);
        syncOrchestrator.refreshBookInBackground(isbn);
      }
    }

    // 2. PHASE ANALYSE D'APPARTENANCE & INTÉGRALES BIDIRECTIONNELLES V4
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

    let integralMatches = v4IngestResult?.ownedIntegralMatches || [];
    let includedOwnedWorkIds = v4IngestResult?.includedOwnedWorkIds || [];
    let layer2Status = v4IngestResult?.layer2Status;
    let v4Notice = v4IngestResult ? formatV4StatusNotice(v4IngestResult) : undefined;

    if (typeof databaseService.getAllBooksFromCache === 'function') {
      const allCached = await databaseService.getAllBooksFromCache().catch(() => []);
      if (!isWorkOwned) {
        const workMatch = findMatchingOwnedWork({
          candidateIsbns: [isbn, book.isbn13, book.isbn10, ...(book.knownIsbns || [])].filter(
            (x): x is string => Boolean(x)
          ),
          candidateWorkUri: book.workUri,
          candidateTitle: book.title,
          candidateAuthors: book.authors,
          candidateSeries: book.series,
          candidateSeriesNumber: book.seriesNumber,
          existingBooks: allCached,
          targetStatuses: ['owned']
        });
        if (workMatch) {
          isWorkOwned = true;
          duplicateEdition = allCached.find((b) => b.uri === workMatch.book.uri);
        }
      }
      if (!layer2Status) {
        const localInt = checkLocalIntegralConflict(book, allCached);
        if (localInt.status) {
          layer2Status = localInt.status;
          integralMatches = localInt.ownedIntegralMatches;
          includedOwnedWorkIds = localInt.includedOwnedWorkIds;
          v4Notice = localInt.notice;
          if (localInt.status === 'INCLUDED_IN_INTEGRAL' || localInt.status === 'FULL_INTEGRAL_OWNED') {
            isWorkOwned = true;
          }
        }
      } else if (layer2Status === 'INCLUDED_IN_INTEGRAL' || layer2Status === 'FULL_INTEGRAL_OWNED') {
        isWorkOwned = true;
      }
    }

    book.ownershipStatus = isWorkOwned ? 'owned' : (isWished ? 'wish' : 'none');

    // 3. PHASE ANALYSE DES PRÊTS
    const loanDetails = await databaseService.getLoan(book.uri);
    const isLent = !!loanDetails;

    // 4. PHASE EXPANSION : Contexte de Série
    let seriesContext = undefined;
    if (book.seriesId) {
      console.log(`[SEARCH] Délégation de la série à seriesOrchestrator : ${book.seriesId}`);
      
      // SCÉNARIO ILLUMINÉ : Lancement asynchrone immédiat (Fire & Forget), aucune pause sur cet écran
      seriesOrchestrator.startBackgroundHydration(book.seriesId);
      
      // Extraction instantanée de l'état du cache local pour libérer la vue de recherche
      seriesContext = await seriesOrchestrator.getCompleteSeriesForUI(book.seriesId, book.series);
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
        duplicateEdition,
        ...(layer2Status ? { layer2Status } : {}),
        ...(integralMatches.length ? { ownedIntegralMatches: integralMatches } : {}),
        ...(includedOwnedWorkIds.length ? { includedOwnedWorkIds } : {}),
        ...(v4Notice ? { v4Notice } : {})
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