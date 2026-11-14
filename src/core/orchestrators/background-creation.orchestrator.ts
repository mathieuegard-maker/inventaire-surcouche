// src/core/orchestrators/background-creation.orchestrator.ts
import { ref } from 'vue';
import { databaseService, type PendingCreation } from '../database/database.service';
import { inventaireSyncService } from '../services/inventaire-sync.service';
import { inventoryService } from '../services/inventory.service';
import { bookCacheService } from '../services/book-cache.service';
import { bnfResolver, normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import { getLevenshteinDistance } from '../utils/string.util';
import { isbnUtil } from '../utils/isbn.util';
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
  }): Promise<HumanizedBook> {
    const {
      tempBook,
      resolvedSeriesUri,
      resolvedAuthorUris = {},
      expandSeries = true
    } = params;

    // 1. Pré-attachement local si la série existe déjà en cache IndexedDB
    let effectiveSeriesUri = resolvedSeriesUri;
    if (!effectiveSeriesUri && tempBook.series?.trim()) {
      const localMatches = await databaseService.findLocalSeriesMatches(tempBook.series);
      const existingSeriesId = localMatches.find(b => b.seriesId && !b.seriesId.startsWith('local:'))?.seriesId;
      if (existingSeriesId) {
        effectiveSeriesUri = existingSeriesId;
      }
    }

    const optimisticBook: HumanizedBook = {
      ...tempBook,
      seriesId: effectiveSeriesUri || tempBook.seriesId,
      ownershipStatus: 'owned'
    };

    // 2. Persistance immédiate dans IndexedDB + registre d'inventaire
    await databaseService.saveBookToCache(optimisticBook);
    await databaseService.addRegistryEntry('inventory', optimisticBook.uri);

    // Mise en cache image en non-bloquant
    if (optimisticBook.coverUrl) {
      bookCacheService.saveAndProcessImage(optimisticBook, 'owned').catch(() => {});
    }

    // 3. Ajout dans la file persistante de création distante
    await databaseService.savePendingCreation({
      tempBook: optimisticBook,
      resolvedSeriesUri: effectiveSeriesUri,
      resolvedAuthorUris,
      expandSeries,
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
          stepLabel: `Création sur inventaire.io : « ${nextJob.tempBook.title} »`,
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
            lastSuccessMsg: `« ${nextJob.tempBook.title} » synchronisé sur inventaire.io`
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

    // 1. Création / liaison de l'ouvrage principal sur inventaire.io
    const syncResult = await inventaireSyncService.syncBookToInventaire(
      tempBook,
      job.resolvedSeriesUri,
      job.resolvedAuthorUris
    );

    // 2. Ajout à l'inventaire personnel
    await inventoryService.addToLibrary(syncResult.editionUri);

    const finalBook: HumanizedBook = {
      ...tempBook,
      uri: syncResult.editionUri,
      workUri: syncResult.workUri,
      seriesId: syncResult.seriesUri || tempBook.seriesId,
      ownershipStatus: 'owned'
    };

    // 3. Remplacement atomique isbn:... -> inv:... en base locale
    const savedBook = await databaseService.replaceBookUri(tempBook.uri, finalBook);
    if (savedBook.coverUrl && !savedBook.localCover) {
      bookCacheService.saveAndProcessImage(savedBook, 'owned').catch(() => {});
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
      if (!normNum && isTitleAlreadyKnown(vol.title)) continue;
      if (normNum && isTitleAlreadyKnown(vol.title) && knownNormalizedTitles.length > 0 && !knownVolumeNums.size) continue;

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
      stepLabel: `Création de la série « ${seriesName} » sur inventaire.io`,
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
            coverUrl: existingLocal?.coverUrl || vol.coverUrl,
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

          const editionUri = await inventaireSyncService.createEntity('edition', vol.title, editionClaims);

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
            coverUrl: vol.coverUrl,
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
