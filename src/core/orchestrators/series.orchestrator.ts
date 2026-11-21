// src/core/orchestrators/series.orchestrator.ts
import { ref, computed } from 'vue';
import { databaseService } from '../database/database.service';
import { normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import { syncOrchestrator } from './sync.orchestrator';
import type { SeriesContext, HumanizedBook } from '../types';

export interface HydrationProgress {
  current: number;
  total: number;
  isActive: boolean;
}

// Registre réactif global partagé pour suivre la progression à travers les vues
const progressRegistry = ref<Record<string, HydrationProgress>>({});

export const seriesOrchestrator = {
  /**
   * Fournit l'accès à l'état réactif de téléchargement d'une saga pour l'UI
   */
  getProgress(seriesId: string) {
    if (!progressRegistry.value[seriesId]) {
      progressRegistry.value[seriesId] = { current: 0, total: 0, isActive: false };
    }
    return computed(() => progressRegistry.value[seriesId]);
  },

  /**
   * Déclenche le téléchargement de fond asynchrone de manière étanche
   */
  startBackgroundHydration(seriesId: string): void {
    if (!seriesId) return;
    if (progressRegistry.value[seriesId]?.isActive) return;

    progressRegistry.value[seriesId] = { current: 0, total: 0, isActive: true };
    console.log(`[SERIES ORCHESTRATOR] 🚀 Aspiration asynchrone lancée pour la série : ${seriesId}`);

    // Transmission sécurisée du callback bi-argument résolu au niveau de syncOrchestrator
    syncOrchestrator.hydrateSeriesInBackground(seriesId, (current: number, total: number) => {
      if (progressRegistry.value[seriesId]) {
        progressRegistry.value[seriesId].current = current;
        progressRegistry.value[seriesId].total = total;
      }
    }).then(() => {
      if (progressRegistry.value[seriesId]) {
        progressRegistry.value[seriesId].isActive = false;
        console.log(`[SERIES ORCHESTRATOR] ✅ Tâche de fond complétée pour ${seriesId}`);
      }
    }).catch((err) => {
      console.error(`[SERIES ORCHESTRATOR] 💥 Échec tâche de fond pour ${seriesId} :`, err);
      if (progressRegistry.value[seriesId]) {
        progressRegistry.value[seriesId].isActive = false;
      }
    });
  },

  /**
   * Construit le contexte complet d'une série pour l'interface utilisateur.
   * Nettoyé de tout blocage synchrone pour du Local-First pur et instantané.
   */
  async getCompleteSeriesForUI(seriesId: string, seriesName?: string): Promise<SeriesContext | undefined> {
    if (!seriesId) return undefined;

    console.group(`[SERIES ORCHESTRATOR] Analyse de la saga : ${seriesId}`);

    // 1. Extraction rapide depuis le cache local (Local-First)
    const tomes: HumanizedBook[] = await databaseService.getBooksBySeriesId(seriesId);
    console.log(`[SERIES ORCHESTRATOR] Tomes trouvés en cache local : ${tomes.length}`);

    // 2. Couplage des registres (Inventaire, Wishlist, Prêts)
    for (const tome of tomes) {
      const isInInventory = await databaseService.isUriInRegistry('inventory', tome.uri) || 
                            (tome.workUri ? await databaseService.isUriInRegistry('inventory', tome.workUri) : false);
      
      if (isInInventory) {
        tome.ownershipStatus = 'owned';
        const activeLoan = await databaseService.getLoan(tome.uri);
        if (activeLoan) {
          tome.loan = activeLoan;
        }
      } else {
        const isInWishlist = await databaseService.isUriInRegistry('wishlist', tome.uri) || 
                             (tome.workUri ? await databaseService.isUriInRegistry('wishlist', tome.workUri) : false);
        if (isInWishlist) {
          tome.ownershipStatus = 'wish';
        } else {
          tome.ownershipStatus = 'none';
        }
      }
    }

    // 2B. Déduplication par Œuvre dans la série (même workUri, même n° de tome ou même titre normalisé)
    // Priorité : owned > wish > none, tout en fusionnant numéro de tome, couvertures et knownIsbns
    const statusWeight = (s?: string) => (s === 'owned' ? 3 : s === 'wish' ? 2 : 1);
    const sortedForDedup = [...tomes].sort((a, b) => {
      const diff = statusWeight(b.ownershipStatus) - statusWeight(a.ownershipStatus);
      if (diff !== 0) return diff;
      const aCover = a.localCover || a.coverUrl ? 1 : 0;
      const bCover = b.localCover || b.coverUrl ? 1 : 0;
      if (bCover !== aCover) return bCover - aCover;
      return (b.seriesNumber ? 1 : 0) - (a.seriesNumber ? 1 : 0);
    });

    const mergedTomes: HumanizedBook[] = [];
    const seenWorkKeys = new Map<string, HumanizedBook>();
    const registerKeys = (b: HumanizedBook, target: HumanizedBook) => {
      if (b.workUri) seenWorkKeys.set(`work:${b.workUri}`, target);
      const normNum = b.seriesNumber ? normalizeSeriesNumber(b.seriesNumber) : '';
      if (normNum) seenWorkKeys.set(`num:${normNum}`, target);
      const normTitle = b.title ? normalizeTextKey(b.title) : '';
      // N'indexe par titre générique que s'il n'y a PAS de numéro de tome explicite ni de mélange Intégrale / Tome
      if (normTitle.length >= 3 && !normNum && !b.isIntegral) {
        seenWorkKeys.set(`title:${normTitle}`, target);
      }
    };

    for (const tome of sortedForDedup) {
      const normNum = tome.seriesNumber ? normalizeSeriesNumber(tome.seriesNumber) : '';
      const normTitle = tome.title ? normalizeTextKey(tome.title) : '';
      const titleMatch =
        normTitle.length >= 3 && !normNum && !tome.isIntegral
          ? seenWorkKeys.get(`title:${normTitle}`)
          : undefined;
      const existing =
        (tome.workUri ? seenWorkKeys.get(`work:${tome.workUri}`) : undefined) ||
        (normNum ? seenWorkKeys.get(`num:${normNum}`) : undefined) ||
        titleMatch;

      if (existing) {
        if (!existing.seriesNumber && tome.seriesNumber) existing.seriesNumber = tome.seriesNumber;
        if (!existing.localCover && tome.localCover) existing.localCover = tome.localCover;
        if (!existing.coverUrl && tome.coverUrl) existing.coverUrl = tome.coverUrl;
        const extraFallbacks = [tome.coverUrl, ...(tome.coverFallbackUrls || [])].filter(
          (u): u is string => Boolean(u)
        );
        if (extraFallbacks.length > 0) {
          existing.coverFallbackUrls = Array.from(
            new Set([...(existing.coverFallbackUrls || []), ...extraFallbacks])
          );
        }
        const mergedIsbns = new Set<string>([
          ...(existing.knownIsbns || []),
          ...(existing.isbn13 ? [existing.isbn13] : []),
          ...(tome.isbn13 ? [tome.isbn13] : []),
          ...(tome.knownIsbns || [])
        ]);
        if (mergedIsbns.size > 0) existing.knownIsbns = Array.from(mergedIsbns);
        registerKeys(tome, existing);
        continue;
      }

      const clone: HumanizedBook = { ...tome };
      mergedTomes.push(clone);
      registerKeys(clone, clone);
    }

    // 2C. Propagation de possession depuis les Intégrales possédées vers les tomes unitaires inclus
    const ownedIntegralByVol = new Map<string, { integralBookId: string; title: string; isbn13: string }>();
    for (const tome of mergedTomes) {
      if (tome.isIntegral && tome.ownershipStatus === 'owned') {
        const incVols = tome.integralMetadata?.includedVolumeNumbers || [];
        for (const rawV of incVols) {
          const normV = normalizeSeriesNumber(String(rawV));
          if (normV) {
            ownedIntegralByVol.set(normV, {
              integralBookId: tome.bookId || tome.uri,
              title: tome.title,
              isbn13: tome.isbn13 || ''
            });
          }
        }
      }
    }
    if (ownedIntegralByVol.size > 0) {
      for (const tome of mergedTomes) {
        if (tome.isIntegral || tome.ownershipStatus === 'owned') continue;
        const normV = tome.seriesNumber ? normalizeSeriesNumber(tome.seriesNumber) : '';
        const covering = normV ? ownedIntegralByVol.get(normV) : undefined;
        if (covering) {
          tome.ownershipStatus = 'owned';
          const existingParents = tome.parentIntegrals || [];
          if (!existingParents.some((p) => p.integralBookId === covering.integralBookId)) {
            tome.parentIntegrals = [...existingParents, covering];
          }
        }
      }
    }

    // 3. Tri numérique robuste (Tomes numérotés 1, 2... puis Hors-Séries HS1, HS2... puis Intégrales / non-numérotés)
    const getSortWeight = (vol?: string): number => {
      if (!vol) return 9999;
      const trimmed = vol.trim();
      const numMatch = /^(\d+(?:\.\d+)?)/.exec(trimmed);
      if (numMatch) return parseFloat(numMatch[1]);
      const hsMatch = /hs\s*(\d+)?/i.exec(trimmed);
      if (hsMatch) return 5000 + (hsMatch[1] ? parseInt(hsMatch[1], 10) : 0);
      return 8000;
    };
    mergedTomes.sort((a, b) => {
      const diff = getSortWeight(a.seriesNumber) - getSortWeight(b.seriesNumber);
      return diff !== 0 ? diff : (a.title || '').localeCompare(b.title || '', 'fr');
    });
    
    // 4. Calcul des métadonnées de possession
    const ownedCount = mergedTomes.filter(t => t.ownershipStatus === 'owned').length;

    console.groupEnd();

    // 5. Envoi du paquet complet standardisé à la vue
    return {
      id: seriesId,
      name: seriesName || (mergedTomes.length > 0 ? mergedTomes[0].series : undefined),
      tomes: mergedTomes,
      ownedCount: ownedCount,
      isComplete: mergedTomes.length > 0 && ownedCount === mergedTomes.length
    };
  }
};