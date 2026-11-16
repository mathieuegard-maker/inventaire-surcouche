<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { scannerState } from '../../state/scanner';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import { inventoryService } from '../../core/services/inventory.service';
import { wishlistService } from '../../core/services/wishlist.service';
import {
  byokVisionService,
  type ByokProvider
} from '../../core/services/byok-vision.service';
import {
  type ResolvedPhotoItem,
  type PhotoResolutionOption
} from '../../core/services/photo-book-resolution.service';
import { photoBatchQueueService } from '../../core/services/photo-batch-queue.service';
import { normalizeTextKey } from '../../core/resolvers/bnf.resolver';
import { imageUtil } from '../../core/utils/image.util';
import BookMiniCard from './BookMiniCard.vue';
import WireframeTable from './WireframeTable.vue';
import BatchActionBar from './BatchActionBar.vue';
import LendModal from './LendModal.vue';
import { useModalScrollable } from '../composables/useModalScrollable';
import type { HumanizedBook } from '../../core/types';

const router = useRouter();

const activeMode = computed(() => scannerState.activeMode.value);
const burstBooks = computed(() => scannerState.burstBooks.value);
const burstSelectedUris = ref<string[]>([]);
const showBurstLendModal = ref(false);
const burstFeedback = ref('');
const modalCardRef = ref<HTMLElement | null>(null);

// Fermer automatiquement la fenêtre scanner si l'utilisateur ouvre une fiche livre depuis la liste rafale
watch(
  () => router.currentRoute.value.fullPath,
  () => {
    if (scannerState.isScanningActive.value && activeMode.value !== 'photo') {
      scannerState.stopScan();
    }
  }
);

const isAllBurstSelected = computed(
  () => burstBooks.value.length > 0 && burstSelectedUris.value.length === burstBooks.value.length
);

const toggleAllBurst = (checked: boolean) => {
  burstSelectedUris.value = checked ? burstBooks.value.map((b) => b.uri) : [];
};

const selectedBurstBooks = computed(() =>
  burstBooks.value.filter((b) => burstSelectedUris.value.includes(b.uri))
);

const burstBatchState = computed(() => {
  const sel = selectedBurstBooks.value;
  if (sel.length === 0) return { isMixed: false, context: 'unowned' as const };
  const buckets = new Set(
    sel.map((b) => {
      if (b.loan) return 'lent';
      if (b.ownershipStatus === 'owned') return 'owned';
      if (b.ownershipStatus === 'wish') return 'wishlist';
      return 'unowned';
    })
  );
  if (buckets.size > 1) return { isMixed: true, context: 'unowned' as const };
  const sole = Array.from(buckets)[0] as 'lent' | 'owned' | 'wishlist' | 'unowned';
  return { isMixed: false, context: sole };
});

const dispatchBurstBatchAction = async (
  action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE'
) => {
  if (selectedBurstBooks.value.length === 0) return;
  if (action === 'LEND') {
    showBurstLendModal.value = true;
    return;
  }

  let processed = 0;
  for (const book of selectedBurstBooks.value) {
    if (action === 'DELETE') {
      if (book.ownershipStatus === 'owned') {
        await inventoryService.removeFromLibrary(book.uri);
      } else if (book.ownershipStatus === 'wish') {
        await wishlistService.removeFromWishlist([book.uri]);
      }
      book.ownershipStatus = 'none';
      if (book.loan) delete book.loan;
      processed++;
      continue;
    }

    if (action === 'RETURN') {
      await queueService.enqueueAction('RETURN', book.uri);
      if (book.loan) delete book.loan;
      processed++;
      continue;
    }

    if (action === 'ADD_INVENTORY' || action === 'ADD_WISHLIST') {
      const targetStatus = action === 'ADD_INVENTORY' ? 'owned' : 'wish';
      if (book.uri.startsWith('isbn:')) {
        await backgroundCreationOrchestrator.enqueueBookCreation({
          tempBook: { ...book, ownershipStatus: targetStatus },
          expandSeries: Boolean(book.series)
        });
      } else {
        await queueService.enqueueAction(action, book.uri);
      }
      book.ownershipStatus = targetStatus;
      processed++;
    }
  }

  scannerState.notifyCatalogChanged();
  burstSelectedUris.value = [];
  burstFeedback.value = `Action appliquée sur ${processed} livre(s).`;
  setTimeout(() => {
    burstFeedback.value = '';
  }, 3000);
};

const confirmBurstGroupLend = async (friendName: string) => {
  for (const book of selectedBurstBooks.value) {
    if (!book.uri.startsWith('isbn:')) {
      await queueService.enqueueAction('LEND', book.uri, { friendName });
      book.loan = { uri: book.uri, friendName, loanDate: Date.now() };
    }
  }
  scannerState.notifyCatalogChanged();
  burstSelectedUris.value = [];
  showBurstLendModal.value = false;
  burstFeedback.value = `Prêt enregistré pour ${friendName}.`;
  setTimeout(() => {
    burstFeedback.value = '';
  }, 3000);
};

// ============================================================================
// MODE 3 : PHOTO COUVERTURE / ÉTAGÈRE (BYOK + VALIDATION LIVRE PAR LIVRE)
// ============================================================================
const existingByok = byokVisionService.getSettings();
const byokProvider = ref<ByokProvider>(existingByok?.provider || 'gemini');
const byokKey = ref<string>(existingByok?.apiKey || '');
const showByokSetup = ref<boolean>(!existingByok?.apiKey);
const byokTestStatus = ref<{ ok?: boolean; message: string } | null>(null);
const isTestingKey = ref(false);

const photoStats = photoBatchQueueService.stats;
const isPhotoProcessing = photoBatchQueueService.isProcessing;
const photoLoadingStatus = photoBatchQueueService.currentStatusMessage;
const photoError = ref('');
const resolvedDetectedItems = ref<ResolvedPhotoItem[]>([]);
const doubtItems = ref<ResolvedPhotoItem[]>([]);
const unresolvedItems = ref<ResolvedPhotoItem[]>([]);
const seriesExtraItems = ref<ResolvedPhotoItem[]>([]);
const detectedSeriesNames = ref<string[]>([]);
const retryingItemId = ref<string | null>(null);
const photoTargetStatus = ref<'owned' | 'wish'>('owned');
const seriesExtraTarget = ref<'none' | 'wish' | 'owned'>('none');
const expandedSeriesKeys = ref<Record<string, boolean>>({});
const photoSavingFeedback = ref('');

function syncValidationFromQueue() {
  const agg = photoBatchQueueService.getAggregatedResults();

  const knownResolvedIds = new Set(resolvedDetectedItems.value.map((i) => i.id));
  const knownResolvedIsbns = new Set(resolvedDetectedItems.value.map((i) => i.isbn13).filter(Boolean));
  for (const item of agg.sureItems) {
    if (knownResolvedIds.has(item.id) || (item.isbn13 && knownResolvedIsbns.has(item.isbn13))) continue;
    resolvedDetectedItems.value.push(JSON.parse(JSON.stringify(item)));
    knownResolvedIds.add(item.id);
    if (item.isbn13) knownResolvedIsbns.add(item.isbn13);
  }

  const knownDoubtIds = new Set(doubtItems.value.map((i) => i.id));
  for (const d of agg.doubtItems) {
    if (!knownDoubtIds.has(d.id)) {
      doubtItems.value.push(JSON.parse(JSON.stringify(d)));
      knownDoubtIds.add(d.id);
    }
  }

  const knownUnresolvedIds = new Set(unresolvedItems.value.map((i) => i.id));
  for (const u of agg.unresolvedItems) {
    if (!knownUnresolvedIds.has(u.id)) {
      unresolvedItems.value.push(JSON.parse(JSON.stringify(u)));
      knownUnresolvedIds.add(u.id);
    }
  }

  const knownExtraIsbns = new Set(seriesExtraItems.value.map((i) => i.isbn13).filter(Boolean));
  for (const e of agg.seriesExtraItems) {
    if (e.isbn13 && (knownResolvedIsbns.has(e.isbn13) || knownExtraIsbns.has(e.isbn13))) continue;
    seriesExtraItems.value.push(JSON.parse(JSON.stringify(e)));
    if (e.isbn13) knownExtraIsbns.add(e.isbn13);
  }

  const knownSeriesKeys = new Set(detectedSeriesNames.value.map((s) => normalizeTextKey(s)));
  for (const sName of agg.detectedSeriesNames) {
    const sk = normalizeTextKey(sName);
    if (sk && !knownSeriesKeys.has(sk)) {
      detectedSeriesNames.value.push(sName);
      knownSeriesKeys.add(sk);
    }
  }
}

watch(
  () => photoBatchQueueService.jobs.value,
  () => {
    syncValidationFromQueue();
  },
  { deep: true, immediate: true }
);

function selectDoubtOption(item: ResolvedPhotoItem, option: PhotoResolutionOption | null) {
  if (!option) {
    item.selectedAlternativeIsbn = '__ignore__';
    item.selected = false;
    return;
  }
  item.selectedAlternativeIsbn = option.isbn13;
  item.isbn13 = option.isbn13;
  item.title = option.title;
  item.authors = option.authors;
  item.publisher = option.publisher;
  item.publishDate = option.publishDate;
  item.pageCount = option.pageCount;
  item.coverUrl = option.coverUrl;
  item.coverFallbackUrls = option.coverFallbackUrls;
  item.series = option.series;
  item.seriesNumber = option.seriesNumber;
  item.selected = true;
}

async function handleSaveAndTestByok() {
  isTestingKey.value = true;
  byokTestStatus.value = null;
  const res = await byokVisionService.testKey({
    provider: byokProvider.value,
    apiKey: byokKey.value
  });
  isTestingKey.value = false;
  byokTestStatus.value = res;
  if (res.ok) {
    byokVisionService.saveSettings({
      provider: byokProvider.value,
      apiKey: byokKey.value
    });
    setTimeout(() => {
      showByokSetup.value = false;
    }, 900);
  }
}

async function handlePhotoSelected(event: Event, mode: 'cover' | 'shelf') {
  const input = event.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length === 0) return;

  photoError.value = '';
  try {
    if (!byokVisionService.getSettings()) {
      throw new Error("Aucune clé API configurée. Configurez votre clé gratuite ci-dessus.");
    }
    const count = await photoBatchQueueService.enqueuePhotos(files, mode);
    photoSavingFeedback.value = `${count} photo(s) ajoutée(s) à la file ! Vous pouvez continuer à prendre d'autres photos pendant le traitement en arrière-fond.`;
    setTimeout(() => {
      photoSavingFeedback.value = '';
    }, 4500);
  } catch (err: unknown) {
    photoError.value = err instanceof Error ? err.message : "Erreur lors de l'ajout des photos.";
  } finally {
    input.value = '';
  }
}

async function retryUnresolvedItem(item: ResolvedPhotoItem) {
  if (!item.rawCandidate.title.trim() && !item.rawCandidate.isbn?.trim() && !item.rawCandidate.series?.trim()) return;
  retryingItemId.value = item.id;
  try {
    const resolved = await photoBookResolutionService.resolveSingleCandidate(item.rawCandidate, 'retry');
    if (resolved.status === 'unresolved') {
      item.failureReason = resolved.failureReason || 'Toujours introuvable sur la BnF / Google Books.';
      return;
    }

    unresolvedItems.value = unresolvedItems.value.filter((u) => u.id !== item.id);
    if (resolved.status === 'doubt') {
      doubtItems.value.push(resolved);
      return;
    }

    const alreadyExists = resolved.isbn13 && resolvedDetectedItems.value.some((d) => d.isbn13 === resolved.isbn13);
    if (!alreadyExists) {
      resolvedDetectedItems.value.push(resolved);
    }

    // Si une nouvelle série est découverte, proposer aussi ses autres tomes dans la liste finale
    if (resolved.series?.trim()) {
      const sKey = normalizeTextKey(resolved.series);
      const alreadyHasSeries = detectedSeriesNames.value.some((s) => normalizeTextKey(s) === sKey);
      if (!alreadyHasSeries) {
        const batch = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
          resolved.rawCandidate
        ]);
        const existingIsbns = new Set([
          ...resolvedDetectedItems.value.map((d) => d.isbn13).filter(Boolean),
          ...seriesExtraItems.value.map((e) => e.isbn13).filter(Boolean)
        ]);
        for (const extra of batch.seriesExtraItems) {
          if (extra.isbn13 && !existingIsbns.has(extra.isbn13)) {
            seriesExtraItems.value.push(extra);
            existingIsbns.add(extra.isbn13);
          }
        }
        detectedSeriesNames.value.push(...batch.detectedSeriesNames);
      }
    }
  } finally {
    retryingItemId.value = null;
  }
}

function toggleSeriesAccordion(seriesKey: string) {
  expandedSeriesKeys.value = {
    ...expandedSeriesKeys.value,
    [seriesKey]: !expandedSeriesKeys.value[seriesKey]
  };
}

function toggleGroupSeriesExtras(seriesKey: string, selectAll: boolean) {
  for (const item of seriesExtraItems.value) {
    const key = normalizeTextKey(item.series || 'Autres');
    if (key === seriesKey && !item.alreadyOwned) {
      item.selected = selectAll;
    }
  }
}

function toggleAllSeriesExtras(selectAll: boolean) {
  for (const item of seriesExtraItems.value) {
    if (!item.alreadyOwned) {
      item.selected = selectAll;
    }
  }
}

const groupedSeriesExtras = computed(() => {
  const map = new Map<string, { seriesKey: string; seriesName: string; items: ResolvedPhotoItem[] }>();
  for (const item of seriesExtraItems.value) {
    const seriesName = item.series?.trim() || 'Autres';
    const seriesKey = normalizeTextKey(seriesName) || 'autres';
    const existing = map.get(seriesKey);
    if (existing) {
      existing.items.push(item);
    } else {
      map.set(seriesKey, { seriesKey, seriesName, items: [item] });
    }
  }
  return Array.from(map.values()).map((g) => ({
    ...g,
    selectedCount: g.items.filter((i) => i.selected).length
  }));
});

const selectedDoubtCount = computed(
  () =>
    doubtItems.value.filter(
      (c) => c.selected && c.isbn13 && c.selectedAlternativeIsbn !== '__ignore__'
    ).length
);

const selectedDetectedCount = computed(
  () => resolvedDetectedItems.value.filter((c) => c.selected).length + selectedDoubtCount.value
);

const selectedSeriesCount = computed(
  () => seriesExtraItems.value.filter((c) => c.selected).length
);

const totalSelectedToSave = computed(
  () => selectedDetectedCount.value + selectedSeriesCount.value
);

const { isScrollable } = useModalScrollable(modalCardRef, () => [
  scannerState.isScanningActive.value,
  activeMode.value,
  burstBooks.value.length,
  resolvedDetectedItems.value.length,
  doubtItems.value.length,
  unresolvedItems.value.length,
  seriesExtraItems.value.length,
  showByokSetup.value
]);

const photoItemToBook = (item: ResolvedPhotoItem): HumanizedBook => {
  const isbn = item.isbn13 || '';
  const coverFallbackUrls = imageUtil.buildCoverCandidates(isbn, [
    item.coverUrl,
    ...(item.coverFallbackUrls || [])
  ]);
  return {
    uri: item.existingUri || `isbn:${isbn || item.id}`,
    workUri: item.existingWorkUri,
    type: 'edition',
    isbn13: isbn || undefined,
    title: item.title,
    authors: item.authors.length ? item.authors : ['Auteur inconnu'],
    illustrators: [],
    scriptwriters: [],
    publisher: item.publisher || '',
    publishDate: item.publishDate,
    pageCount: item.pageCount,
    coverUrl: item.coverUrl || coverFallbackUrls[0],
    coverFallbackUrls,
    series: item.series,
    seriesNumber: item.seriesNumber,
    genres: [],
    ownershipStatus: item.alreadyOwned ? 'owned' : item.alreadyWished ? 'wish' : 'none'
  };
};

const getPhotoItemBadges = (item: ResolvedPhotoItem) => {
  const badges: Array<{ label: string; tone?: 'info' | 'consensus' | 'warn' }> = [];
  if (item.correctedFromAi) badges.push({ label: 'Corrigé BnF', tone: 'info' });
  if (item.sourcesCount && item.sourcesCount > 1) badges.push({ label: `${item.sourcesCount} sources`, tone: 'consensus' });
  if (!item.coverUrl) badges.push({ label: 'Sans couverture', tone: 'warn' });
  return badges;
};

const isAllPhotoDetectedSelected = computed(
  () => resolvedDetectedItems.value.length > 0 && resolvedDetectedItems.value.every((i) => i.selected)
);

const toggleAllPhotoDetected = (checked: boolean) => {
  for (const item of resolvedDetectedItems.value) {
    item.selected = checked;
  }
};

const allSelectedPhotoItems = computed(() => {
  const sure = resolvedDetectedItems.value.filter((c) => c.selected && c.isbn13);
  const doubts = doubtItems.value.filter(
    (c) => c.selected && c.isbn13 && c.selectedAlternativeIsbn !== '__ignore__'
  );
  const extras = seriesExtraItems.value.filter((c) => c.selected && c.isbn13);
  return [...sure, ...doubts, ...extras];
});

const selectedPhotoBooks = computed(() =>
  allSelectedPhotoItems.value.map((item) => photoItemToBook(item))
);

const clearPhotoSelections = () => {
  for (const i of resolvedDetectedItems.value) i.selected = false;
  for (const d of doubtItems.value) d.selected = false;
  for (const e of seriesExtraItems.value) e.selected = false;
};

const dispatchPhotoBatchAction = async (
  action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE'
) => {
  const target: 'owned' | 'wish' = action === 'ADD_WISHLIST' ? 'wish' : 'owned';
  const itemsToSave = allSelectedPhotoItems.value;
  if (itemsToSave.length === 0) return;

  const processedIsbns = new Set<string>();
  let savedCount = 0;
  for (const item of itemsToSave) {
    if (!item.isbn13 || processedIsbns.has(item.isbn13)) continue;
    processedIsbns.add(item.isbn13);
    await enqueueResolvedItem(item, target);
    savedCount++;
  }

  // Retirer uniquement les éléments validés tout en préservant les éventuels restants/doutes non cochés
  const savedSet = new Set(itemsToSave.map((i) => i.id));
  resolvedDetectedItems.value = resolvedDetectedItems.value.filter((i) => !savedSet.has(i.id));
  doubtItems.value = doubtItems.value.filter((d) => !savedSet.has(d.id));
  seriesExtraItems.value = seriesExtraItems.value.filter((e) => !savedSet.has(e.id));

  if (resolvedDetectedItems.value.length === 0 && doubtItems.value.length === 0 && unresolvedItems.value.length === 0) {
    await photoBatchQueueService.clearCompletedJobs();
  }
  scannerState.notifyCatalogChanged();
  photoSavingFeedback.value = `${savedCount} livre(s) ajouté(s) à ${target === 'owned' ? 'ma Collection' : 'ma Wishlist'} ✓`;
  setTimeout(() => {
    photoSavingFeedback.value = '';
  }, 4000);
};

async function enqueueResolvedItem(item: ResolvedPhotoItem, target: 'owned' | 'wish' | 'none') {
  if (!item.isbn13) return;

  if (item.existingUri && (target === 'owned' || target === 'wish')) {
    await queueService.enqueueAction(target === 'owned' ? 'ADD_INVENTORY' : 'ADD_WISHLIST', item.existingUri);
    return;
  }

  await backgroundCreationOrchestrator.enqueueBookCreation({
    tempBook: {
      uri: item.existingUri || `isbn:${item.isbn13}`,
      workUri: item.existingWorkUri,
      type: 'edition',
      isbn13: item.isbn13,
      title: item.title,
      authors: item.authors.length ? item.authors : ['Auteur inconnu'],
      illustrators: [],
      scriptwriters: [],
      publisher: item.publisher || '',
      publishDate: item.publishDate,
      pageCount: item.pageCount,
      coverUrl: item.coverUrl,
      series: item.series,
      seriesNumber: item.seriesNumber,
      genres: [],
      ownershipStatus: target
    },
    ownershipTarget: target,
    // Les tomes de la série sont déjà extraits et validés explicitement ci-dessous
    expandSeries: false
  });
}

async function confirmAndSaveCandidates() {
  const sureToSave = resolvedDetectedItems.value.filter((c) => c.selected && c.isbn13);
  const doubtsToSave = doubtItems.value.filter(
    (c) => c.selected && c.isbn13 && c.selectedAlternativeIsbn !== '__ignore__'
  );
  const detectedToSave = [...sureToSave, ...doubtsToSave];
  const extrasToSave = seriesExtraItems.value.filter((c) => c.selected && c.isbn13);
  if (!detectedToSave.length && !extrasToSave.length) return;

  const processedIsbns = new Set<string>();
  for (const item of detectedToSave) {
    if (!item.isbn13 || processedIsbns.has(item.isbn13)) continue;
    processedIsbns.add(item.isbn13);
    await enqueueResolvedItem(item, photoTargetStatus.value);
  }

  for (const extra of extrasToSave) {
    if (!extra.isbn13 || processedIsbns.has(extra.isbn13)) continue;
    processedIsbns.add(extra.isbn13);
    await enqueueResolvedItem(extra, seriesExtraTarget.value);
  }

  await photoBatchQueueService.clearCompletedJobs();
  scannerState.notifyCatalogChanged();
  photoSavingFeedback.value = `${detectedToSave.length} livre(s) + ${extrasToSave.length} tome(s) de série validé(s) et envoyé(s) dans le flux catalogue ✓`;
  resolvedDetectedItems.value = [];
  doubtItems.value = [];
  unresolvedItems.value = [];
  seriesExtraItems.value = [];
  detectedSeriesNames.value = [];
  setTimeout(() => {
    photoSavingFeedback.value = '';
  }, 4000);
}

async function clearPhotoQueueAndForm() {
  await photoBatchQueueService.clearAllJobs();
  resolvedDetectedItems.value = [];
  doubtItems.value = [];
  unresolvedItems.value = [];
  seriesExtraItems.value = [];
  detectedSeriesNames.value = [];
}
</script>

<template>
  <Teleport to="body">
    <div v-show="scannerState.isScanningActive.value" class="scanner-modal-backdrop" @click.self="scannerState.stopScan()">
      <div ref="modalCardRef" class="scanner-modal-card" role="dialog" aria-modal="true" aria-label="Scanner de livres">
      <!-- En-tête + Sélecteur 3 Modes sur une seule ligne (Simple / Rafale / Photo IA) -->
      <div class="scanner-header">
        <div class="mode-tabs" role="tablist" aria-label="Mode de numérisation">
          <button
            type="button"
            role="tab"
            :aria-selected="activeMode === 'simple'"
            class="mode-tab"
            :class="{ active: activeMode === 'simple' }"
            @click="scannerState.switchMode('simple')"
          >
            <span class="mode-tab-label">Simple</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activeMode === 'burst'"
            class="mode-tab"
            :class="{ active: activeMode === 'burst' }"
            @click="scannerState.switchMode('burst')"
          >
            <span class="mode-tab-label">Rafale</span>
            <span v-if="burstBooks.length > 0" class="tab-count-badge">{{ burstBooks.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activeMode === 'photo'"
            class="mode-tab"
            :class="{ active: activeMode === 'photo' }"
            @click="scannerState.switchMode('photo')"
          >
            <span class="mode-tab-label">Photo IA</span>
            <span v-if="photoStats.totalPhotos > 0" class="tab-count-badge">{{ photoStats.totalPhotos }}</span>
          </button>
        </div>
        <button type="button" class="close-scan-btn" aria-label="Fermer" @click="scannerState.stopScan()">
          ✕
        </button>
      </div>

      <!-- Petite explication sous les 3 boutons -->
      <p class="mode-hint-bar">
        <template v-if="activeMode === 'simple'">
          Scan simple : scanne un code-barres et ouvre directement sa fiche complète.
        </template>
        <template v-else-if="activeMode === 'burst'">
          Scan rafale : scannez plusieurs livres à la suite sans enregistrement auto, puis cochez les actions souhaitées ci-dessous.
        </template>
        <template v-else>
          Recherche par photo : photographiez une couverture, une pile ou une étagère (analyse IA en file d'attente).
        </template>
      </p>

      <!-- ================================================================ -->
      <!-- FLUX CAMÉRA CODE-BARRES (Simple ou Rafale)                       -->
      <!-- ================================================================ -->
      <div v-show="activeMode === 'simple' || activeMode === 'burst'" class="camera-section">
        <div
          class="scanner-viewport-container"
          :class="{ 'burst-compact-viewport': activeMode === 'burst' }"
        >
          <div id="global-barcode-scanner-viewport" class="scanner-viewport"></div>
          <div v-if="!scannerState.isSearching.value" class="scanner-placeholder">
            Ouverture de la caméra...
          </div>
          <div
            v-if="scannerState.burstFlashEvent.value"
            :key="scannerState.burstFlashEvent.value.id"
            :class="['burst-flash-overlay', scannerState.burstFlashEvent.value.status]"
            aria-hidden="true"
          ></div>
        </div>

        <div v-if="burstFeedback" class="quick-feedback">{{ burstFeedback }}</div>

        <!-- Liste à cocher type Ma Collection pour le Scan Rafale (aucun enregistrement auto) -->
        <div v-if="activeMode === 'burst' && burstBooks.length > 0" class="burst-checklist-panel">
          <div class="burst-history-header">
            <label style="display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 0.85rem; cursor: pointer;">
              <input
                type="checkbox"
                class="wireframe-checkbox"
                :checked="isAllBurstSelected"
                @change="toggleAllBurst(($event.target as HTMLInputElement).checked)"
              />
              <span>
                {{ burstSelectedUris.length === 0 ? `Tout cocher (${burstBooks.length})` : `${burstSelectedUris.length} sélectionné(s)` }}
              </span>
            </label>
            <button
              type="button"
              class="clear-btn"
              @click="() => { scannerState.clearBurstBooks(); burstSelectedUris = []; }"
            >
              Vider la liste
            </button>
          </div>

          <WireframeTable>
            <BookMiniCard
              v-for="livre in burstBooks"
              :key="livre.uri"
              :book="livre"
              :model-value="burstSelectedUris.includes(livre.uri)"
              @update:model-value="(val) => {
                if (val) {
                  if (!burstSelectedUris.includes(livre.uri)) burstSelectedUris.push(livre.uri);
                } else {
                  const idx = burstSelectedUris.indexOf(livre.uri);
                  if (idx > -1) burstSelectedUris.splice(idx, 1);
                }
              }"
            />
          </WireframeTable>

          <BatchActionBar
            :inline="true"
            :selected-count="burstSelectedUris.length"
            :selected-books="selectedBurstBooks"
            @execute="dispatchBurstBatchAction"
            @clear="burstSelectedUris = []"
          />
        </div>
      </div>

      <!-- ================================================================ -->
      <!-- MODE 3 : PHOTO COUVERTURE / ÉTAGÈRE (IA BYOK + VALIDATION)      -->
      <!-- ================================================================ -->
      <div v-if="activeMode === 'photo'" class="photo-mode-box">
        <div class="byok-header-bar">
          <span>
            Reconnaissance IA (0 € serveur) :
            <strong>{{ byokVisionService.getSettings() ? 'Clé active' : 'À configurer' }}</strong>
          </span>
          <button type="button" class="link-btn" @click="showByokSetup = !showByokSetup">
            {{ showByokSetup ? 'Masquer l’assistant clé' : 'Configurer ma clé gratuite' }}
          </button>
        </div>

        <!-- Assistant ultra-simple pour non-technophiles -->
        <div v-if="showByokSetup" class="byok-wizard">
          <h4>Assistant en 3 clics (100 % gratuit, sans carte bancaire)</h4>
          <ol class="wizard-steps">
            <li>
              Cliquez ici pour ouvrir la page officielle :
              <a
                v-if="byokProvider === 'gemini'"
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener"
              >
                Obtenir une clé gratuite Google Gemini (AI Studio) ↗
              </a>
              <a v-else href="https://console.groq.com/keys" target="_blank" rel="noopener">
                Obtenir une clé gratuite Groq ↗
              </a>
            </li>
            <li>Cliquez sur <strong>"Create API Key"</strong> et copiez la clé générée.</li>
            <li>Collez-la ci-dessous (elle reste uniquement sur votre téléphone) :</li>
          </ol>

          <div class="wizard-controls">
            <select v-model="byokProvider" class="provider-select">
              <option value="gemini">Google Gemini Flash (Recommandé)</option>
              <option value="groq">Groq Llama Vision</option>
            </select>
            <input
              v-model="byokKey"
              type="password"
              placeholder="Collez votre clé API ici (ex: AIzaSy...)"
              class="key-input"
            />
            <button
              type="button"
              class="action-btn primary"
              :disabled="isTestingKey || !byokKey.trim()"
              @click="handleSaveAndTestByok"
            >
              {{ isTestingKey ? 'Vérification...' : 'Tester & Enregistrer ma clé' }}
            </button>
          </div>

          <div
            v-if="byokTestStatus"
            class="key-status"
            :class="byokTestStatus.ok ? 'ok' : 'err'"
          >
            {{ byokTestStatus.message }}
          </div>
        </div>

        <!-- Boutons de capture photo (rafale d'appareils photo ou multi-sélection galerie) -->
        <div class="photo-triggers-grid">
          <div class="photo-trigger-group">
            <label class="photo-trigger-card">
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                @change="(e) => handlePhotoSelected(e, 'cover')"
              />
              <strong>Photo Couverture (Appareil)</strong>
              <small>Enchaînez les couvertures — ajout au lot en arrière-fond</small>
            </label>
            <label class="photo-gallery-btn">
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                @change="(e) => handlePhotoSelected(e, 'cover')"
              />
              Importer plusieurs couvertures (galerie)
            </label>
          </div>

          <div class="photo-trigger-group">
            <label class="photo-trigger-card">
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                @change="(e) => handlePhotoSelected(e, 'shelf')"
              />
              <strong>Photo Étagère / Pile (Appareil)</strong>
              <small>Prenez plusieurs étagères d’affilée, tout est analysé en file</small>
            </label>
            <label class="photo-gallery-btn">
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                @change="(e) => handlePhotoSelected(e, 'shelf')"
              />
              Importer plusieurs étagères (galerie)
            </label>
          </div>
        </div>

        <!-- Panneau d'avancement détaillé du lot arrière-fond -->
        <div v-if="photoStats.totalPhotos > 0" class="photo-queue-progress-card">
          <div class="queue-progress-header">
            <strong>
              {{ isPhotoProcessing ? 'Traitement IA & BnF en arrière-fond' : 'Résumé du lot photo' }}
            </strong>
            <div style="display: flex; gap: 0.4rem;">
              <button
                v-if="photoStats.errorPhotos > 0"
                type="button"
                class="link-btn"
                @click="photoBatchQueueService.retryFailedJobs()"
              >
                Relancer erreurs ({{ photoStats.errorPhotos }})
              </button>
              <button
                type="button"
                class="link-btn"
                @click="clearPhotoQueueAndForm"
              >
                Vider le lot
              </button>
            </div>
          </div>

          <div class="queue-metrics-grid">
            <span><strong>{{ photoStats.aiDonePhotos }}/{{ photoStats.totalPhotos }}</strong> photos lues par l'IA</span>
            <span><strong>{{ photoStats.totalBooksDetected }}</strong> tranches/livres extraits</span>
            <span><strong>{{ photoStats.totalExternalLookups }}</strong> recherches multi-sources</span>
            <span><strong>{{ photoStats.sureCount }}</strong> sûr(s) • <strong>{{ photoStats.doubtCount }}</strong> doute(s) • <strong>{{ photoStats.unresolvedCount }}</strong> non trouvé(s)</span>
          </div>

          <div v-if="isPhotoProcessing" class="queue-live-step">
            <div>{{ photoLoadingStatus }}</div>
            <small class="keep-awake-notice">
              Gardez l'application allumée pendant le traitement (un gros lot peut prendre plusieurs minutes à plusieurs heures). Vous pouvez naviguer dans l'appli, tout reste prêt à valider ici.
            </small>
          </div>
        </div>

        <div v-if="photoError" class="error-banner">{{ photoError }}</div>
        <div v-if="photoSavingFeedback" class="quick-feedback">{{ photoSavingFeedback }}</div>

        <!-- Validation unifiée façon Scan Rafale (WireframeTable + BookMiniCard + BatchActionBar) -->
        <div
          v-if="resolvedDetectedItems.length > 0 || doubtItems.length > 0 || unresolvedItems.length > 0 || seriesExtraItems.length > 0"
          class="burst-checklist-panel"
        >
          <!-- SECTION 1 : LIVRES IDENTIFIÉS (Présentation identique au mode Rafale) -->
          <div v-if="resolvedDetectedItems.length > 0" class="validation-section">
            <div class="burst-history-header">
              <label style="display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 0.85rem; cursor: pointer;">
                <input
                  type="checkbox"
                  class="wireframe-checkbox"
                  :checked="isAllPhotoDetectedSelected"
                  @change="toggleAllPhotoDetected(($event.target as HTMLInputElement).checked)"
                />
                <span>
                  {{
                    resolvedDetectedItems.filter(c => c.selected).length === 0
                      ? `Tout cocher (${resolvedDetectedItems.length})`
                      : `${resolvedDetectedItems.filter(c => c.selected).length}/${resolvedDetectedItems.length} sélectionné(s)`
                  }}
                </span>
              </label>
              <button type="button" class="clear-btn" @click="clearPhotoQueueAndForm">
                Vider la liste
              </button>
            </div>

            <WireframeTable>
              <BookMiniCard
                v-for="item in resolvedDetectedItems"
                :key="item.id"
                :book="photoItemToBook(item)"
                :selectable-only="true"
                :extra-badges="getPhotoItemBadges(item)"
                v-model="item.selected"
              />
            </WireframeTable>
          </div>

          <!-- SECTION 1B : DOUTES (ARBITRAGE ENTRE PISTES CROISÉES) -->
          <div v-if="doubtItems.length > 0" class="validation-section doubt-section">
            <div class="validation-header">
              <h4>Résultats incertains à arbitrer ({{ selectedDoubtCount }}/{{ doubtItems.length }})</h4>
            </div>
            <div class="candidates-list doubt-list">
              <div v-for="d in doubtItems" :key="d.id" class="candidate-row doubt-row">
                <div class="cand-meta" style="width: 100%;">
                  <div class="doubt-ai-header">
                    <strong>Lecture IA : « {{ d.rawCandidate.title || d.rawCandidate.rawSpineText }} »</strong>
                    <small v-if="d.rawCandidate.rawSpineText && d.rawCandidate.rawSpineText !== d.rawCandidate.title" class="spine-ocr-preview">
                      Tranche : {{ d.rawCandidate.rawSpineText }}
                    </small>
                  </div>

                  <div class="doubt-options-list">
                    <label
                      v-for="opt in d.alternatives || []"
                      :key="opt.isbn13"
                      class="doubt-option-card"
                      :class="{ chosen: d.selectedAlternativeIsbn === opt.isbn13 && d.selected }"
                    >
                      <input
                        type="radio"
                        :name="`doubt-${d.id}`"
                        :checked="d.selectedAlternativeIsbn === opt.isbn13 && d.selected"
                        @change="selectDoubtOption(d, opt)"
                      />
                      <img
                        v-if="opt.coverUrl"
                        :src="imageUtil.resolveCoverUrl(opt.coverUrl)"
                        :alt="opt.title"
                        class="cand-cover-thumb small-thumb"
                        @error="imageUtil.advanceCoverFallback(opt)"
                      />
                      <div v-else class="cand-cover-fallback small-thumb">—</div>
                      <div class="doubt-opt-meta">
                        <div>
                          <span v-if="opt.series" class="cand-series-pill">
                            {{ opt.series }}<template v-if="opt.seriesNumber"> T.{{ opt.seriesNumber }}</template>
                          </span>
                          <strong>{{ opt.title }}</strong>
                        </div>
                        <small>
                          {{ opt.authors.join(', ') || 'Auteur inconnu' }}
                          <template v-if="opt.publisher"> • {{ opt.publisher }}</template>
                          ({{ opt.isbn13 }} • {{ opt.sourcesCount }} source(s))
                        </small>
                      </div>
                    </label>

                    <label
                      class="doubt-option-card ignore-opt"
                      :class="{ chosen: d.selectedAlternativeIsbn === '__ignore__' || !d.selected }"
                    >
                      <input
                        type="radio"
                        :name="`doubt-${d.id}`"
                        :checked="d.selectedAlternativeIsbn === '__ignore__' || !d.selected"
                        @change="selectDoubtOption(d, null)"
                      />
                      <span>Ignorer ce résultat pour le moment</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- SECTION 2 : AUTRES TOMES DES SÉRIES DÉTECTÉES (ACCORDÉONS + BOOKMINICARD) -->
          <div v-if="groupedSeriesExtras.length > 0" class="validation-section series-extras-section">
            <div class="validation-header">
              <h4>Autres tomes des séries ({{ selectedSeriesCount }}/{{ seriesExtraItems.length }})</h4>
              <div class="series-controls-inline">
                <button type="button" class="link-btn" @click="toggleAllSeriesExtras(true)">Tout</button>
                <button type="button" class="link-btn" @click="toggleAllSeriesExtras(false)">Aucun</button>
              </div>
            </div>

            <div class="series-accordions-list">
              <div
                v-for="group in groupedSeriesExtras"
                :key="group.seriesKey"
                class="series-accordion-card"
              >
                <div class="series-accordion-header">
                  <button
                    type="button"
                    class="series-accordion-toggle"
                    @click="toggleSeriesAccordion(group.seriesKey)"
                    :aria-expanded="Boolean(expandedSeriesKeys[group.seriesKey])"
                  >
                    <span class="accordion-arrow">{{ expandedSeriesKeys[group.seriesKey] ? '▾' : '▸' }}</span>
                    <span class="accordion-title">{{ group.seriesName }}</span>
                    <span class="accordion-count">
                      {{ group.selectedCount }}/{{ group.items.length }} tome(s)
                    </span>
                  </button>
                  <div class="series-group-actions">
                    <button type="button" class="link-btn" @click="toggleGroupSeriesExtras(group.seriesKey, true)">Tout</button>
                    <button type="button" class="link-btn" @click="toggleGroupSeriesExtras(group.seriesKey, false)">Aucun</button>
                  </div>
                </div>

                <div v-if="expandedSeriesKeys[group.seriesKey]" class="candidates-list series-inner-list">
                  <WireframeTable>
                    <BookMiniCard
                      v-for="extra in group.items"
                      :key="extra.id"
                      :book="photoItemToBook(extra)"
                      :selectable-only="true"
                      :extra-badges="getPhotoItemBadges(extra)"
                      v-model="extra.selected"
                    />
                  </WireframeTable>
                </div>
              </div>
            </div>
          </div>

          <!-- SECTION 3 : NON IDENTIFIÉS SUR BNF / GOOGLE BOOKS -->
          <div v-if="unresolvedItems.length > 0" class="validation-section unresolved-section">
            <div class="validation-header">
              <h4>Non identifiés ({{ unresolvedItems.length }})</h4>
            </div>
            <div class="candidates-list unresolved-list">
              <div
                v-for="u in unresolvedItems"
                :key="u.id"
                class="candidate-row unresolved-row"
              >
                <div class="cand-fields">
                  <input v-model="u.rawCandidate.title" placeholder="Titre du livre" class="cand-input bold" />
                  <div class="cand-sub-row">
                    <input v-model="u.rawCandidate.series" placeholder="Série" class="cand-input" />
                    <input v-model="u.rawCandidate.volumeNumber" placeholder="Tome" class="cand-input small" />
                    <input v-model="u.rawCandidate.author" placeholder="Auteur" class="cand-input" />
                  </div>
                  <div class="cand-sub-row">
                    <input v-model="u.rawCandidate.publisher" placeholder="Éditeur" class="cand-input" />
                    <input v-model="u.rawCandidate.isbn" placeholder="ISBN (optionnel)" class="cand-input" />
                    <button
                      type="button"
                      class="action-btn retry-bnf-btn"
                      :disabled="retryingItemId === u.id"
                      @click="retryUnresolvedItem(u)"
                    >
                      {{ retryingItemId === u.id ? 'Recherche...' : 'Chercher BnF' }}
                    </button>
                  </div>
                  <small v-if="u.rawCandidate.rawSpineText" class="spine-ocr-preview">
                    Texte lu sur tranche : « {{ u.rawCandidate.rawSpineText }} »
                  </small>
                  <small v-if="u.failureReason" class="unresolved-msg">{{ u.failureReason }}</small>
                </div>
              </div>
            </div>
          </div>

          <BatchActionBar
            :inline="true"
            :selected-count="selectedPhotoBooks.length"
            :selected-books="selectedPhotoBooks"
            @execute="dispatchPhotoBatchAction"
            @clear="clearPhotoSelections"
          />
        </div>
      </div>

      <div
        v-if="scannerState.errorMessage.value"
        :class="scannerState.errorMessage.value.includes('mémorisé') ? 'offline-memorized-banner' : 'error-banner'"
      >
        <p style="margin: 0;">{{ scannerState.errorMessage.value }}</p>
        <button
          v-if="scannerState.errorMessage.value.includes('mémorisé') && activeMode === 'simple'"
          type="button"
          class="retry-simple-scan-btn"
          @click="scannerState.switchMode('simple')"
        >
          Scanner un autre code-barres
        </button>
      </div>

      <div v-if="isScrollable" class="modal-bottom-close-bar">
        <button type="button" class="close-scan-btn" aria-label="Fermer" @click="scannerState.stopScan()">
          ✕
        </button>
      </div>
    </div>

    <LendModal
      :show="showBurstLendModal"
      :bookCount="selectedBurstBooks.length"
      @close="showBurstLendModal = false"
      @confirm="confirmBurstGroupLend"
    />
    </div>
  </Teleport>
</template>

<style scoped>
.scanner-modal-backdrop {
  position: fixed;
  inset: 0;
  width: 100%;
  min-block-size: 100dvh;
  background: rgba(15, 23, 42, 0.58);
  backdrop-filter: blur(4px);
  z-index: var(--z-modal, 2000);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 0.85rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  box-sizing: border-box;
}

.scanner-modal-card {
  inline-size: 100%;
  max-inline-size: 560px;
  max-block-size: 92dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-main, #0f172a);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-modal, 0 20px 25px -5px rgba(15, 23, 42, 0.16));
  padding: 1.2rem;
  font-family: var(--font-main);
  box-sizing: border-box;
}

.scanner-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: nowrap;
}

.mode-tabs {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.25rem;
  padding: 0.2rem;
  background: var(--color-bg-alt, #f1f5f9);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 10px);
}

.mode-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-muted, #475569);
  min-block-size: 36px;
  padding: 0.3rem 0.35rem;
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}

.mode-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode-tab:hover:not(.active) {
  background: rgba(255, 255, 255, 0.7);
  color: var(--color-text-main, #0f172a);
}

.mode-tab.active {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #fff;
  box-shadow: var(--shadow-sm);
}

.close-scan-btn {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  min-block-size: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 999px;
  background: var(--color-bg-alt, #f8fafc);
  color: var(--color-text-muted, #475569);
  font-weight: 600;
  padding: 0;
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.close-scan-btn:hover {
  background: #fee2e2;
  border-color: #fecaca;
  color: #b91c1c;
}

.burst-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--color-bg-alt, #f8fafc);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.55rem;
  font-size: 0.82rem;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.burst-target-switch {
  display: flex;
  gap: 0.35rem;
}

.burst-target-switch button {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  background: #fff;
  padding: 0.3rem 0.65rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.burst-target-switch button.active {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #fff;
}

.scanner-viewport-container {
  position: relative;
  min-block-size: 240px;
  background: #0f172a;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  overflow: hidden;
}

.scanner-viewport {
  inline-size: 100%;
}

.scanner-viewport :deep(video) {
  width: 100% !important;
  height: auto !important;
  display: block;
}

.scanner-placeholder {
  color: #f8fafc;
  text-align: center;
  padding: 2.5rem 1rem;
  font-size: 0.875rem;
  line-height: 1.4;
}

.burst-live-toast {
  margin-top: 0.65rem;
  padding: 0.65rem 0.85rem;
  border: 1px solid #86efac;
  border-radius: var(--radius-sm, 8px);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  background: #dcfce7;
  color: #14532d;
}

.burst-live-toast.already_owned {
  background: #fef3c7;
  border-color: #fcd34d;
  color: #78350f;
}

.toast-main {
  display: flex;
  flex-direction: column;
  font-size: 0.85rem;
}

.undo-btn,
.mini-undo {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  background: #fff;
  padding: 0.3rem 0.6rem;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.burst-history-box {
  margin-top: 0.65rem;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.55rem;
  background: var(--color-bg-alt, #f8fafc);
  font-size: 0.8rem;
}

.burst-history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.45rem;
}

.clear-btn {
  background: none;
  border: none;
  color: var(--color-primary, #4f46e5);
  text-decoration: underline;
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 600;
}

.burst-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.burst-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  padding: 0.35rem 0.55rem;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
}

.verdict-banner {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  padding: 1rem;
  margin-bottom: 0.75rem;
}

.verdict-banner.owned {
  background: #dcfce7;
  border-color: #86efac;
  color: #14532d;
}

.verdict-banner.owned-other {
  background: #d1fae5;
  border-color: #6ee7b7;
  color: #065f46;
}

.verdict-banner.wish {
  background: #dbeafe;
  border-color: #93c5fd;
  color: #1e3a8a;
}

.verdict-banner.series-gap {
  background: #ffedd5;
  border-color: #fdba74;
  color: #7c2d12;
}

.verdict-banner.not-owned,
.verdict-banner.neutral {
  background: #f1f5f9;
  border-color: #cbd5e1;
  color: #0f172a;
}

.verdict-badge {
  font-weight: 700;
  font-size: 0.8125rem;
  letter-spacing: 0.03em;
  margin-bottom: 0.3rem;
}

.verdict-title {
  margin: 0 0 0.25rem;
  font-size: 1.125rem;
  line-height: 1.25;
  text-wrap: balance;
}

.verdict-sub {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.45;
  text-wrap: pretty;
}

.missing-tomes-pill {
  margin-top: 0.6rem;
  padding: 0.45rem 0.65rem;
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  font-size: 0.8rem;
}

.check-actions-grid {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.action-btn {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  min-block-size: 42px;
  padding: 0.6rem 0.9rem;
  font-weight: 600;
  font-size: 0.875rem;
  line-height: 1.25;
  font-family: inherit;
  cursor: pointer;
  text-align: center;
  box-shadow: var(--shadow-sm);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.action-btn.primary {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #fff;
}

.action-btn.primary:hover:not(:disabled) {
  background: var(--color-primary-hover, #4338ca);
}

.action-btn.primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.action-btn.secondary {
  background: #0284c7;
  border-color: #0284c7;
  color: #fff;
}

.action-btn.series {
  background: #f59e0b;
  border-color: #d97706;
  color: #0f172a;
}

.action-btn.outline {
  background: #fff;
  color: var(--color-text-main, #0f172a);
}

.action-btn.rescan {
  background: #0f172a;
  border-color: #0f172a;
  color: #fff;
}

.quick-feedback {
  background: #dcfce7;
  border: 1px solid #86efac;
  border-radius: var(--radius-sm, 8px);
  color: #14532d;
  padding: 0.55rem 0.75rem;
  font-weight: 600;
  font-size: 0.85rem;
  text-align: center;
  margin-top: 0.6rem;
  margin-bottom: 0.6rem;
}

.byok-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--color-bg-alt, #f8fafc);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.55rem 0.75rem;
  font-size: 0.82rem;
  margin-bottom: 0.65rem;
}

.byok-wizard {
  border: 1px dashed var(--color-primary, #4f46e5);
  border-radius: var(--radius-md, 12px);
  background: #eef2ff;
  padding: 0.85rem;
  margin-bottom: 0.75rem;
  font-size: 0.84rem;
  line-height: 1.45;
}

.byok-wizard h4 {
  margin: 0 0 0.45rem;
  font-size: 0.9375rem;
  text-wrap: balance;
}

.wizard-steps {
  margin: 0 0 0.65rem;
  padding-left: 1.2rem;
}

.wizard-controls {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.provider-select,
.key-input {
  min-block-size: 40px;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.45rem 0.65rem;
  font-size: 0.85rem;
  font-family: inherit;
  background: #fff;
}

.provider-select:focus,
.key-input:focus {
  outline: none;
  border-color: var(--color-primary, #4f46e5);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15);
}

.key-status {
  margin-top: 0.45rem;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-sm, 8px);
  font-weight: 600;
}

.key-status.ok {
  background: #dcfce7;
  color: #166534;
}

.key-status.err {
  background: #fee2e2;
  color: #991b1b;
}

.photo-triggers-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.65rem;
  margin-bottom: 0.75rem;
}

.photo-trigger-card {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  background: var(--color-bg-alt, #f8fafc);
  padding: 0.9rem 0.65rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.3rem;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.photo-trigger-card:hover {
  background: #eef2ff;
  border-color: #c7d2fe;
}

.trigger-icon {
  font-size: 1.5rem;
}

.photo-loading {
  padding: 0.95rem;
  text-align: center;
  font-weight: 600;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: var(--radius-md, 12px);
}

.candidates-validation-box {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  padding: 0.85rem;
  background: var(--color-bg-alt, #f8fafc);
}

.validation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.55rem;
  flex-wrap: wrap;
}

.validation-header h4 {
  margin: 0;
  font-size: 0.9375rem;
  text-wrap: balance;
}

.candidates-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-block-size: 260px;
  overflow-y: auto;
  margin-bottom: 0.65rem;
}

.candidate-row {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  background: #fff;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.55rem;
}

.cand-fields {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.cand-sub-row {
  display: flex;
  gap: 0.35rem;
}

.cand-input {
  inline-size: 100%;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.35rem 0.5rem;
  font-size: 0.8125rem;
  font-family: inherit;
}

.cand-input:focus {
  outline: none;
  border-color: var(--color-primary, #4f46e5);
}

.cand-input.bold {
  font-weight: 700;
}

.cand-input.small {
  max-inline-size: 72px;
}

.validation-section {
  margin-bottom: 0.8rem;
}

.series-extras-section {
  border-top: 1px dashed #cbd5e1;
  padding-top: 0.7rem;
}

.series-controls-inline {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.primary-detected-list {
  max-block-size: 320px;
}

.series-accordions-list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin-bottom: 0.35rem;
}

.series-accordion-card {
  border: 1px solid #c7d2fe;
  border-radius: var(--radius-sm, 8px);
  overflow: hidden;
  background: #ffffff;
}

.series-accordion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.45rem;
  padding: 0.45rem 0.6rem;
  background: #eef2ff;
}

.series-accordion-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  padding: 0.15rem 0;
  text-align: left;
  cursor: pointer;
  color: #1e1b4b;
}

.accordion-arrow {
  font-size: 0.9rem;
  font-weight: 700;
  inline-size: 14px;
}

.accordion-title {
  font-weight: 700;
  font-size: 0.84rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.accordion-count {
  font-size: 0.74rem;
  font-weight: 700;
  color: #4338ca;
  background: #ffffff;
  border: 1px solid #c7d2fe;
  border-radius: 9999px;
  padding: 0.05rem 0.45rem;
  white-space: nowrap;
}

.series-group-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}

.series-inner-list {
  max-block-size: 220px;
  margin-bottom: 0;
  padding: 0.45rem;
  border-top: 1px solid var(--color-border, #e2e8f0);
  background: var(--color-bg-alt, #f8fafc);
}

.unresolved-section {
  border-top: 1px dashed #f59e0b;
  padding-top: 0.7rem;
}

.resolved-row {
  align-items: center;
}

.cand-cover-thumb {
  width: 42px;
  height: 58px;
  object-fit: cover;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 4px;
  flex-shrink: 0;
  background: #f1f5f9;
}

.cand-cover-fallback {
  width: 42px;
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 4px;
  background: #f1f5f9;
  font-size: 1rem;
  color: var(--color-text-muted, #64748b);
  flex-shrink: 0;
}

.cand-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.cand-title-line {
  font-size: 0.85rem;
  line-height: 1.3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.cand-series-pill {
  background: #eef2ff;
  color: #3730a3;
  border: 1px solid #c7d2fe;
  border-radius: 9999px;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.08rem 0.45rem;
}

.cand-sub-meta {
  font-size: 0.76rem;
  color: #475569;
  line-height: 1.35;
}

.cand-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}

.isbn-tag {
  font-size: 0.72rem;
  background: #f1f5f9;
  padding: 0.08rem 0.4rem;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
}

.mini-badge {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 9999px;
}

.mini-badge.owned {
  background: #dcfce7;
  color: #166534;
}

.mini-badge.wish {
  background: #fce7f3;
  color: #9d174d;
}

.mini-badge.warn {
  background: #fef3c7;
  color: #92400e;
}

.mini-badge.corrected {
  background: #e0f2fe;
  color: #0369a1;
}

.mini-badge.consensus {
  background: #ede9fe;
  color: #5b21b6;
}

.spine-ocr-preview {
  color: #475569;
  font-size: 0.75rem;
  font-style: italic;
  background: #f1f5f9;
  padding: 0.25rem 0.5rem;
  border-left: 2px solid #94a3b8;
  border-radius: 0 4px 4px 0;
}

.unresolved-row {
  background: #fffbeb;
  border-color: #fde68a;
}

.retry-bnf-btn {
  min-block-size: 34px;
  padding: 0.3rem 0.65rem;
  font-size: 0.78rem;
  white-space: nowrap;
}

.unresolved-msg {
  color: #92400e;
  font-size: 0.75rem;
  font-weight: 600;
}

.full-width {
  inline-size: 100%;
}

.link-btn {
  background: none;
  border: none;
  color: var(--color-primary, #4f46e5);
  text-decoration: underline;
  font-weight: 600;
  cursor: pointer;
  font-size: 0.8125rem;
}

.error-banner {
  margin-top: 0.6rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid #fecaca;
  border-radius: var(--radius-sm, 8px);
  background: #fef2f2;
  color: #b91c1c;
  font-weight: 600;
  font-size: 0.85rem;
}

.tab-count-badge {
  display: inline-block;
  margin-left: 4px;
  background: #f59e0b;
  color: #0f172a;
  border-radius: 9999px;
  padding: 0 6px;
  font-size: 0.72rem;
  font-weight: 700;
}

.offline-memorized-banner {
  margin-top: 0.65rem;
  padding: 0.7rem 0.9rem;
  border-radius: var(--radius-sm, 8px);
  border: 1px solid #fcd34d;
  background: #fefce8;
  color: #854d0e;
  font-size: 0.84rem;
  line-height: 1.45;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.retry-simple-scan-btn {
  align-self: flex-start;
  border: 1px solid var(--color-primary, #4f46e5);
  background: var(--color-primary, #4f46e5);
  color: #ffffff;
  border-radius: var(--radius-sm, 8px);
  padding: 0.35rem 0.75rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.mode-switch-bar {
  margin-bottom: 0.55rem;
}

.photo-trigger-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.photo-gallery-btn {
  display: block;
  text-align: center;
  padding: 0.42rem 0.6rem;
  border: 1px dashed #94a3b8;
  border-radius: var(--radius-sm, 8px);
  background: #f1f5f9;
  color: #1e293b;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.photo-queue-progress-card {
  border: 1px solid #fde68a;
  border-radius: var(--radius-md, 12px);
  background: #fffbeb;
  padding: 0.75rem 0.85rem;
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.queue-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  font-size: 0.86rem;
}

.queue-metrics-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem 0.9rem;
  font-size: 0.78rem;
  color: #334155;
}

.queue-live-step {
  border-top: 1px dashed #cbd5e1;
  padding-top: 0.4rem;
  font-size: 0.78rem;
  color: #1e3a8a;
  font-weight: 600;
}

.keep-awake-notice {
  display: block;
  color: #92400e;
  font-weight: 600;
  margin-top: 0.2rem;
}

.doubt-section {
  border-top: 1px dashed #818cf8;
  padding-top: 0.7rem;
}

.doubt-row {
  background: #eef2ff;
  border-color: #c7d2fe;
}

.doubt-ai-header {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-bottom: 0.4rem;
  font-size: 0.82rem;
}

.doubt-options-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.doubt-option-card {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.6rem;
  background: #ffffff;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  cursor: pointer;
  font-size: 0.8125rem;
}

.doubt-option-card.chosen {
  border-color: var(--color-primary, #4f46e5);
  background: #f5f3ff;
}

.doubt-option-card.ignore-opt {
  color: #64748b;
  font-style: italic;
}

.small-thumb {
  width: 30px;
  height: 44px;
}

.doubt-opt-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.mode-hint-bar {
  margin: 0 0 0.65rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted, #64748b);
  line-height: 1.45;
  background: var(--color-bg-alt, #f8fafc);
  padding: 0.45rem 0.65rem;
  border-radius: var(--radius-sm, 8px);
  border-left: 3px solid var(--color-primary, #4f46e5);
  text-wrap: pretty;
}

.burst-compact-viewport {
  min-block-size: 240px;
}

.burst-flash-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 15;
  animation: burstPulseFlash 550ms ease-out forwards;
}

.burst-flash-overlay.success {
  background: rgba(34, 197, 94, 0.38);
  box-shadow: inset 0 0 0 5px #22c55e;
}

.burst-flash-overlay.duplicate {
  background: rgba(245, 158, 11, 0.35);
  box-shadow: inset 0 0 0 5px #f59e0b;
}

@keyframes burstPulseFlash {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

.burst-checklist-panel {
  margin-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
</style>
