// src/core/orchestrators/search.orchestrator.ts
import { databaseService } from '../database/database.service';
import { wishlistService } from '../services/wishlist.service';
import { entityResolver } from '../resolvers/entity.resolver';
import { bookCacheService } from '../services/book-cache.service';
import { externalMetadataService } from '../services/external-metadata.service';
import { imageUtil } from '../utils/image.util';
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
      let lastNetworkErr: unknown = null;
      try {
        const v4Batch = await ingestIsbnsViaV4({
          isbns: [isbn],
          sourceChannel: 'canal_1_barcode',
          action: 'preview'
        });
        v4IngestResult = v4Batch?.results?.[0] || null;
        if (v4IngestResult?.book) {
          const initialOwned =
            v4IngestResult.layer2Status === 'ALREADY_OWNED' ||
            v4IngestResult.layer2Status === 'INCLUDED_IN_INTEGRAL' ||
            v4IngestResult.layer2Status === 'FULL_INTEGRAL_OWNED'
              ? 'owned'
              : 'none';
          book = v4BookRecordToHumanizedBook(v4IngestResult.book, initialOwned);
          source = 'network';
          await bookCacheService.saveAndProcessImage(book);
        }
      } catch (v4Err: unknown) {
        lastNetworkErr = v4Err;
        console.warn(`[SEARCH] Pipeline V4 indisponible pour ${isbn}, bascule sur les sources de secours`, v4Err);
      }

      if (!book) {
        try {
          book = await entityResolver.resolvePhysicalEntity(`isbn:${isbn}`);
          if (book) {
            source = 'network';
            await bookCacheService.saveAndProcessImage(book);
          }
        } catch (resolverErr: unknown) {
          lastNetworkErr = resolverErr;
          console.warn(`[SEARCH] entityResolver en échec pour ${isbn}`, resolverErr);
        }
      }

      if (!book) {
        try {
          const meta = await externalMetadataService.fetchFromExternalSources(isbn);
          if (meta && (meta.title?.trim() || meta.authors?.length)) {
            const coverFallbackUrls = imageUtil.buildCoverCandidates(isbn, [
              meta.coverUrl,
              ...(meta.coverFallbackUrls || [])
            ]);
            book = {
              uri: `isbn:${isbn}`,
              type: 'edition',
              isbn13: isbn,
              title: meta.title?.trim() || `Livre ISBN ${isbn}`,
              authors: meta.authors?.length ? meta.authors : ['Auteur inconnu'],
              illustrators: [],
              scriptwriters: [],
              publisher: meta.publisher || '',
              publishDate: meta.publishDate,
              pageCount: meta.pageCount,
              coverUrl: meta.coverUrl || coverFallbackUrls[0],
              ...(coverFallbackUrls.length ? { coverFallbackUrls } : {}),
              series: meta.series,
              seriesNumber: meta.seriesNumber,
              genres: meta.genres || [],
              ownershipStatus: 'none'
            };
            source = 'network';
            await bookCacheService.saveAndProcessImage(book);
          }
        } catch (extErr: unknown) {
          lastNetworkErr = extErr;
          console.warn(`[SEARCH] externalMetadataService en échec pour ${isbn}`, extErr);
        }
      }

      if (!book) {
        if (connectionState.isOffline.value || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
          console.warn(`[SEARCH] Bascule hors-ligne pendant la recherche pour ${isbn}`, lastNetworkErr);
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
      const hasResolvedIntegralStatus =
        layer2Status === 'INCLUDED_IN_INTEGRAL' ||
        layer2Status === 'FULL_INTEGRAL_OWNED' ||
        layer2Status === 'PARTIAL_INTEGRAL_OWNED';
      if (!hasResolvedIntegralStatus) {
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
    if (isWorkOwned && typeof databaseService.saveBookToCache === 'function') {
      await databaseService.saveBookToCache({ ...book, ownershipStatus: 'owned' }).catch(() => {});
    }

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