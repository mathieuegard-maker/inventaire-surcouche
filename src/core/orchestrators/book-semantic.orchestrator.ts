// src/core/orchestrators/book-semantic.orchestrator.ts
import { inventaireSyncService } from '../services/inventaire-sync.service';
import { inventoryService } from '../services/inventory.service';
import { bookCacheService } from '../services/book-cache.service';
import { databaseService } from '../database/database.service';
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
      publisher: string;
      publishDate: string;
      pageCount?: number;
      coverUrl: string;
    },
    resolvedSeriesUri: string | undefined,
    resolvedAuthorUris: Record<string, string>
  ): Promise<HumanizedBook> {
    console.log(`[BOOK SEMANTIC ORCHESTRATOR] Démarrage du patch de modification sémantique pour : ${originalBook.title}`);

    // 1. Synchronisation distante des claims sur inventaire.io
    const res = await inventaireSyncService.patchBookOnInventaire(
      originalBook,
      updatedData,
      resolvedSeriesUri,
      resolvedAuthorUris
    );

    const newCoverUrl = updatedData.coverUrl || undefined;
    const coverChanged = newCoverUrl !== originalBook.coverUrl;

    // 2. Construction de l'entité finale fusionnée
    const updatedBook: HumanizedBook = {
      ...originalBook,
      title: updatedData.title,
      authors: updatedData.authors,
      series: updatedData.series || undefined,
      seriesId: res.seriesUri || undefined,
      seriesNumber: updatedData.seriesNumber || undefined,
      publisher: updatedData.publisher || undefined,
      publishDate: updatedData.publishDate || undefined,
      pageCount: updatedData.pageCount,
      coverUrl: newCoverUrl,
      localCover: coverChanged ? undefined : originalBook.localCover,
      workUri: res.workUri,
      isLocallyEdited: true
    };

    console.log(`[BOOK SEMANTIC ORCHESTRATOR] Mise à jour du cache local IndexedDB pour : ${updatedBook.title}`);
    
    // 3. Sauvegarde dans IndexedDB (Dexie) et retraitement de couverture si nécessaire
    const plainBook: HumanizedBook = JSON.parse(JSON.stringify(updatedBook));
    if (coverChanged && plainBook.coverUrl) {
      await bookCacheService.saveAndProcessImage(plainBook, undefined, { forceOverwrite: true });
    } else {
      await databaseService.saveBookToCache(plainBook);
    }

    return updatedBook;
  }
};
