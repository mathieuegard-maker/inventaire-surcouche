// src/core/orchestrators/background-creation.orchestrator.ts
import { ref } from 'vue';
import { databaseService, type PendingCreation } from '../database/database.service';
import { inventaireSyncService } from '../services/inventaire-sync.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import { bookCacheService } from '../services/book-cache.service';
import { bnfResolver, normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import { getLevenshteinDistance } from '../utils/string.util';
import { isbnUtil } from '../utils/isbn.util';
import { imageUtil } from '../utils/image.util';
import { findBestMatchingSeries, findMatchingOwnedWork } from '../utils/series-matcher.util';
import { workEditionHarvesterService } from '../services/work-edition-harvester.service';
import { connectionState, fetchWithTimeout } from '../../state/connection';
import type { ExternalBookMetadata, HumanizedBook } from '../types';

const MAX_SERIES_VOLUMES_TO_CREATE = 60;
const CREATION_PACING_MS = 300;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface BackgroundCreationStatus {
  isActive: boolean;
  pendingCount: number;
  stepLabel: string;
  current: number;
  total: number;
  lastCompletedAt: number;
  lastSuccessMsg: string | null;
  lastError: string | null;
}

const status = ref<BackgroundCreationStatus>({
  isActive: false,
  pendingCount: 0,
  stepLabel: '',
  current: 0,
  total: 0,
  lastCompletedAt: 0,
  lastSuccessMsg: null,
  lastError: null
});

function extractEntityTitle(entity: any): string {
  if (!entity) return '';
  if (entity.labels?.fr) return entity.labels.fr;
  if (entity.labels?.en) return entity.labels.en;
  if (entity.labels && typeof entity.labels === 'object') {
    const first = Object.values(entity.labels)[0];
    if (typeof first === 'string') return first;
  }
  const titleClaim = entity.claims?.['wdt:P1476']?.[0];
  return typeof titleClaim === 'string' ? titleClaim : (titleClaim?.value || '');
}

function getAllNormalizedIsbns(book: { isbn13?: string; isbn10?: string; uri?: string }): string[] {
  const out: string[] = [];
  for (const raw of [book.isbn13, book.isbn10, book.uri?.startsWith('isbn:') ? book.uri.slice(5) : undefined]) {
    if (!raw) continue;
    const norm = isbnUtil.normalize(raw);
    if (!norm) continue;
    out.push(norm);
    if (norm.length === 10) out.push(isbnUtil.toIsbn13(norm));
  }
  return out;
}

export const backgroundCreationOrchestrator = {
  status,
  isProcessing: false,

  /**
   * Enregistre immédiatement l'ouvrage localement, met la création distante en file
   * et rend la main instantanément à l'utilisateur.
   */
  async enqueueBookCreation(params: {
    tempBook: HumanizedBook;
    resolvedSeriesUri?: string;
    resolvedAuthorUris?: Record<string, string>;
    expandSeries?: boolean;
    ownershipTarget?: 'owned' | 'wish' | 'none';
  }): Promise<HumanizedBook> {
    const {
      tempBook,
      resolvedSeriesUri,
      resolvedAuthorUris = {},
      expandSeries = true,
      ownershipTarget = 'owned'
    } = params;

    // 1. Pré-attachement orienté Œuvre : vérifier si l'œuvre ou la série existe déjà en cache local
    let effectiveSeriesUri = resolvedSeriesUri;
    let effectiveSeriesTitle = tempBook.series;
    let effectiveExpandSeries = expandSeries;
    const localBooks =
      typeof databaseService.getAllBooksFromCache === 'function'
        ? await databaseService.getAllBooksFromCache().catch(() => [])
        : [];

    // 1A. Si cette œuvre est déjà possédée sous une autre édition, fusionner simplement son ISBN dans knownIsbns
    if (ownershipTarget === 'owned' && localBooks.length > 0) {
      const existingOwned = findMatchingOwnedWork({
        candidateIsbns: [tempBook.isbn13, tempBook.isbn10, ...(tempBook.knownIsbns || [])].filter(
          (x): x is string => Boolean(x)
        ),
        candidateWorkUri: tempBook.workUri,
        candidateTitle: tempBook.title,
        candidateAuthors: tempBook.authors,
        candidateSeries: tempBook.series,
        candidateSeriesNumber: tempBook.seriesNumber,
        existingBooks: localBooks,
        targetStatuses: ['owned']
      });
      if (existingOwned) {
        const existingFull = localBooks.find((b) => b.uri === existingOwned.book.uri);
        if (existingFull) {
          const mergedIsbns = new Set<string>([
            ...(existingFull.knownIsbns || []),
            ...(existingFull.isbn13 ? [existingFull.isbn13] : []),
            ...(tempBook.isbn13 ? [tempBook.isbn13] : []),
            ...(tempBook.isbn10 ? [tempBook.isbn10] : []),
            ...(tempBook.knownIsbns || [])
          ]);
          const updatedExisting = {
            ...existingFull,
            knownIsbns: Array.from(mergedIsbns)
          };
          await databaseService.saveBookToCache(updatedExisting);
          return updatedExisting;
        }
      }
    }

    if (!effectiveSeriesUri && (tempBook.series?.trim() || tempBook.title?.trim())) {
      const matched = findBestMatchingSeries({
        candidateSeries: tempBook.series,
        candidateTitle: tempBook.title,
        candidateAuthors: tempBook.authors,
        candidateWorkUri: tempBook.workUri,
        existingBooks: localBooks
      });
      if (matched) {
        if (matched.seriesId && !matched.seriesId.startsWith('local:')) {
          effectiveSeriesUri = matched.seriesId;
        }
        effectiveSeriesTitle = matched.series;
        // Si la série est déjà hydratée avec >= 2 tomes en local, inutile de retélécharger toute la série sur la BnF
        if (matched.volumeCount >= 2) {
          effectiveExpandSeries = false;
        }
      } else if (tempBook.series?.trim()) {
        const localMatches = await databaseService.findLocalSeriesMatches(tempBook.series);
        const existingSeriesId = localMatches.find(b => b.seriesId && !b.seriesId.startsWith('local:'))?.seriesId;
        if (existingSeriesId) {
          effectiveSeriesUri = existingSeriesId;
        }
      }
    }

    const optimisticBook: HumanizedBook = {
      ...tempBook,
      series: effectiveSeriesTitle,
      seriesId: effectiveSeriesUri || tempBook.seriesId,
      ownershipStatus: ownershipTarget
    };

    // 2. Persistance immédiate dans IndexedDB + registre approprié
    await databaseService.saveBookToCache(optimisticBook);
    if (ownershipTarget === 'owned') {
      await databaseService.addRegistryEntry('inventory', optimisticBook.uri);
    } else if (ownershipTarget === 'wish') {
      await databaseService.addRegistryEntry('wishlist', optimisticBook.uri);
    }

    // Mise en cache image en non-bloquant
    if (optimisticBook.coverUrl || optimisticBook.isbn13 || optimisticBook.isbn10) {
      bookCacheService.saveAndProcessImage(optimisticBook, ownershipTarget).catch(() => {});
    }

    // Moissonnage multi-ISBN en arrière-plan (BnF + OpenLibrary) pour enrichir knownIsbns de l'Œuvre
    if (optimisticBook.title) {
      workEditionHarvesterService
        .harvestKnownIsbnsForWork({
          title: optimisticBook.title,
          authors: optimisticBook.authors,
          seedIsbns: [optimisticBook.isbn13, optimisticBook.isbn10, ...(optimisticBook.knownIsbns || [])]
        })
        .then(async (harvest) => {
          if (harvest.knownIsbns.length === 0 && !harvest.fallbackCoverUrl) return;
          const current = await databaseService.getBookFromCache(optimisticBook.uri).catch(() => null);
          if (!current) return;
          const merged = Array.from(new Set([...(current.knownIsbns || []), ...harvest.knownIsbns]));
          const nextCoverUrl = current.coverUrl || harvest.fallbackCoverUrl;
          const updatedBook = {
            ...current,
            knownIsbns: merged,
            ...(nextCoverUrl ? { coverUrl: nextCoverUrl } : {})
          };
          await databaseService.saveBookToCache(updatedBook);
          if (!current.localCover && nextCoverUrl) {
            bookCacheService
              .saveAndProcessImage(
                updatedBook,
                current.ownershipStatus === 'wish' ? 'wish' : 'owned'
              )
              .catch(() => {});
          }
          if (current.workUri && current.workUri.startsWith('inv:') && merged.length > 0) {
            inventaireSyncService
              .updateClaim(current.workUri, 'invp:knownIsbns', undefined, merged)
              .catch(() => {});
          }
        })
        .catch(() => {});
    }

    // 3. Ajout dans la file persistante de création distante
    await databaseService.savePendingCreation({
      tempBook: optimisticBook,
      resolvedSeriesUri: effectiveSeriesUri,
      resolvedAuthorUris,
      expandSeries: effectiveExpandSeries,
      ownershipTarget,
      status: 'pending',
      createdAt: Date.now()
    });

    const allJobs = await databaseService.getPendingCreations();
    status.value = {
      ...status.value,
      pendingCount: allJobs.length,
      lastError: null,
      lastCompletedAt: Date.now()
    };

    // Lancement asynchrone sans bloquer l'appelant
    this.processQueue();
    return optimisticBook;
  },

  async resumePendingJobs(): Promise<void> {
    if (connectionState.isOffline.value || this.isProcessing) return;
    const jobs = await databaseService.getPendingCreations();
    const runnable = jobs.filter(j => j.status === 'pending' || j.status === 'processing');
    if (runnable.length > 0) {
      this.processQueue();
    }
  },

  async processQueue(): Promise<void> {
    if (this.isProcessing || connectionState.isOffline.value) return;
    this.isProcessing = true;

    try {
      while (true) {
        if (connectionState.isOffline.value) break;

        const jobs = await databaseService.getPendingCreations();
        const nextJob = jobs.find(j => j.status === 'pending' || j.status === 'processing');

        if (!nextJob || nextJob.id === undefined) {
          status.value = {
            ...status.value,
            isActive: false,
            pendingCount: 0,
            stepLabel: '',
            current: 0,
            total: 0
          };
          break;
        }

        const remainingRunnable = jobs.filter(j => j.status === 'pending' || j.status === 'processing').length;
        status.value = {
          ...status.value,
          isActive: true,
          pendingCount: remainingRunnable,
          stepLabel: `Enregistrement : « ${nextJob.tempBook.title} »`,
          current: 0,
          total: 1,
          lastError: null
        };

        await databaseService.updatePendingCreation(nextJob.id, { status: 'processing' });

        try {
          await this.processSingleJob(nextJob);
          await databaseService.deletePendingCreation(nextJob.id);

          const remaining = await databaseService.getPendingCreations();
          status.value = {
            ...status.value,
            pendingCount: remaining.filter(j => j.status === 'pending' || j.status === 'processing').length,
            lastCompletedAt: Date.now(),
            lastSuccessMsg: `« ${nextJob.tempBook.title} » synchronisé dans le catalogue`
          };
        } catch (err: any) {
          if (connectionState.isOffline.value) {
            await databaseService.updatePendingCreation(nextJob.id, { status: 'pending' });
            status.value = {
              ...status.value,
              isActive: false,
              stepLabel: '',
              lastError: 'Création mise en pause (hors-ligne).'
            };
            break;
          }

          console.error('[BG CREATION] Échec création en tâche de fond :', err);
          await databaseService.deletePendingCreation(nextJob.id);
          status.value = {
            ...status.value,
            lastError: `Erreur création « ${nextJob.tempBook.title} » : ${err?.message || 'Erreur inconnue'}`,
            lastCompletedAt: Date.now()
          };
        }
      }
    } finally {
      this.isProcessing = false;
      const left = await databaseService.getPendingCreations();
      const activeLeft = left.filter(j => j.status === 'pending' || j.status === 'processing').length;
      if (activeLeft === 0) {
        status.value = {
          ...status.value,
          isActive: false,
          pendingCount: 0,
          stepLabel: ''
        };
      }
    }
  },

  async processSingleJob(job: PendingCreation): Promise<void> {
    const tempBook = job.tempBook;
    const ownershipTarget = job.ownershipTarget || 'owned';

    // 1. Création / liaison de l'ouvrage principal sur inventaire.io / D1
    const syncResult = await inventaireSyncService.syncBookToInventaire(
      tempBook,
      job.resolvedSeriesUri,
      job.resolvedAuthorUris
    );

    const finalBook: HumanizedBook = {
      ...tempBook,
      uri: syncResult.editionUri,
      workUri: syncResult.workUri,
      seriesId: syncResult.seriesUri || tempBook.seriesId,
      ownershipStatus: ownershipTarget
    };

    // 2. Remplacement atomique isbn:... -> inv:... en base locale
    const savedBook = await databaseService.replaceBookUri(tempBook.uri, finalBook);

    // 2B. Synchroniser knownIsbns sur l'entité Work distante dans D1
    if (syncResult.workUri?.startsWith('inv:') && savedBook.knownIsbns?.length) {
      inventaireSyncService
        .updateClaim(syncResult.workUri, 'invp:knownIsbns', undefined, savedBook.knownIsbns)
        .catch(() => {});
    }

    // 3. Rattachement au registre distant (Inventaire ou Wishlist)
    if (ownershipTarget === 'owned') {
      await inventoryService.addToLibrary(syncResult.editionUri);
    } else if (ownershipTarget === 'wish') {
      await wishlistService.addToWishlist(syncResult.editionUri);
    }

    if ((savedBook.coverUrl || savedBook.isbn13 || savedBook.isbn10) && !savedBook.localCover) {
      bookCacheService.saveAndProcessImage(savedBook, ownershipTarget).catch(() => {});
    }

    status.value = {
      ...status.value,
      lastCompletedAt: Date.now()
    };

    // 4. Réconciliation locale + fusion de doublons + création complète de la série en arrière-plan
    if (syncResult.seriesUri && finalBook.series?.trim()) {
      await this.reconcileAndExpandSeries(
        savedBook,
        syncResult.seriesUri,
        syncResult.workUri,
        job.resolvedAuthorUris,
        job.expandSeries
      );
    }
  },

  /**
   * Fusionne les éléments locaux déjà présents pour cette série, détecte les doublons
   * locaux et distants, puis crée les tomes manquants découverts via la BNF.
   */
  async reconcileAndExpandSeries(
    seedBook: HumanizedBook,
    seriesUri: string,
    seedWorkUri: string,
    resolvedAuthorUris: Record<string, string>,
    expandSeries: boolean
  ): Promise<void> {
    const seriesName = seedBook.series?.trim();
    if (!seriesName) return;

    status.value = {
      ...status.value,
      stepLabel: `Analyse et fusion de la série « ${seriesName} »...`
    };

    // --- A. RÉCONCILIATION & FUSION DU CACHE LOCAL ---
    const knownIsbns = new Set<string>(getAllNormalizedIsbns(seedBook));
    const knownVolumeNums = new Set<string>();
    const knownNormalizedTitles: string[] = [];
    const knownWorkUris = new Set<string>([seedWorkUri]);

    if (seedBook.seriesNumber) {
      const n = normalizeSeriesNumber(seedBook.seriesNumber);
      if (n) knownVolumeNums.add(n);
    }
    if (seedBook.title) {
      knownNormalizedTitles.push(normalizeTextKey(seedBook.title));
    }

    const localMatches = await databaseService.findLocalSeriesMatches(seriesName, seriesUri);

    // Regrouper d'éventuels doublons locaux (ex: fiche temporaire isbn: vs inv:, ou même tome/ISBN)
    const seenByIsbn = new Map<string, HumanizedBook>();
    const alignedLocals: HumanizedBook[] = [];

    for (const localBook of localMatches) {
      if (localBook.uri === seedBook.uri) {
        alignedLocals.push(localBook);
        continue;
      }

      const localIsbns = getAllNormalizedIsbns(localBook);
      const duplicateTarget = localIsbns.map(i => seenByIsbn.get(i)).find(Boolean)
        || (localIsbns.some(i => knownIsbns.has(i)) ? seedBook : undefined);

      if (duplicateTarget && duplicateTarget.uri !== localBook.uri) {
        const winnerIsLocal = !duplicateTarget.uri.startsWith('isbn:') || localBook.uri.startsWith('isbn:');
        const winner = winnerIsLocal ? duplicateTarget : localBook;
        const loser = winnerIsLocal ? localBook : duplicateTarget;

        const mergedWinner = await databaseService.replaceBookUri(loser.uri, {
          ...winner,
          seriesId: seriesUri,
          series: seriesName
        });
        for (const i of getAllNormalizedIsbns(mergedWinner)) seenByIsbn.set(i, mergedWinner);
        continue;
      }

      const oldSeriesId = localBook.seriesId;
      let updatedLocal = localBook;

      if (oldSeriesId !== seriesUri || localBook.series !== seriesName) {
        updatedLocal = {
          ...localBook,
          seriesId: seriesUri,
          series: seriesName
        };
        await databaseService.saveBookToCache(updatedLocal);

        // Si l'œuvre locale est modifiable sur inventaire.io, on rattache la claim wdt:P179
        if (updatedLocal.workUri && updatedLocal.workUri.startsWith('inv:') && oldSeriesId !== seriesUri) {
          inventaireSyncService
            .updateClaim(updatedLocal.workUri, 'wdt:P179', oldSeriesId || undefined, seriesUri)
            .catch(err => console.warn('[BG CREATION] Impossible de fusionner la série sur le serveur pour', updatedLocal.workUri, err));
        }
      }

      for (const i of getAllNormalizedIsbns(updatedLocal)) {
        seenByIsbn.set(i, updatedLocal);
        knownIsbns.add(i);
      }
      if (updatedLocal.seriesNumber) {
        const n = normalizeSeriesNumber(updatedLocal.seriesNumber);
        if (n) knownVolumeNums.add(n);
      }
      if (updatedLocal.title) {
        knownNormalizedTitles.push(normalizeTextKey(updatedLocal.title));
      }
      if (updatedLocal.workUri) {
        knownWorkUris.add(updatedLocal.workUri);
      }
      alignedLocals.push(updatedLocal);
    }

    // --- B. INDEXATION DES TOMES DÉJÀ PRÉSENTS SUR INVENTAIRE.IO DANS LA SÉRIE ---
    const knownAuthorMap = new Map<string, string>();
    for (const [name, uri] of Object.entries(resolvedAuthorUris || {})) {
      if (name && uri) knownAuthorMap.set(normalizeTextKey(name), uri);
    }

    try {
      const [seriesRes, seedWorkRes] = await Promise.all([
        fetchWithTimeout(`/api/gateway?action=series-list&seriesId=${encodeURIComponent(seriesUri)}`),
        fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(seedWorkUri)}`)
      ]);

      if (seedWorkRes.ok) {
        const seedWorkData = await seedWorkRes.json();
        const seedEntity = seedWorkData.entities?.[seedWorkUri];
        const seedAuthorClaims: string[] = seedEntity?.claims?.['wdt:P50'] || [];
        seedBook.authors.forEach((aName, idx) => {
          const uri = seedAuthorClaims[idx];
          if (aName && uri && !knownAuthorMap.has(normalizeTextKey(aName))) {
            knownAuthorMap.set(normalizeTextKey(aName), uri);
          }
        });
      }

      if (seriesRes.ok) {
        const seriesData = await seriesRes.json();
        const remoteWorkUris: string[] = seriesData.uris || [];
        for (const wUri of remoteWorkUris) knownWorkUris.add(wUri);

        for (let i = 0; i < remoteWorkUris.length; i += 50) {
          const chunk = remoteWorkUris.slice(i, i + 50);
          const worksRes = await fetchWithTimeout(
            `/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(chunk.join('|'))}`
          );
          if (!worksRes.ok) continue;
          const worksJson = await worksRes.json();
          const entities = worksJson.entities || {};
          for (const wUri of chunk) {
            const ent = entities[wUri];
            if (!ent) continue;
            const title = extractEntityTitle(ent);
            if (title) knownNormalizedTitles.push(normalizeTextKey(title));
            const rawNum = ent.claims?.['wdt:P1545']?.[0];
            const volNum = typeof rawNum === 'string' ? rawNum : rawNum?.value;
            if (volNum) {
              const normNum = normalizeSeriesNumber(volNum);
              if (normNum) knownVolumeNums.add(normNum);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[BG CREATION] Erreur lors de la lecture des tomes existants de la série :', e);
    }

    if (!expandSeries) {
      status.value = { ...status.value, lastCompletedAt: Date.now() };
      return;
    }

    // --- C. DÉCOUVERTE BNF & CRÉATION DES TOMES MANQUANTS ---
    status.value = {
      ...status.value,
      stepLabel: `Recherche des tomes « ${seriesName} » sur la BNF...`
    };

    const bnfVolumes = await bnfResolver.searchSeriesVolumes(seriesName, seedBook.authors?.[0]);
    if (bnfVolumes.length === 0) {
      status.value = { ...status.value, lastCompletedAt: Date.now() };
      return;
    }

    const isTitleAlreadyKnown = (candidateTitle: string): boolean => {
      const normCand = normalizeTextKey(candidateTitle);
      if (!normCand) return false;
      return knownNormalizedTitles.some(existing =>
        existing === normCand ||
        (normCand.length >= 6 && existing.length >= 6 && getLevenshteinDistance(existing, normCand) <= 2)
      );
    };

    const missingCandidates: ExternalBookMetadata[] = [];
    for (const vol of bnfVolumes) {
      const candIsbns = getAllNormalizedIsbns({ isbn13: vol.isbn });
      if (candIsbns.some(i => knownIsbns.has(i))) continue;

      const normNum = vol.seriesNumber ? normalizeSeriesNumber(vol.seriesNumber) : '';
      if (normNum && knownVolumeNums.has(normNum)) continue;
      if (isTitleAlreadyKnown(vol.title)) continue;

      missingCandidates.push(vol);
      if (missingCandidates.length >= MAX_SERIES_VOLUMES_TO_CREATE) break;
    }

    if (missingCandidates.length === 0) {
      status.value = { ...status.value, lastCompletedAt: Date.now() };
      return;
    }

    // Pré-vérification groupée des ISBNs sur inventaire.io (1 requête pour 50 ISBNs)
    const remoteByIsbn = new Map<string, { editionUri: string; entity: any; entitiesMap: Record<string, any> }>();
    for (let i = 0; i < missingCandidates.length; i += 50) {
      const chunk = missingCandidates.slice(i, i + 50);
      const isbnUris = chunk.map(v => `isbn:${v.isbn}`);
      try {
        const res = await fetchWithTimeout(
          `/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(isbnUris.join('|'))}&attributes=${encodeURIComponent('info|labels|claims|image')}&relatives=wdt:P629`
        );
        if (res.ok) {
          const data = await res.json();
          const redirects: Record<string, string> = data.redirects || {};
          const entities: Record<string, any> = data.entities || {};
          for (const vol of chunk) {
            const key = `isbn:${vol.isbn}`;
            const targetUri = redirects[key] || (entities[key] ? key : undefined);
            if (targetUri && entities[targetUri]) {
              remoteByIsbn.set(vol.isbn, { editionUri: targetUri, entity: entities[targetUri], entitiesMap: entities });
            }
          }
        }
      } catch (e) {
        console.warn('[BG CREATION] Erreur vérification groupée des ISBNs :', e);
      }
    }

    status.value = {
      ...status.value,
      stepLabel: `Enrichissement de la série « ${seriesName} »`,
      current: 0,
      total: missingCandidates.length
    };

    for (let idx = 0; idx < missingCandidates.length; idx++) {
      if (connectionState.isOffline.value) break;

      const vol = missingCandidates[idx];
      status.value = {
        ...status.value,
        current: idx + 1,
        total: missingCandidates.length,
        stepLabel: `Série « ${seriesName} » (${idx + 1}/${missingCandidates.length}) : ${vol.title}`
      };

      try {
        const existingRemote = remoteByIsbn.get(vol.isbn);
        if (existingRemote) {
          // L'édition existe déjà sur inventaire.io : on l'attache à la série si besoin, sans créer de doublon
          const edEntity = existingRemote.entity;
          const workClaim = edEntity.claims?.['wdt:P629']?.[0];
          const existingWorkUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;

          if (existingWorkUri && existingWorkUri.startsWith('inv:')) {
            const workEnt = existingRemote.entitiesMap[existingWorkUri];
            const existingSeries = workEnt?.claims?.['wdt:P179']?.[0];
            if (existingSeries !== seriesUri) {
              await inventaireSyncService
                .updateClaim(existingWorkUri, 'wdt:P179', existingSeries || undefined, seriesUri)
                .catch(() => {});
              if (vol.seriesNumber && !workEnt?.claims?.['wdt:P1545']?.[0]) {
                await inventaireSyncService
                  .updateClaim(existingWorkUri, 'wdt:P1545', undefined, vol.seriesNumber)
                  .catch(() => {});
              }
            }
          }

          const existingLocal = await databaseService.getBookFromCache(existingRemote.editionUri);
          const volIsbn13 = vol.isbn.length === 13 ? vol.isbn : isbnUtil.toIsbn13(vol.isbn);
          const volFallbacks = imageUtil.buildCoverCandidates(volIsbn13, [existingLocal?.coverUrl, vol.coverUrl]);
          await databaseService.saveBookToCache({
            ...(existingLocal || {}),
            uri: existingRemote.editionUri,
            workUri: existingWorkUri || existingLocal?.workUri,
            isbn13: vol.isbn.length === 13 ? vol.isbn : existingLocal?.isbn13,
            isbn10: vol.isbn.length === 10 ? vol.isbn : existingLocal?.isbn10,
            type: 'edition',
            title: vol.title || existingLocal?.title || '',
            authors: vol.authors.length > 0 ? vol.authors : (existingLocal?.authors || []),
            illustrators: existingLocal?.illustrators || [],
            scriptwriters: existingLocal?.scriptwriters || [],
            publisher: vol.publisher || existingLocal?.publisher,
            publishDate: vol.publishDate || existingLocal?.publishDate,
            pageCount: vol.pageCount || existingLocal?.pageCount,
            coverUrl: existingLocal?.coverUrl || vol.coverUrl || volFallbacks[0],
            ...(volFallbacks.length ? { coverFallbackUrls: volFallbacks } : {}),
            genres: existingLocal?.genres || [],
            series: seriesName,
            seriesId: seriesUri,
            seriesNumber: vol.seriesNumber || existingLocal?.seriesNumber,
            ownershipStatus: existingLocal?.ownershipStatus || 'none'
          });
        } else {
          // Résolution des auteurs (en réutilisant en priorité ceux déjà résolus pour la série)
          const authorUris: string[] = [];
          const volAuthors = vol.authors.length > 0 ? vol.authors : seedBook.authors;
          for (const authorName of volAuthors) {
            if (!authorName?.trim()) continue;
            const normAuthor = normalizeTextKey(authorName);
            let aUri = knownAuthorMap.get(normAuthor);
            if (!aUri) {
              aUri = await inventaireSyncService.resolveOrCreateAuthor(authorName);
              if (aUri) knownAuthorMap.set(normAuthor, aUri);
            }
            if (aUri && !authorUris.includes(aUri)) authorUris.push(aUri);
          }

          // Vérification rapide si l'œuvre existe déjà dans cette série avant création
          let volumeWorkUri = await inventaireSyncService.searchEntity(vol.title, 'works');
          if (volumeWorkUri) {
            try {
              const wRes = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(volumeWorkUri)}`);
              if (wRes.ok) {
                const wJson = await wRes.json();
                const wEntity = wJson.entities?.[volumeWorkUri];
                const wSeries = wEntity?.claims?.['wdt:P179']?.[0];
                if (wSeries && wSeries !== seriesUri) {
                  volumeWorkUri = null; // Œuvre homonyme d'une autre série
                } else if (!wSeries && volumeWorkUri.startsWith('inv:')) {
                  await inventaireSyncService.updateClaim(volumeWorkUri, 'wdt:P179', undefined, seriesUri).catch(() => {});
                  if (vol.seriesNumber && !wEntity?.claims?.['wdt:P1545']?.[0]) {
                    await inventaireSyncService.updateClaim(volumeWorkUri, 'wdt:P1545', undefined, vol.seriesNumber).catch(() => {});
                  }
                }
              }
            } catch {
              volumeWorkUri = null;
            }
          }

          if (!volumeWorkUri) {
            const workClaims: Record<string, any> = {
              'wdt:P31': ['wd:Q47461344'],
              'wdt:P179': [seriesUri]
            };
            if (vol.seriesNumber) {
              workClaims['wdt:P1545'] = [vol.seriesNumber];
            }
            if (authorUris.length > 0) {
              workClaims['wdt:P50'] = authorUris;
            }
            volumeWorkUri = await inventaireSyncService.createEntity('work', vol.title, workClaims);
          }

          const isbn13 = vol.isbn.length === 13 ? vol.isbn : isbnUtil.toIsbn13(vol.isbn);
          const volFallbacks = imageUtil.buildCoverCandidates(isbn13, [vol.coverUrl]);
          const editionClaims: Record<string, any> = {
            'wdt:P31': ['wd:Q3331189'],
            'wdt:P629': [volumeWorkUri],
            'wdt:P407': ['wd:Q150'],
            'wdt:P1476': [vol.title],
            'wdt:P212': [isbn13]
          };
          if (vol.publishDate) {
            editionClaims['wdt:P577'] = [vol.publishDate];
          }
          if (vol.pageCount && Number.isFinite(vol.pageCount)) {
            editionClaims['wdt:P1104'] = [vol.pageCount];
          }
          if (vol.coverUrl) {
            editionClaims['invp:P2'] = [vol.coverUrl];
          }

          const editionUri = await inventaireSyncService.createEntity('edition', vol.title, editionClaims, {
            publisher: vol.publisher,
            genres: seedBook.genres
          });

          await databaseService.saveBookToCache({
            uri: editionUri,
            workUri: volumeWorkUri,
            isbn13,
            type: 'edition',
            title: vol.title,
            authors: volAuthors,
            illustrators: [],
            scriptwriters: [],
            publisher: vol.publisher,
            publishDate: vol.publishDate,
            pageCount: vol.pageCount,
            coverUrl: vol.coverUrl || volFallbacks[0],
            ...(volFallbacks.length ? { coverFallbackUrls: volFallbacks } : {}),
            genres: [],
            series: seriesName,
            seriesId: seriesUri,
            seriesNumber: vol.seriesNumber,
            ownershipStatus: 'none'
          });
        }

        knownIsbns.add(vol.isbn);
        if (vol.seriesNumber) {
          const normNum = normalizeSeriesNumber(vol.seriesNumber);
          if (normNum) knownVolumeNums.add(normNum);
        }
        knownNormalizedTitles.push(normalizeTextKey(vol.title));
        status.value = { ...status.value, lastCompletedAt: Date.now() };
      } catch (volErr) {
        console.warn(`[BG CREATION] Échec création du tome « ${vol.title} » :`, volErr);
      }

      if (idx < missingCandidates.length - 1) {
        await sleep(CREATION_PACING_MS);
      }
    }
  }
};
