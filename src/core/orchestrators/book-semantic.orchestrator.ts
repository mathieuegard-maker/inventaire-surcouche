// src/core/orchestrators/book-semantic.orchestrator.ts
import { inventaireSyncService } from '../services/inventaire-sync.service';
import { inventoryService } from '../services/inventory.service';
import { bookCacheService } from '../services/book-cache.service';
import { databaseService } from '../database/database.service';
import { patchV4BookMetadata } from '../services/v4-client.service';
import {
  buildIntegralMetadata,
  formatIntegralRangeLabel,
  parseIncludedVolumeNumbers
} from '../bibliographic/integral.util';
import { scannerState } from '../../state/scanner';
import type { HumanizedBook } from '../types';

export interface MatchItem {
  name: string;
  uri: string;
  distance: number;
}

export interface ResolutionStep {
  type: 'series' | 'author';
  name: string;
  matches: MatchItem[];
}

export const bookSemanticOrchestrator = {
  /**
   * Analyse les auteurs et la série saisis pour détecter les doublons potentiels (similarités de Levenshtein)
   * et renvoie la liste des étapes de résolution nécessaires.
   */
  async analyzeDuplicates(
    authors: string,
    series: string,
    noSeries: boolean,
    originalBook?: HumanizedBook | null
  ): Promise<ResolutionStep[]> {
    const seriesName = noSeries ? '' : series.trim();
    const originalSeriesName = originalBook?.series || '';
    const hasSeriesChanged = seriesName.toLowerCase() !== originalSeriesName.toLowerCase();

    const seriesTask = (async (): Promise<ResolutionStep | null> => {
      if (!seriesName || (originalBook && !hasSeriesChanged)) return null;
      console.log(`[BOOK SEMANTIC ORCHESTRATOR] Analyse de la série : ${seriesName}`);
      const exactUri = await inventaireSyncService.searchEntity(seriesName, 'series');
      if (exactUri) return null;
      const matches = await inventaireSyncService.findSimilarSeries(seriesName);
      return matches.length > 0 ? { type: 'series', name: seriesName, matches } : null;
    })();

    const authorsList = authors.split(',').map(a => a.trim()).filter(Boolean);
    const originalAuthors = originalBook?.authors || [];

    const authorTasks = authorsList.map(async (authorName): Promise<ResolutionStep | null> => {
      const isNewAuthor = !originalBook || !originalAuthors.find(
        a => a.toLowerCase().trim() === authorName.toLowerCase()
      );
      if (!isNewAuthor) return null;
      console.log(`[BOOK SEMANTIC ORCHESTRATOR] Analyse de l'auteur : ${authorName}`);
      const exactUri = await inventaireSyncService.searchEntity(authorName, 'humans');
      if (exactUri) return null;
      const matches = await inventaireSyncService.findSimilarAuthors(authorName);
      return matches.length > 0 ? { type: 'author', name: authorName, matches } : null;
    });

    const results = await Promise.all([seriesTask, ...authorTasks]);
    return results.filter((step): step is ResolutionStep => step !== null);
  },

  /**
   * Effectue les appels de création d'ouvrage sur inventaire.io,
   * l'ajoute à la collection, télécharge et traite la couverture, et met à jour le cache Dexie.
   */
  async saveCreatedBook(
    tempBook: HumanizedBook,
    resolvedSeriesUri: string | undefined,
    resolvedAuthorUris: Record<string, string>
  ): Promise<HumanizedBook> {
    console.log(`[BOOK SEMANTIC ORCHESTRATOR] Démarrage de la sauvegarde de création sémantique pour : ${tempBook.title}`);
    
    // 1. Synchronisation distante sur inventaire.io
    const syncResult = await inventaireSyncService.syncBookToInventaire(
      tempBook,
      resolvedSeriesUri,
      resolvedAuthorUris
    );

    // 2. Ajout à la bibliothèque utilisateur distante
    await inventoryService.addToLibrary(syncResult.editionUri);

    // 3. Construction de l'entité finale résolue
    const finalBook: HumanizedBook = {
      ...tempBook,
      uri: syncResult.editionUri,
      workUri: syncResult.workUri,
      seriesId: syncResult.seriesUri,
      coverUrl: tempBook.coverUrl || undefined,
      ownershipStatus: 'owned'
    };

    console.log(`[BOOK SEMANTIC ORCHESTRATOR] Enregistrement en cache local IndexedDB pour : ${finalBook.title}`);
    
    // 4. Sauvegarde locale en cache et conversion asynchrone d'image
    await bookCacheService.saveAndProcessImage(finalBook, 'owned');

    return finalBook;
  },

  /**
   * Effectue les appels de modification/patch sémantique sur inventaire.io
   * et met à jour le cache local IndexedDB (Dexie).
   */
  async saveEditedBook(
    originalBook: HumanizedBook,
    updatedData: {
      title: string;
      authors: string[];
      series: string;
      seriesNumber: string;
      isIntegral?: boolean;
      includedVolumeNumbers?: string[];
      publisher: string;
      publishDate: string;
      pageCount?: number;
      coverUrl: string;
      genres?: string[];
    },
    resolvedSeriesUri: string | undefined,
    resolvedAuthorUris: Record<string, string>
  ): Promise<HumanizedBook> {
    console.log(`[BOOK SEMANTIC ORCHESTRATOR] Démarrage du patch de modification sémantique pour : ${originalBook.title}`);

    const hasSeriesNameChanged =
      (updatedData.series || '').trim().toLowerCase() !== (originalBook.series || '').trim().toLowerCase();
    const effectiveSeriesId =
      resolvedSeriesUri ?? (updatedData.series ? (!hasSeriesNameChanged ? originalBook.seriesId : undefined) : null);

    const isIntegral = updatedData.isIntegral !== undefined ? Boolean(updatedData.isIntegral) : Boolean(originalBook.isIntegral);
    const parsedIncludedVols = isIntegral
      ? parseIncludedVolumeNumbers(updatedData.includedVolumeNumbers ?? originalBook.integralMetadata?.includedVolumeNumbers)
      : [];
    const effectiveSeriesNumber = isIntegral
      ? formatIntegralRangeLabel(parsedIncludedVols, updatedData.seriesNumber || originalBook.seriesNumber)
      : updatedData.seriesNumber;

    // 1. Option B : Pour un livre V4, enregistrer uniquement les surcharges privées du foyer dans `v4_library_books`
    //    afin de ne jamais écraser le catalogue commun ni les choix des autres utilisateurs.
    const v4Updated = await patchV4BookMetadata({
      bookId: originalBook.bookId,
      uri: originalBook.uri,
      isbn13: originalBook.isbn13,
      title: updatedData.title,
      authors: updatedData.authors,
      series: updatedData.series,
      seriesId: effectiveSeriesId,
      seriesNumber: effectiveSeriesNumber,
      isIntegral: updatedData.isIntegral !== undefined ? isIntegral : undefined,
      includedVolumeNumbers: updatedData.isIntegral !== undefined ? parsedIncludedVols : undefined,
      publisher: updatedData.publisher,
      publishDate: updatedData.publishDate,
      coverUrl: updatedData.coverUrl,
      genres: updatedData.genres
    }).catch(() => null);

    const res =
      !v4Updated && !originalBook.bookId
        ? await inventaireSyncService.patchBookOnInventaire(
            originalBook,
            updatedData,
            resolvedSeriesUri,
            resolvedAuthorUris
          )
        : { seriesUri: effectiveSeriesId || undefined, workUri: originalBook.workUri };

    const newCoverUrl = updatedData.coverUrl || undefined;
    const isDataCover = Boolean(newCoverUrl && newCoverUrl.startsWith('data:image/'));
    const coverChanged = newCoverUrl !== originalBook.coverUrl;

    // 2. Construction de l'entité finale fusionnée
    const updatedBook: HumanizedBook = {
      ...originalBook,
      bookId: v4Updated?.id || originalBook.bookId,
      title: updatedData.title,
      authors: updatedData.authors,
      series: updatedData.series || undefined,
      seriesId: v4Updated?.seriesId || res.seriesUri || (updatedData.series ? originalBook.seriesId : undefined),
      seriesNumber: effectiveSeriesNumber || undefined,
      isIntegral,
      integralMetadata: isIntegral
        ? buildIntegralMetadata(parsedIncludedVols, v4Updated?.integralMetadata || originalBook.integralMetadata)
        : { includedVolumeNumbers: [], includedWorkIds: [], includedIsbns: [] },
      publisher: updatedData.publisher || undefined,
      publishDate: updatedData.publishDate || undefined,
      pageCount: updatedData.pageCount,
      coverUrl: newCoverUrl,
      localCover: isDataCover
        ? newCoverUrl
        : coverChanged
          ? undefined
          : originalBook.localCover,
      genres: Array.isArray(updatedData.genres) ? updatedData.genres : originalBook.genres,
      workUri: res.workUri,
      isLocallyEdited: true,
      updatedAt: Date.now()
    };

    console.log(`[BOOK SEMANTIC ORCHESTRATOR] Mise à jour du cache local IndexedDB pour : ${updatedBook.title}`);
    
    // 3. Sauvegarde dans IndexedDB (Dexie) et retraitement de couverture si nécessaire
    const plainBook: HumanizedBook = JSON.parse(JSON.stringify(updatedBook));
    if ((coverChanged && plainBook.coverUrl) || (plainBook.localCover && plainBook.localCover.startsWith('data:image/'))) {
      await bookCacheService.saveAndProcessImage(plainBook, undefined, { forceOverwrite: true });
    } else {
      await databaseService.saveBookToCache(plainBook);
    }

    // 3B. Propager la couverture choisie à toute éventuelle fiche doublon locale du même `bookId` / `workUri`
    //     pour que la liste des séries ne puisse jamais afficher une ancienne couverture d'une autre édition de la même œuvre.
    if (coverChanged && (plainBook.bookId || plainBook.workUri) && typeof databaseService.getAllBooksFromCache === 'function') {
      const allCachedForCover = await databaseService.getAllBooksFromCache().catch(() => []);
      for (const dup of allCachedForCover) {
        if (!dup || dup.uri === plainBook.uri) continue;
        const sameBook =
          (plainBook.bookId && dup.bookId === plainBook.bookId) ||
          (plainBook.workUri && dup.workUri === plainBook.workUri);
        if (sameBook) {
          await databaseService
            .saveBookToCache(
              JSON.parse(
                JSON.stringify({
                  ...dup,
                  coverUrl: plainBook.coverUrl,
                  localCover: plainBook.localCover,
                  isLocallyEdited: true,
                  updatedAt: plainBook.updatedAt
                })
              )
            )
            .catch(() => {});
        }
      }
    }

    // 4. Si de nouveaux genres ont été ajoutés sur un tome d'une série, les ajouter CUMULATIVEMENT aux autres tomes
    //    sans écraser les genres propres déjà présents sur les autres volumes.
    const oldGenreSet = new Set((originalBook.genres || []).map((g) => g.trim().toLowerCase()).filter(Boolean));
    const newGenresList = Array.isArray(updatedData.genres) ? updatedData.genres : [];
    const newlyAddedGenres = newGenresList
      .map((g) => g.trim())
      .filter((g) => g && !oldGenreSet.has(g.toLowerCase()));
    const targetSeriesId = plainBook.seriesId;
    const normSeriesName = (plainBook.series || '').trim().toLowerCase();

    if (
      newlyAddedGenres.length > 0 &&
      (targetSeriesId || normSeriesName) &&
      typeof databaseService.getAllBooksFromCache === 'function'
    ) {
      const allCached = await databaseService.getAllBooksFromCache();
      for (const sibling of allCached) {
        if (!sibling || sibling.uri === plainBook.uri) continue;
        const matchesSeriesId = Boolean(targetSeriesId && sibling.seriesId === targetSeriesId);
        const matchesSeriesName = Boolean(
          normSeriesName && (sibling.series || '').trim().toLowerCase() === normSeriesName
        );
        if (matchesSeriesId || matchesSeriesName) {
          const mergedGenres = [...(sibling.genres || [])];
          for (const g of newlyAddedGenres) {
            if (!mergedGenres.some((e) => e.trim().toLowerCase() === g.toLowerCase())) {
              mergedGenres.push(g);
            }
          }
          const updatedSibling: HumanizedBook = {
            ...sibling,
            genres: mergedGenres,
            isLocallyEdited: true
          };
          await databaseService.saveBookToCache(JSON.parse(JSON.stringify(updatedSibling)));
        }
      }
    }

    scannerState.notifyCatalogChanged();
    return updatedBook;
  }
};
