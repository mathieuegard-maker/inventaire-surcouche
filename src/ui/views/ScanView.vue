<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { scannerState, type ScannerMode } from '../../state/scanner';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { inventoryService } from '../../core/services/inventory.service';
import { databaseService } from '../../core/database/database.service';
import { wishlistService } from '../../core/services/wishlist.service';
import { byokVisionService, type RecognizedBookCandidate, type ServerVisionStatus } from '../../core/services/byok-vision.service';
import type { UserIngestHint } from '../../core/services/v4-pipeline.service';
import PhotoItemDetailModal from '../components/PhotoItemDetailModal.vue';
import {
  photoBookResolutionService,
  type PhotoResolutionOption,
  type ResolvedPhotoItem
} from '../../core/services/photo-book-resolution.service';
import { photoBatchQueueService } from '../../core/services/photo-batch-queue.service';
import { normalizeTextKey } from '../../core/resolvers/bnf.resolver';
import { isbnUtil } from '../../core/utils/isbn.util';
import { imageUtil } from '../../core/utils/image.util';
import {
  formatV4StatusNotice,
  ingestIsbnsViaV4,
  resolveHintsViaV4Backend,
  v4BookRecordToHumanizedBook
} from '../../core/services/v4-client.service';
import type { Canal3ResolutionOption } from '../../core/services/canal3-resolver.service';
import { saveBookNavigationOrder } from '../../state/bookNavigation';
import { pendingScansStore } from '../../state/pendingScans';
import { scanDraftStore, sortItemsByShelfOrder } from '../../state/scanDraft';
import type { HumanizedBook } from '../../core/types';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BookMiniCard from '../components/BookMiniCard.vue';
import WireframeTable from '../components/WireframeTable.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import LendModal from '../components/LendModal.vue';
import IntegralConfigFields from '../components/IntegralConfigFields.vue';
import {
  annotateIntegralCoverage,
  formatIncludedVolumeNumbers
} from '../../core/bibliographic/integral.util';
import { transformBookIntegralStatus } from '../../core/services/integral.service';

const route = useRoute();
const router = useRouter();

const activeMode = computed(() => scannerState.activeMode.value);

const syncModeFromRoute = () => {
  const qMode = route.query.mode;
  if (qMode === 'photo' || qMode === 'burst' || qMode === 'simple' || qMode === 'search') {
    scannerState.activeMode.value = qMode;
  } else if (!scannerState.activeMode.value) {
    scannerState.activeMode.value = 'photo';
  }
};

watch(() => route.query.mode, syncModeFromRoute, { immediate: true });
onMounted(() => {
  syncModeFromRoute();
  refreshServerVisionStatus();
});

onBeforeUnmount(() => {
  if (scannerState.isScanningActive.value) {
    scannerState.stopScan();
  }
});

const selectTab = async (mode: ScannerMode) => {
  await scannerState.switchMode(mode);
  if (mode === 'burst' || mode === 'simple') {
    await scannerState.openCameraModal(router, mode);
  }
};

// ============================================================================
// ÉDITEUR RAPIDE D'INTÉGRALE PARTAGÉ (RAFALE, SCAN SIMPLE, RECHERCHE TEXTUELLE)
// ============================================================================
const editingIntegralBookUri = ref<string | null>(null);
const inlineIntegralFlag = ref(false);
const inlineIntegralVolsText = ref('');
const inlineIntegralSaving = ref(false);

const toggleInlineIntegralEditor = (book: HumanizedBook) => {
  if (editingIntegralBookUri.value === book.uri) {
    editingIntegralBookUri.value = null;
    return;
  }
  editingIntegralBookUri.value = book.uri;
  inlineIntegralFlag.value = Boolean(book.isIntegral);
  inlineIntegralVolsText.value = formatIncludedVolumeNumbers(
    book.integralMetadata?.includedVolumeNumbers
  );
};

const applyInlineIntegralEditor = async (book: HumanizedBook) => {
  if (inlineIntegralSaving.value) return;
  inlineIntegralSaving.value = true;
  try {
    const updated = await transformBookIntegralStatus(book, {
      isIntegral: inlineIntegralFlag.value,
      includedVolumeNumbers: inlineIntegralVolsText.value,
      persistToServer: book.ownershipStatus !== 'none' || Boolean(book.bookId)
    });
    Object.assign(book, updated);
    editingIntegralBookUri.value = null;
  } finally {
    inlineIntegralSaving.value = false;
  }
};

// ============================================================================
// MODE SIMPLE (MODALE CAMÉRA -> AFFICHAGE IDENTIQUE AU MODE RAFALE)
// ============================================================================
const simpleBooks = computed(() => scannerState.simpleBooks.value);
const simpleSelectedUris = ref<string[]>([]);
const showSimpleLendModal = ref(false);
const simpleFeedback = ref('');

const isAllSimpleSelected = computed(
  () => simpleBooks.value.length > 0 && simpleSelectedUris.value.length === simpleBooks.value.length
);

const toggleAllSimple = (checked: boolean) => {
  simpleSelectedUris.value = checked ? simpleBooks.value.map((b) => b.uri) : [];
};

const selectedSimpleBooks = computed(() =>
  simpleBooks.value.filter((b) => simpleSelectedUris.value.includes(b.uri))
);

const dispatchSimpleBatchAction = async (
  action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE'
) => {
  if (selectedSimpleBooks.value.length === 0) return;
  if (action === 'LEND') {
    showSimpleLendModal.value = true;
    return;
  }

  let processed = 0;
  for (const book of selectedSimpleBooks.value) {
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
      const v4Target = action === 'ADD_INVENTORY' ? 'owned' : 'wishlist';
      const cleanIsbn = book.isbn13 || (book.uri.startsWith('isbn:') ? book.uri.slice(5) : '');
      let handledByV4 = false;
      if (cleanIsbn) {
        const v4Res = await ingestIsbnsViaV4({
          isbns: [cleanIsbn],
          sourceChannel: 'canal_1_barcode',
          action: v4Target,
          hints: {
            [cleanIsbn]: {
              title: book.title,
              series: book.series,
              volumeNumber: book.isIntegral ? undefined : book.seriesNumber,
              isIntegral: Boolean(book.isIntegral),
              includedVolumeNumbers: book.isIntegral ? book.integralMetadata?.includedVolumeNumbers : undefined,
              coverUrl: book.coverUrl
            }
          }
        });
        if (v4Res?.results?.[0]?.book) {
          const humanized = v4BookRecordToHumanizedBook(v4Res.results[0].book, targetStatus);
          await databaseService.saveBookToCache(humanized);
          await databaseService.addRegistryEntry(action === 'ADD_INVENTORY' ? 'inventory' : 'wishlist', humanized.uri);
          handledByV4 = true;
        }
      }
      if (!handledByV4) {
        await queueService.enqueueAction(action, book.uri);
      }
      book.ownershipStatus = targetStatus;
      processed++;
    }
  }
  simpleSelectedUris.value = [];
  simpleFeedback.value = `${processed} ouvrage(s) mis à jour.`;
  scannerState.notifyCatalogChanged();
};

const confirmSimpleGroupLend = async (friendName: string) => {
  showSimpleLendModal.value = false;
  if (!friendName || selectedSimpleBooks.value.length === 0) return;
  for (const book of selectedSimpleBooks.value) {
    if (book.ownershipStatus !== 'owned') {
      await queueService.enqueueAction('ADD_INVENTORY', book.uri);
      book.ownershipStatus = 'owned';
    }
    await queueService.enqueueAction('LEND', book.uri, { friendName });
    book.loan = { uri: book.uri, friendName, loanDate: Date.now() };
  }
  simpleFeedback.value = `${selectedSimpleBooks.value.length} livre(s) prêté(s) à ${friendName}.`;
  simpleSelectedUris.value = [];
  scannerState.notifyCatalogChanged();
};

// ============================================================================
// MODE RAFALE CODE-BARRES
// ============================================================================
const burstBooks = computed(() => scannerState.burstBooks.value);
const burstSelectedUris = ref<string[]>([]);
const showBurstLendModal = ref(false);
const burstFeedback = ref('');
const burstManualIsbn = ref('');

const isAllBurstSelected = computed(
  () => burstBooks.value.length > 0 && burstSelectedUris.value.length === burstBooks.value.length
);

const toggleAllBurst = (checked: boolean) => {
  burstSelectedUris.value = checked ? burstBooks.value.map((b) => b.uri) : [];
};

const selectedBurstBooks = computed(() =>
  burstBooks.value.filter((b) => burstSelectedUris.value.includes(b.uri))
);

const handleAddManualBurst = async () => {
  const clean = isbnUtil.normalize(burstManualIsbn.value);
  if (!clean) return;
  burstManualIsbn.value = '';
  const res = await searchService.searchByIsbn(clean).catch(() => null);
  await scannerState.handleBurstDetection(res, clean);
};

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
      const v4Target = action === 'ADD_INVENTORY' ? 'owned' : 'wishlist';
      const cleanIsbn = book.isbn13 || (book.uri.startsWith('isbn:') ? book.uri.slice(5) : '');
      let handledByV4 = false;
      if (cleanIsbn) {
        const v4Res = await ingestIsbnsViaV4({
          isbns: [cleanIsbn],
          sourceChannel: 'canal_1_barcode',
          action: v4Target,
          hints: {
            [cleanIsbn]: {
              title: book.title,
              series: book.series,
              volumeNumber: book.isIntegral ? undefined : book.seriesNumber,
              isIntegral: Boolean(book.isIntegral),
              includedVolumeNumbers: book.isIntegral ? book.integralMetadata?.includedVolumeNumbers : undefined,
              coverUrl: book.coverUrl
            }
          }
        });
        if (v4Res?.results?.[0]?.book) {
          handledByV4 = true;
        }
      }
      if (!handledByV4) {
        if (book.uri.startsWith('isbn:')) {
          await backgroundCreationOrchestrator.enqueueBookCreation({
            tempBook: { ...book, ownershipStatus: targetStatus },
            expandSeries: Boolean(book.series)
          });
        } else {
          await queueService.enqueueAction(action, book.uri);
        }
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
  }, 3500);
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
  }, 3500);
};

// ============================================================================
// MODE PHOTO IA + ARBITRAGE ÉDITIONS / INTÉGRALES + MICRO-LOTS V4
// ============================================================================
const serverVisionStatus = ref<ServerVisionStatus | null>(null);
const PHOTO_HELP_KEY = 'biblio_photo_ai_hide_help';
const hidePhotoHelp = ref<boolean>(
  typeof localStorage !== 'undefined' && localStorage.getItem(PHOTO_HELP_KEY) === '1'
);

const dismissPhotoHelp = () => {
  hidePhotoHelp.value = true;
  if (typeof localStorage !== 'undefined') localStorage.setItem(PHOTO_HELP_KEY, '1');
};
const showPhotoHelp = () => {
  hidePhotoHelp.value = false;
  if (typeof localStorage !== 'undefined') localStorage.removeItem(PHOTO_HELP_KEY);
};

const refreshServerVisionStatus = () => {
  byokVisionService.fetchServerVisionStatus().then((st) => {
    serverVisionStatus.value = st;
  });
};

const photoStats = photoBatchQueueService.stats;
const isPhotoProcessing = photoBatchQueueService.isProcessing;
const photoLoadingStatus = photoBatchQueueService.currentStatusMessage;
const photoError = ref('');
const photoSavingFeedback = ref('');
const resolvedDetectedItems = scanDraftStore.resolvedDetectedItems;
const doubtItems = scanDraftStore.doubtItems;
const unresolvedItems = scanDraftStore.unresolvedItems;
const seriesExtraItems = scanDraftStore.seriesExtraItems;
const detectedSeriesNames = scanDraftStore.detectedSeriesNames;
const retryingItemIds = ref<Record<string, boolean>>({});
const retryAllProgress = ref<{ active: boolean; done: number; total: number }>({
  active: false,
  done: 0,
  total: 0
});
const expandedSeriesKeys = scanDraftStore.expandedSeriesKeys;
const lastSavedToCollection = ref<boolean>(false);
const activeDetailItemId = ref<string | null>(null);
const ingestProgress = ref<{ active: boolean; done: number; total: number; label?: string }>({
  active: false,
  done: 0,
  total: 0
});

const allValidationPool = computed(() => [
  ...resolvedDetectedItems.value,
  ...doubtItems.value,
  ...unresolvedItems.value,
  ...seriesExtraItems.value
]);

const activeDetailItem = computed(() =>
  activeDetailItemId.value
    ? allValidationPool.value.find((i) => i.id === activeDetailItemId.value) || null
    : null
);

const activeDetailPosLabel = computed(() => {
  const item = activeDetailItem.value;
  if (!item) return '';
  const spineIdx = item.rawCandidate?.spineIndex;
  const totalSpines = item.rawCandidate?.totalSpines;
  if (typeof spineIdx === 'number' && spineIdx > 0) {
    return totalSpines && totalSpines >= spineIdx
      ? `Tranche #${spineIdx} / ${totalSpines}`
      : `Tranche #${spineIdx}`;
  }
  const idx = allValidationPool.value.findIndex((i) => i.id === item.id);
  return idx >= 0 ? `Livre ${idx + 1} / ${allValidationPool.value.length}` : '';
});

const activeDetailPhotoUrl = computed(() => {
  const jobId = activeDetailItem.value?.sourceJobId;
  if (typeof jobId === 'number') {
    const matchedJob = photoBatchQueueService.jobs.value.find((j) => j.id === jobId);
    if (matchedJob?.imageDataUrl) return matchedJob.imageDataUrl;
  }
  const itemId = activeDetailItem.value?.id;
  if (itemId) {
    const fallbackJob = photoBatchQueueService.jobs.value.find((j) =>
      j.result?.detectedItems?.some((d) => d.id === itemId)
    );
    if (fallbackJob?.imageDataUrl) return fallbackJob.imageDataUrl;
  }
  return undefined;
});

function openPhotoItemDetail(item: ResolvedPhotoItem) {
  activeDetailItemId.value = item.id;
}

function closePhotoItemDetail() {
  activeDetailItemId.value = null;
}

function formatCompactShelfPos(item: ResolvedPhotoItem): string {
  const idx = item.rawCandidate?.spineIndex;
  const total = item.rawCandidate?.totalSpines;
  if (!idx) return '';
  if (total && total >= idx) {
    return `G#${idx} • D#${total - idx + 1}`;
  }
  return `G#${idx}`;
}

function resolveCardCoverSrc(item: ResolvedPhotoItem): string {
  if (item.coverUrl) {
    return imageUtil.resolveExternalUrl(item.coverUrl, item.isbn13);
  }
  if (item.isbn13) {
    return `/api/gateway?action=image-proxy&isbn=${encodeURIComponent(item.isbn13)}`;
  }
  return '';
}

function onCardCoverError(item: ResolvedPhotoItem) {
  if (!item.coverFallbackUrls || item.coverFallbackUrls.length === 0) {
    if (item.isbn13) {
      item.coverFallbackUrls = imageUtil.buildCoverCandidates(item.isbn13, [item.coverUrl]);
    }
  }
  imageUtil.advanceCoverFallback(item);
}

function syncValidationFromQueue() {
  const agg = photoBatchQueueService.getAggregatedResults();
  const handled = new Set(scanDraftStore.handledSourceIds.value);

  const knownResolvedIds = new Set(resolvedDetectedItems.value.map((i) => i.id));
  const knownResolvedIsbns = new Set(resolvedDetectedItems.value.map((i) => i.isbn13).filter(Boolean));
  for (const item of agg.sureItems) {
    if (handled.has(item.id) || knownResolvedIds.has(item.id) || (item.isbn13 && knownResolvedIsbns.has(item.isbn13))) continue;
    resolvedDetectedItems.value.push(JSON.parse(JSON.stringify(item)));
    knownResolvedIds.add(item.id);
    if (item.isbn13) knownResolvedIsbns.add(item.isbn13);
  }

  const knownDoubtIds = new Set(doubtItems.value.map((i) => i.id));
  for (const d of agg.doubtItems) {
    if (!handled.has(d.id) && !knownDoubtIds.has(d.id)) {
      doubtItems.value.push(JSON.parse(JSON.stringify(d)));
      knownDoubtIds.add(d.id);
    }
  }

  const knownUnresolvedIds = new Set(unresolvedItems.value.map((i) => i.id));
  for (const u of agg.unresolvedItems) {
    if (!handled.has(u.id) && !knownUnresolvedIds.has(u.id)) {
      unresolvedItems.value.push(JSON.parse(JSON.stringify(u)));
      knownUnresolvedIds.add(u.id);
    }
  }

  // Maintenir strictement l'ordre physique de chaque photo (gauche -> droite)
  sortItemsByShelfOrder(resolvedDetectedItems.value);
  sortItemsByShelfOrder(doubtItems.value);
  sortItemsByShelfOrder(unresolvedItems.value);

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
  applyEditionChoice(item, option.isbn13);
}

function applyEditionChoice(item: ResolvedPhotoItem, selectedIsbn: string) {
  const opt = (item.alternatives || []).find((a) => a.isbn13 === selectedIsbn);
  if (!opt) return;
  if (opt.isbn13 !== item.isbn13) {
    item.existingUri = undefined;
    item.existingWorkUri = undefined;
    item.knownIsbns = [opt.isbn13];
    item.alreadyOwned = false;
    item.alreadyWished = false;
  }
  item.selectedAlternativeIsbn = opt.isbn13;
  item.isbn13 = opt.isbn13;
  item.title = opt.title;
  if (opt.authors?.length) item.authors = opt.authors;
  item.publisher = opt.publisher;
  item.publishDate = opt.publishDate;
  item.pageCount = opt.pageCount;
  if (opt.coverUrl) item.coverUrl = opt.coverUrl;
  if (opt.coverFallbackUrls?.length) item.coverFallbackUrls = opt.coverFallbackUrls;
  item.series = opt.series || item.series;
  item.seriesNumber = opt.isIntegral ? undefined : opt.seriesNumber || item.seriesNumber;
  item.isIntegral = Boolean(opt.isIntegral);
  if (opt.isIntegral && (opt as any).includedVolumeNumbers?.length) {
    item.includedVolumeNumbers = (opt as any).includedVolumeNumbers;
  }
  item.selected = true;
}

function handleDetailUpdateFields(
  item: ResolvedPhotoItem,
  payload: {
    title: string;
    series: string;
    seriesNumber: string;
    isIntegral: boolean;
    includedVolumeNumbers?: string[];
    selected: boolean;
  }
) {
  if (payload.title) item.title = payload.title;
  item.series = payload.series || undefined;
  item.seriesNumber = payload.isIntegral ? undefined : payload.seriesNumber || undefined;
  item.isIntegral = payload.isIntegral;
  item.includedVolumeNumbers =
    payload.isIntegral && payload.includedVolumeNumbers?.length ? payload.includedVolumeNumbers : undefined;
  item.selected = payload.selected;
}

async function handleDetailRetryBnf(item: ResolvedPhotoItem, candidate: RecognizedBookCandidate) {
  item.rawCandidate = { ...candidate };
  retryingItemIds.value = { ...retryingItemIds.value, [item.id]: true };
  try {
    const resolved = await photoBookResolutionService.resolveSingleCandidate(candidate, 'retry', undefined, {
      priority: 'high',
      bypassCache: true
    });
    resolved.sourceJobId = item.sourceJobId;
    if (resolved.status === 'unresolved') {
      item.failureReason = resolved.failureReason || 'Toujours introuvable sur la BnF / Google Books.';
      return;
    }
    const oldId = item.id;
    scanDraftStore.markSourceIdHandled(oldId);
    resolvedDetectedItems.value = resolvedDetectedItems.value.filter((i) => i.id !== oldId);
    doubtItems.value = doubtItems.value.filter((d) => d.id !== oldId);
    unresolvedItems.value = unresolvedItems.value.filter((u) => u.id !== oldId);
    if (resolved.status === 'doubt') {
      doubtItems.value.push(resolved);
      sortItemsByShelfOrder(doubtItems.value);
    } else {
      resolvedDetectedItems.value.push(resolved);
      sortItemsByShelfOrder(resolvedDetectedItems.value);
    }
    activeDetailItemId.value = resolved.id;
  } finally {
    const next = { ...retryingItemIds.value };
    delete next[item.id];
    retryingItemIds.value = next;
  }
}

async function handlePhotoSelected(event: Event, mode: 'cover' | 'shelf') {
  const input = event.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length === 0) return;

  photoError.value = '';
  try {
    if (serverVisionStatus.value && !serverVisionStatus.value.serverAvailable) {
      throw new Error('Service de reconnaissance IA temporairement indisponible.');
    }
    const count = await photoBatchQueueService.enqueuePhotos(files, mode);
    photoSavingFeedback.value = `${count} photo(s) ajoutée(s) à la file ! Le traitement s'effectue automatiquement (y compris relance sur saturation Gemini).`;
    setTimeout(() => {
      photoSavingFeedback.value = '';
    }, 5000);
  } catch (err: unknown) {
    photoError.value = err instanceof Error ? err.message : "Erreur lors de l'ajout des photos.";
  } finally {
    input.value = '';
    refreshServerVisionStatus();
  }
}

async function retryUnresolvedItem(item: ResolvedPhotoItem, priority: 'high' | 'normal' = 'high') {
  if (!item.rawCandidate.title.trim() && !item.rawCandidate.isbn?.trim() && !item.rawCandidate.series?.trim()) return;
  retryingItemIds.value = { ...retryingItemIds.value, [item.id]: true };
  try {
    const resolved = await photoBookResolutionService.resolveSingleCandidate(
      item.rawCandidate,
      priority === 'high' ? 'retry' : 'autoretry',
      undefined,
      { priority, bypassCache: true }
    );
    resolved.sourceJobId = item.sourceJobId;
    if (resolved.status === 'unresolved') {
      item.failureReason = resolved.failureReason || 'Toujours introuvable sur la BnF / Google Books.';
      return;
    }
    scanDraftStore.markSourceIdHandled(item.id);
    unresolvedItems.value = unresolvedItems.value.filter((u) => u.id !== item.id);
    if (resolved.status === 'doubt') {
      doubtItems.value.push(resolved);
      sortItemsByShelfOrder(doubtItems.value);
      return;
    }
    const alreadyExists = resolved.isbn13 && resolvedDetectedItems.value.some((d) => d.isbn13 === resolved.isbn13);
    if (!alreadyExists) {
      resolvedDetectedItems.value.push(resolved);
      sortItemsByShelfOrder(resolvedDetectedItems.value);
    }
  } finally {
    const next = { ...retryingItemIds.value };
    delete next[item.id];
    retryingItemIds.value = next;
  }
}

async function retryAllUnresolvedItems() {
  if (retryAllProgress.value.active || unresolvedItems.value.length === 0) return;
  const targetIds = unresolvedItems.value.map((u) => u.id);
  retryAllProgress.value = { active: true, done: 0, total: targetIds.length };
  try {
    for (const targetId of targetIds) {
      const liveItem = unresolvedItems.value.find((u) => u.id === targetId);
      if (liveItem) {
        await retryUnresolvedItem(liveItem, 'normal');
      }
      retryAllProgress.value.done++;
    }
  } finally {
    retryAllProgress.value = { active: false, done: 0, total: 0 };
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
    if (key === seriesKey && !item.alreadyOwned) item.selected = selectAll;
  }
}

function toggleAllSeriesExtras(selectAll: boolean) {
  for (const item of seriesExtraItems.value) {
    if (!item.alreadyOwned) item.selected = selectAll;
  }
}

const groupedSeriesExtras = computed(() => {
  const map = new Map<string, { seriesKey: string; seriesName: string; items: ResolvedPhotoItem[] }>();
  for (const item of seriesExtraItems.value) {
    const seriesName = item.series?.trim() || 'Autres';
    const seriesKey = normalizeTextKey(seriesName) || 'autres';
    const existing = map.get(seriesKey);
    if (existing) existing.items.push(item);
    else map.set(seriesKey, { seriesKey, seriesName, items: [item] });
  }
  return Array.from(map.values()).map((g) => ({
    ...g,
    selectedCount: g.items.filter((i) => i.selected).length
  }));
});

const selectedDoubtCount = computed(
  () => doubtItems.value.filter((c) => c.selected && c.isbn13 && c.selectedAlternativeIsbn !== '__ignore__').length
);
const selectedSeriesCount = computed(() => seriesExtraItems.value.filter((c) => c.selected).length);

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
    isIntegral: item.isIntegral,
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
  if (item.isIntegral) badges.push({ label: 'Intégrale', tone: 'consensus' });
  else if (item.hasIntegralOption) badges.push({ label: 'Intégrale dispo', tone: 'warn' });
  if (item.correctedFromAi) badges.push({ label: 'Corrigé BnF', tone: 'info' });
  if (item.sourcesCount && item.sourcesCount > 1) badges.push({ label: `${item.sourcesCount} sources`, tone: 'consensus' });
  if (!item.coverUrl) badges.push({ label: 'Sans couverture', tone: 'warn' });
  return badges;
};

const isAllPhotoDetectedSelected = computed(
  () => resolvedDetectedItems.value.length > 0 && resolvedDetectedItems.value.every((i) => i.selected)
);

const toggleAllPhotoDetected = (checked: boolean) => {
  for (const item of resolvedDetectedItems.value) item.selected = checked;
};

const allSelectedPhotoItems = computed(() => {
  const sure = resolvedDetectedItems.value.filter((c) => c.selected && (c.isbn13 || c.existingUri));
  const doubts = doubtItems.value.filter(
    (c) => c.selected && (c.isbn13 || c.existingUri) && c.selectedAlternativeIsbn !== '__ignore__'
  );
  const extras = seriesExtraItems.value.filter((c) => c.selected && (c.isbn13 || c.existingUri));
  return [...sure, ...doubts, ...extras];
});

const selectedPhotoBooks = computed(() => allSelectedPhotoItems.value.map((item) => photoItemToBook(item)));

const clearPhotoSelections = () => {
  for (const i of resolvedDetectedItems.value) i.selected = false;
  for (const d of doubtItems.value) d.selected = false;
  for (const e of seriesExtraItems.value) e.selected = false;
};

async function enqueueFallbackItem(rawItem: ResolvedPhotoItem, target: 'owned' | 'wish' | 'none') {
  const item = JSON.parse(JSON.stringify(rawItem)) as ResolvedPhotoItem;
  if (!item.isbn13 && !item.existingUri) return;
  if (item.existingUri && (target === 'owned' || target === 'wish')) {
    const existingLocal = await databaseService.getBookFromCache(item.existingUri);
    if (!existingLocal) {
      const bookToCache = photoItemToBook(item);
      bookToCache.ownershipStatus = target;
      await databaseService.saveBookToCache(bookToCache);
    }
    await queueService.enqueueAction(target === 'owned' ? 'ADD_INVENTORY' : 'ADD_WISHLIST', item.existingUri);
    return;
  }
  await backgroundCreationOrchestrator.enqueueBookCreation({
    tempBook: {
      uri: item.existingUri || `isbn:${item.isbn13}`,
      workUri: item.existingWorkUri,
      type: 'edition',
      isbn13: item.isbn13,
      knownIsbns: item.knownIsbns,
      title: item.title,
      authors: item.authors.length ? item.authors : ['Auteur inconnu'],
      illustrators: [],
      scriptwriters: [],
      publisher: item.publisher || '',
      publishDate: item.publishDate,
      pageCount: item.pageCount,
      coverUrl: item.coverUrl,
      coverFallbackUrls: item.coverFallbackUrls,
      series: item.series,
      seriesNumber: item.seriesNumber,
      genres: [],
      ownershipStatus: target
    },
    ownershipTarget: target,
    expandSeries: false
  });
}

const dispatchPhotoBatchAction = async (
  action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE'
) => {
  if (ingestProgress.value.active) return;
  const itemsToSave = allSelectedPhotoItems.value;
  if (itemsToSave.length === 0) return;

  photoError.value = '';
  lastSavedToCollection.value = false;
  try {
    if (action === 'DELETE') {
      const removedSet = new Set(itemsToSave.map((i) => i.id));
      for (const rid of removedSet) scanDraftStore.markSourceIdHandled(rid);
      resolvedDetectedItems.value = resolvedDetectedItems.value.filter((i) => !removedSet.has(i.id));
      doubtItems.value = doubtItems.value.filter((d) => !removedSet.has(d.id));
      seriesExtraItems.value = seriesExtraItems.value.filter((e) => !removedSet.has(e.id));
      return;
    }

    const target: 'owned' | 'wish' = action === 'ADD_WISHLIST' ? 'wish' : 'owned';
    const processedKeys = new Set<string>();
    const itemsDeduped: ResolvedPhotoItem[] = [];
    for (const item of itemsToSave) {
      const key = item.isbn13 || item.existingUri || item.id;
      if (processedKeys.has(key)) continue;
      processedKeys.add(key);
      itemsDeduped.push(item);
    }

    const isbnsToIngest = itemsDeduped
      .map((i) => i.isbn13)
      .filter((x): x is string => Boolean(x && !x.startsWith('work:')));

    const hintsByIsbn: Record<string, UserIngestHint> = {};
    for (const item of itemsDeduped) {
      if (item.isbn13) {
        hintsByIsbn[item.isbn13] = {
          title: item.title,
          series: item.series,
          volumeNumber: item.isIntegral ? undefined : item.seriesNumber,
          isIntegral: Boolean(item.isIntegral),
          includedVolumeNumbers:
            item.isIntegral && item.includedVolumeNumbers?.length ? item.includedVolumeNumbers : undefined,
          coverUrl: item.coverUrl
        };
      }
    }

    ingestProgress.value = {
      active: true,
      done: 0,
      total: isbnsToIngest.length || itemsDeduped.length,
      label: target === 'owned' ? 'Ajout dans ma Collection...' : 'Ajout à ma Wishlist...'
    };
    const v4Batch = isbnsToIngest.length
      ? await ingestIsbnsViaV4({
          isbns: isbnsToIngest,
          sourceChannel: 'canal_4_ai_photo',
          action: target === 'owned' ? 'owned' : 'wishlist',
          chunkSize: 1,
          hints: hintsByIsbn,
          onProgress: (done, total) => {
            ingestProgress.value = {
              active: true,
              done,
              total,
              label:
                target === 'owned'
                  ? `Indexation et ajout dans ma Collection (${done}/${total})...`
                  : `Ajout à ma Wishlist (${done}/${total})...`
            };
          }
        })
      : null;

    const v4ByIsbn = new Map<string, any>();
    const integralAlerts: string[] = [];
    for (const r of v4Batch?.results || []) {
      if (r.book && r.normalizedIsbn13) v4ByIsbn.set(r.normalizedIsbn13, r);
      const notice = formatV4StatusNotice(r);
      if (
        notice &&
        (r.layer2Status === 'INCLUDED_IN_INTEGRAL' ||
          r.layer2Status === 'PARTIAL_INTEGRAL_OWNED' ||
          r.layer2Status === 'FULL_INTEGRAL_OWNED')
      ) {
        integralAlerts.push(notice);
      }
    }

    let savedCount = 0;
    for (const item of itemsDeduped) {
      const v4Hit = item.isbn13 ? v4ByIsbn.get(item.isbn13) : undefined;
      if (v4Hit?.book) {
        const bookToCache = v4BookRecordToHumanizedBook(v4Hit.book, target);
        await databaseService.saveBookToCache(bookToCache);
        if (target === 'owned') {
          await databaseService.addRegistryEntry('inventory', bookToCache.uri).catch(() => {});
          await databaseService.removeRegistryEntry?.('wishlist', bookToCache.uri).catch(() => {});
        } else {
          await databaseService.addRegistryEntry('wishlist', bookToCache.uri).catch(() => {});
        }
        savedCount++;
        continue;
      }
      await enqueueFallbackItem(item, target);
      savedCount++;
    }

    const savedSet = new Set(itemsToSave.map((i) => i.id));
    for (const sid of savedSet) scanDraftStore.markSourceIdHandled(sid);
    resolvedDetectedItems.value = resolvedDetectedItems.value.filter((i) => !savedSet.has(i.id));
    doubtItems.value = doubtItems.value.filter((d) => !savedSet.has(d.id));
    seriesExtraItems.value = seriesExtraItems.value.filter((e) => !savedSet.has(e.id));

    if (
      resolvedDetectedItems.value.length === 0 &&
      doubtItems.value.length === 0 &&
      unresolvedItems.value.length === 0
    ) {
      await photoBatchQueueService.clearCompletedJobs();
      scanDraftStore.clearAll();
    }
    scannerState.notifyCatalogChanged();
    lastSavedToCollection.value = target === 'owned' && savedCount > 0;
    const alertSuffix = integralAlerts.length ? ` — ${integralAlerts.join(' ')}` : '';
    photoSavingFeedback.value = `${savedCount} livre(s) enregistré(s) dans ${target === 'owned' ? 'ma Collection' : 'ma Wishlist'} ✓${alertSuffix}`;
    setTimeout(() => {
      photoSavingFeedback.value = '';
    }, 9000);
  } catch (err: unknown) {
    photoError.value =
      err instanceof Error ? err.message : "Erreur lors de l'ajout des livres sélectionnés.";
  } finally {
    ingestProgress.value = { active: false, done: 0, total: 0 };
  }
};

async function clearPhotoQueueAndForm() {
  await photoBatchQueueService.clearAllJobs();
  scanDraftStore.clearAll();
}

// ============================================================================
// ONGLET 4 : RECHERCHE TEXTUELLE MULTI-CHAMPS
// ============================================================================
const textSearchForm = ref({
  title: '',
  series: '',
  volumeNumber: '',
  author: '',
  edition: '',
  publisher: '',
  isbn: ''
});
const textSearchBusy = ref(false);
const textSearchError = ref('');
const textSearchFeedback = ref('');
const textSearchDone = ref(false);
const textSearchBooks = ref<HumanizedBook[]>([]);
const textSearchSelectedUris = ref<string[]>([]);
const textSearchBatchBusy = ref(false);
const showTextSearchLendModal = ref(false);

const hasTextSearchCriteria = computed(() => {
  const f = textSearchForm.value;
  return Boolean(
    f.title.trim() ||
      f.series.trim() ||
      f.volumeNumber.trim() ||
      f.author.trim() ||
      f.edition.trim() ||
      f.publisher.trim() ||
      f.isbn.trim()
  );
});

const isAllTextSearchSelected = computed(
  () => textSearchBooks.value.length > 0 && textSearchSelectedUris.value.length === textSearchBooks.value.length
);

const toggleAllTextSearch = (checked: boolean) => {
  textSearchSelectedUris.value = checked ? textSearchBooks.value.map((b) => b.uri) : [];
};

const selectedTextSearchBooks = computed(() =>
  textSearchBooks.value.filter((b) => textSearchSelectedUris.value.includes(b.uri))
);

const resetTextSearchForm = () => {
  textSearchForm.value = {
    title: '',
    series: '',
    volumeNumber: '',
    author: '',
    edition: '',
    publisher: '',
    isbn: ''
  };
  textSearchBooks.value = [];
  textSearchSelectedUris.value = [];
  textSearchError.value = '';
  textSearchFeedback.value = '';
  textSearchDone.value = false;
};

const optionToHumanizedBook = async (opt: Canal3ResolutionOption): Promise<HumanizedBook | null> => {
  const isbn13 = String(opt.isbn13 || '').trim();
  if (!isbn13) return null;
  const uri = `isbn:${isbn13}`;
  const cached = await databaseService.getBookFromCache(uri).catch(() => null);
  const candidates = imageUtil.buildCoverCandidates(isbn13, [opt.meta?.coverUrl]);
  return {
    uri: cached?.uri || uri,
    bookId: cached?.bookId,
    type: 'edition',
    isbn13,
    title: cached?.title || opt.meta?.title || 'Titre inconnu',
    authors: cached?.authors?.length ? cached.authors : (opt.meta?.authors?.length ? opt.meta.authors : ['Auteur inconnu']),
    illustrators: cached?.illustrators || [],
    scriptwriters: cached?.scriptwriters || [],
    publisher: cached?.publisher || opt.meta?.publisher,
    publishDate: cached?.publishDate || opt.meta?.publishDate,
    series: cached?.series || opt.meta?.series,
    seriesId: cached?.seriesId,
    seriesNumber: cached?.seriesNumber || opt.meta?.seriesNumber,
    collection: cached?.collection || opt.meta?.collection,
    genres: cached?.genres || [],
    coverUrl: cached?.localCover || cached?.coverUrl || candidates[0],
    coverFallbackUrls: cached?.coverFallbackUrls || candidates,
    ownershipStatus: cached?.ownershipStatus || 'none',
    wishedByName: cached?.wishedByName,
    loan: cached?.loan
  };
};

const handleMultiFieldSearch = async () => {
  if (!hasTextSearchCriteria.value || textSearchBusy.value) return;
  textSearchBusy.value = true;
  textSearchError.value = '';
  textSearchFeedback.value = '';
  textSearchDone.value = false;
  textSearchBooks.value = [];
  textSearchSelectedUris.value = [];

  try {
    const f = textSearchForm.value;
    const cleanedIsbn = f.isbn.trim() ? isbnUtil.normalize(f.isbn.trim()) : '';

    if (cleanedIsbn && isbnUtil.isValidFormat(cleanedIsbn)) {
      const isbn13 = cleanedIsbn.length === 10 ? isbnUtil.toIsbn13(cleanedIsbn) : cleanedIsbn;
      const res = await searchService.searchByIsbn(isbn13);
      if ((res as any)?.isOfflineUnavailable) {
        pendingScansStore.addPendingScan(isbn13);
        textSearchError.value = `Hors réseau : l'ISBN ${isbn13} a été mémorisé pour consultation ultérieure.`;
        return;
      }
      if (res?.mainBook) {
        textSearchBooks.value = [res.mainBook];
        saveBookNavigationOrder([res.mainBook.uri], 'direct');
      }
      textSearchDone.value = true;
      return;
    }

    const resolved = await resolveHintsViaV4Backend({
      hints: {
        title: f.title.trim() || undefined,
        series: f.series.trim() || undefined,
        volumeNumber: f.volumeNumber.trim() || undefined,
        author: f.author.trim() || undefined,
        collection: f.edition.trim() || undefined,
        publisher: f.publisher.trim() || undefined
      },
      sourceChannel: 'canal_3_text_search',
      skipLocalD1: false
    });

    if (!resolved) {
      textSearchError.value = 'Service de recherche temporairement indisponible.';
      return;
    }

    const seen = new Set<string>();
    const books: HumanizedBook[] = [];
    const pushOption = async (opt: Canal3ResolutionOption) => {
      const code = String(opt.isbn13 || '').trim();
      if (!code || seen.has(code)) return;
      seen.add(code);
      const book = await optionToHumanizedBook(opt);
      if (book) books.push(book);
    };

    if (resolved.isbn13 && resolved.meta) {
      await pushOption({
        isbn13: resolved.isbn13,
        meta: resolved.meta,
        sourcesCount: resolved.sourcesCount || 1,
        confidenceScore: 100
      });
    }
    for (const alt of resolved.alternatives || []) {
      await pushOption(alt);
    }

    const allCached = await databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]);
    textSearchBooks.value = annotateIntegralCoverage(books, allCached);
    saveBookNavigationOrder(books.map((b) => b.uri), 'direct');
    textSearchDone.value = true;
  } catch (e: unknown) {
    textSearchError.value = e instanceof Error ? e.message : 'Erreur lors de la recherche.';
  } finally {
    textSearchBusy.value = false;
  }
};

const dispatchTextSearchBatchAction = async (
  action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE'
) => {
  if (selectedTextSearchBooks.value.length === 0) return;
  if (action === 'LEND') {
    showTextSearchLendModal.value = true;
    return;
  }
  textSearchBatchBusy.value = true;
  textSearchError.value = '';
  textSearchFeedback.value = '';
  let processed = 0;

  try {
    for (const book of selectedTextSearchBooks.value) {
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
        const v4Action = action === 'ADD_INVENTORY' ? 'owned' : 'wishlist';
        const cleanIsbn = book.isbn13 || (book.uri.startsWith('isbn:') ? book.uri.slice(5) : '');
        if (cleanIsbn) {
          const batch = await ingestIsbnsViaV4([cleanIsbn], {
            sourceChannel: 'canal_3_text_search',
            action: v4Action,
            hints: {
              [cleanIsbn]: {
                title: book.title,
                series: book.series,
                volumeNumber: book.isIntegral ? undefined : book.seriesNumber,
                isIntegral: Boolean(book.isIntegral),
                includedVolumeNumbers: book.isIntegral ? book.integralMetadata?.includedVolumeNumbers : undefined,
                coverUrl: book.coverUrl
              }
            }
          });
          const first = batch?.results?.[0];
          if (first?.book) {
            const humanized = v4BookRecordToHumanizedBook(first.book, targetStatus);
            await databaseService.saveBookToCache(humanized);
            await databaseService.addRegistryEntry(
              action === 'ADD_INVENTORY' ? 'inventory' : 'wishlist',
              humanized.uri
            );
            Object.assign(book, humanized);
            processed++;
            continue;
          }
        }
        await queueService.enqueueAction(action, book.uri);
        book.ownershipStatus = targetStatus;
        processed++;
      }
    }
    textSearchSelectedUris.value = [];
    textSearchFeedback.value = `${processed} ouvrage(s) mis à jour.`;
    scannerState.notifyCatalogChanged();
  } catch (e: unknown) {
    textSearchError.value = e instanceof Error ? e.message : 'Erreur lors du traitement.';
  } finally {
    textSearchBatchBusy.value = false;
  }
};

const confirmTextSearchGroupLend = async (friendName: string) => {
  showTextSearchLendModal.value = false;
  if (!friendName || selectedTextSearchBooks.value.length === 0) return;
  for (const book of selectedTextSearchBooks.value) {
    if (book.ownershipStatus !== 'owned') {
      await queueService.enqueueAction('ADD_INVENTORY', book.uri);
      book.ownershipStatus = 'owned';
    }
    await queueService.enqueueAction('LEND', book.uri, { friendName });
    book.loan = { uri: book.uri, friendName, loanDate: Date.now() };
  }
  textSearchFeedback.value = `${selectedTextSearchBooks.value.length} livre(s) prêté(s) à ${friendName}.`;
  textSearchSelectedUris.value = [];
  scannerState.notifyCatalogChanged();
};
</script>

<template>
  <div class="view-container scan-view">
    <BaseHeader />
    <BaseTitle text="Recherche &amp; Acquisitions" level="h2" />

    <!-- Sélecteur des 4 modes de recherche et numérisation côte à côte -->
    <div class="scan-mode-tabs" role="tablist" aria-label="Mode de recherche et d'acquisition">
      <button
        type="button"
        role="tab"
        :aria-selected="activeMode === 'photo'"
        class="scan-tab-btn"
        :class="{ active: activeMode === 'photo' }"
        @click="selectTab('photo')"
      >
        <span>Photo IA</span>
        <span v-if="photoStats.totalPhotos > 0" class="tab-badge">{{ photoStats.totalPhotos }}</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeMode === 'burst'"
        class="scan-tab-btn"
        :class="{ active: activeMode === 'burst' }"
        @click="selectTab('burst')"
      >
        <span>Rafale</span>
        <span v-if="burstBooks.length > 0" class="tab-badge">{{ burstBooks.length }}</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeMode === 'simple'"
        class="scan-tab-btn"
        :class="{ active: activeMode === 'simple' }"
        @click="selectTab('simple')"
      >
        <span>Scan simple</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeMode === 'search'"
        class="scan-tab-btn"
        :class="{ active: activeMode === 'search' }"
        @click="selectTab('search')"
      >
        <span>Recherche textuelle</span>
      </button>
    </div>

    <!-- ================================================================ -->
    <!-- ONGLET 1 : PHOTO ÉTAGÈRE / COUVERTURE (IA + ARBITRAGE ÉDITIONS)  -->
    <!-- ================================================================ -->
    <section v-if="activeMode === 'photo'" class="scan-section">
      <div class="scan-card">
        <div class="byok-header-bar">
          <span>
            Reconnaissance IA :
            <strong v-if="serverVisionStatus?.serverAvailable">
              {{ serverVisionStatus.remainingQuota }} / {{ serverVisionStatus.monthlyQuota }} analyses restantes ce mois-ci
            </strong>
            <strong v-else>Vérification...</strong>
          </span>
          <button v-if="hidePhotoHelp" type="button" class="link-btn" @click="showPhotoHelp">
            Aide
          </button>
        </div>

        <div v-if="!hidePhotoHelp" class="photo-help-card">
          <div class="photo-help-header">
            <strong>Acquisition multi-livres par photo</strong>
            <button type="button" class="link-btn" @click="dismissPhotoHelp">Ne plus afficher</button>
          </div>
          <p class="photo-help-text">
            Importez une ou plusieurs photos (étagère, pile ou couverture). Sur les séries avec plusieurs éditions
            (ex. <strong>Tome unitaire</strong> vs <strong>Intégrale</strong>), un menu déroulant vous permet de choisir
            l'édition exacte avant l'enregistrement.
          </p>
        </div>

        <div class="photo-triggers-grid">
          <label class="photo-trigger-card">
            <input type="file" accept="image/*" capture="environment" hidden @change="(e) => handlePhotoSelected(e, 'shelf')" />
            <strong>Prendre une photo</strong>
            <small>Étagère, pile ou couverture</small>
          </label>
          <label class="photo-trigger-card">
            <input type="file" accept="image/*" multiple hidden @change="(e) => handlePhotoSelected(e, 'shelf')" />
            <strong>Choisir dans la galerie</strong>
            <small>Une ou plusieurs photos</small>
          </label>
        </div>
      </div>

      <!-- Suivi file IA / Canal 3 -->
      <div v-if="photoStats.totalPhotos > 0" class="scan-card">
        <div class="queue-progress-header">
          <strong>{{ isPhotoProcessing ? 'Traitement IA & BnF en cours' : 'Résumé du lot photo' }}</strong>
          <div class="queue-header-actions">
            <button
              v-if="photoStats.errorPhotos > 0"
              type="button"
              class="wireframe-btn small-btn"
              @click="photoBatchQueueService.retryFailedJobs()"
            >
              Relancer erreurs ({{ photoStats.errorPhotos }})
            </button>
            <button type="button" class="wireframe-btn small-btn" @click="clearPhotoQueueAndForm">
              Vider le lot
            </button>
          </div>
        </div>
        <div class="queue-metrics-grid">
          <span><strong>{{ photoStats.aiDonePhotos }}/{{ photoStats.totalPhotos }}</strong> photos lues</span>
          <span><strong>{{ photoStats.totalBooksDetected }}</strong> tranches extraites</span>
          <span><strong>{{ photoStats.sureCount }}</strong> sûr(s) • <strong>{{ photoStats.doubtCount }}</strong> doute(s) • <strong>{{ photoStats.unresolvedCount }}</strong> non trouvé(s)</span>
        </div>
        <div v-if="isPhotoProcessing && photoLoadingStatus" class="queue-live-step">
          {{ photoLoadingStatus }}
        </div>
      </div>

      <!-- Barre d'avancement d'enregistrement V4 -->
      <div v-if="ingestProgress.active" class="scan-card progress-card">
        <strong>Enregistrement pipeline V4 en cours : {{ ingestProgress.done }} / {{ ingestProgress.total }} livre(s)...</strong>
        <div class="progress-track">
          <div
            class="progress-fill"
            :style="{ width: `${Math.round((ingestProgress.done / Math.max(1, ingestProgress.total)) * 100)}%` }"
          ></div>
        </div>
      </div>

      <div v-if="photoError" class="error-banner">{{ photoError }}</div>
      <div v-if="photoSavingFeedback" class="success-banner feedback-with-cta">
        <span>{{ photoSavingFeedback }}</span>
        <button
          v-if="lastSavedToCollection"
          type="button"
          class="wireframe-btn small-btn primary"
          @click="router.push('/collection')"
        >
          Voir ma Collection →
        </button>
      </div>

      <!-- Indicateur flottant impossible à manquer pendant l'enregistrement en lot -->
      <Teleport to="body">
        <div v-if="ingestProgress.active" class="ingest-sticky-toast" role="status" aria-live="polite">
          <div class="ingest-toast-row">
            <span class="ingest-spinner" aria-hidden="true"></span>
            <strong>{{ ingestProgress.label || `Ajout en cours (${ingestProgress.done}/${ingestProgress.total})...` }}</strong>
          </div>
          <div class="progress-track">
            <div
              class="progress-fill"
              :style="{ width: `${Math.round((ingestProgress.done / Math.max(1, ingestProgress.total)) * 100)}%` }"
            ></div>
          </div>
        </div>
      </Teleport>

      <!-- Liste aérée de validation (couverture + case d'action, arbitrage au clic) -->
      <div
        v-if="resolvedDetectedItems.length > 0 || doubtItems.length > 0 || unresolvedItems.length > 0 || seriesExtraItems.length > 0"
        class="scan-card"
      >
        <div v-if="resolvedDetectedItems.length > 0" class="validation-section">
          <div class="section-header-row">
            <label class="select-all-label">
              <input
                type="checkbox"
                class="wireframe-checkbox"
                :checked="isAllPhotoDetectedSelected"
                @change="toggleAllPhotoDetected(($event.target as HTMLInputElement).checked)"
              />
              <span>
                Identifiés ({{ resolvedDetectedItems.filter((c) => c.selected).length }}/{{ resolvedDetectedItems.length }})
              </span>
            </label>
            <button type="button" class="link-btn" @click="clearPhotoQueueAndForm">Tout effacer</button>
          </div>

          <div class="photo-cover-grid">
            <article
              v-for="item in resolvedDetectedItems"
              :key="item.id"
              class="photo-cover-card"
              :class="{ 'is-checked': item.selected, 'is-owned': item.alreadyOwned }"
              @click="openPhotoItemDetail(item)"
            >
              <label class="card-check-corner" @click.stop>
                <input
                  v-model="item.selected"
                  type="checkbox"
                  class="wireframe-checkbox"
                  :aria-label="`Sélectionner ${item.title}`"
                />
              </label>

              <div class="card-cover-frame">
                <img
                  v-if="resolveCardCoverSrc(item)"
                  :src="resolveCardCoverSrc(item)"
                  :alt="item.title"
                  class="card-cover-img"
                  @error="onCardCoverError(item)"
                />
                <div v-else class="card-cover-placeholder">
                  <span>{{ item.title.slice(0, 28) }}</span>
                </div>
                <span v-if="item.isIntegral" class="cover-pill integral">Intégrale</span>
                <span v-else-if="item.seriesNumber" class="cover-pill vol">T.{{ item.seriesNumber }}</span>
                <span v-else-if="item.alreadyOwned" class="cover-pill owned">Acquis</span>
              </div>

              <div class="card-cover-caption">
                <strong class="card-cover-title">{{ item.title }}</strong>
                <button
                  v-if="(item.alternatives?.length || 0) > 1"
                  type="button"
                  class="edition-pill-trigger"
                  @click.stop="openPhotoItemDetail(item)"
                >
                  {{ item.alternatives?.length }} éditions ▸
                </button>
              </div>
            </article>
          </div>
        </div>

        <!-- Résultats incertains à arbitrer dans la sous-vue dédiée -->
        <div v-if="doubtItems.length > 0" class="validation-section doubt-section">
          <div class="section-header-row">
            <h4>À vérifier ({{ selectedDoubtCount }}/{{ doubtItems.length }})</h4>
          </div>

          <div class="photo-cover-grid">
            <article
              v-for="d in doubtItems"
              :key="d.id"
              class="photo-cover-card is-doubt"
              :class="{ 'is-checked': d.selected && d.selectedAlternativeIsbn !== '__ignore__' }"
              @click="openPhotoItemDetail(d)"
            >
              <label class="card-check-corner" @click.stop>
                <input
                  type="checkbox"
                  class="wireframe-checkbox"
                  :checked="d.selected && d.selectedAlternativeIsbn !== '__ignore__'"
                  :disabled="!d.isbn13"
                  :aria-label="`Sélectionner ${d.title}`"
                  @change="d.selected = ($event.target as HTMLInputElement).checked"
                />
              </label>

              <div class="card-cover-frame">
                <img
                  v-if="resolveCardCoverSrc(d)"
                  :src="resolveCardCoverSrc(d)"
                  :alt="d.title"
                  class="card-cover-img"
                  @error="onCardCoverError(d)"
                />
                <div v-else class="card-cover-placeholder">
                  <span>{{ (d.rawCandidate.title || d.title).slice(0, 28) }}</span>
                </div>
                <span v-if="formatCompactShelfPos(d)" class="cover-pill shelf">{{ formatCompactShelfPos(d) }}</span>
                <span v-if="d.isIntegral" class="cover-pill integral" style="top: auto; bottom: 6px; left: 6px;">Intégrale</span>
              </div>

              <div class="card-cover-caption">
                <strong class="card-cover-title">{{ d.title || d.rawCandidate.title }}</strong>
                <button type="button" class="edition-pill-trigger warn" @click.stop="openPhotoItemDetail(d)">
                  {{ d.selected && d.selectedAlternativeIsbn !== '__ignore__' ? 'Édition choisie ▸' : 'Choisir édition ▸' }}
                </button>
              </div>
            </article>
          </div>
        </div>

        <!-- Autres tomes des séries détectées -->
        <div v-if="groupedSeriesExtras.length > 0" class="validation-section">
          <div class="section-header-row">
            <h4>Autres tomes des séries ({{ selectedSeriesCount }}/{{ seriesExtraItems.length }})</h4>
            <div style="display: flex; gap: 0.5rem;">
              <button type="button" class="link-btn" @click="toggleAllSeriesExtras(true)">Tout</button>
              <button type="button" class="link-btn" @click="toggleAllSeriesExtras(false)">Aucun</button>
            </div>
          </div>
          <div v-for="group in groupedSeriesExtras" :key="group.seriesKey" class="series-accordion-card">
            <div class="series-accordion-header">
              <button type="button" class="series-accordion-toggle" @click="toggleSeriesAccordion(group.seriesKey)">
                <span>{{ expandedSeriesKeys[group.seriesKey] ? '▾' : '▸' }} {{ group.seriesName }}</span>
                <small>{{ group.selectedCount }}/{{ group.items.length }}</small>
              </button>
              <div style="display: flex; gap: 0.5rem;">
                <button type="button" class="link-btn" @click="toggleGroupSeriesExtras(group.seriesKey, true)">Tout</button>
                <button type="button" class="link-btn" @click="toggleGroupSeriesExtras(group.seriesKey, false)">Aucun</button>
              </div>
            </div>
            <div v-if="expandedSeriesKeys[group.seriesKey]" class="series-inner-list">
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

        <!-- Non identifiés / Edition manuelle (ouvrable dans la sous-vue) -->
        <div v-if="unresolvedItems.length > 0" class="validation-section unresolved-section">
          <div class="section-header-row">
            <h4>Non identifiés ({{ unresolvedItems.length }})</h4>
            <button
              type="button"
              class="wireframe-btn small-btn"
              :disabled="retryAllProgress.active"
              @click="retryAllUnresolvedItems"
            >
              {{
                retryAllProgress.active
                  ? `Relance BnF (${retryAllProgress.done}/${retryAllProgress.total})...`
                  : `Tout relancer (${unresolvedItems.length})`
              }}
            </button>
          </div>
          <div class="photo-cover-grid">
            <article
              v-for="u in unresolvedItems"
              :key="u.id"
              class="photo-cover-card is-unresolved"
              @click="openPhotoItemDetail(u)"
            >
              <div class="card-cover-frame">
                <div class="card-cover-placeholder">
                  <span>{{ (u.rawCandidate.title || u.rawCandidate.rawSpineText || '?').slice(0, 32) }}</span>
                </div>
                <span v-if="formatCompactShelfPos(u)" class="cover-pill shelf">{{ formatCompactShelfPos(u) }}</span>
              </div>
              <div class="card-cover-caption">
                <strong class="card-cover-title">{{ u.rawCandidate.title || u.rawCandidate.rawSpineText }}</strong>
                <button type="button" class="edition-pill-trigger warn" @click.stop="openPhotoItemDetail(u)">
                  Rechercher ▸
                </button>
              </div>
            </article>
          </div>
        </div>

        <BatchActionBar
          :inline="true"
          :selected-count="selectedPhotoBooks.length"
          :selected-books="selectedPhotoBooks"
          :busy="ingestProgress.active"
          :busy-label="ingestProgress.label"
          @execute="dispatchPhotoBatchAction"
          @clear="clearPhotoSelections"
        />
      </div>

      <PhotoItemDetailModal
        :show="Boolean(activeDetailItem)"
        :item="activeDetailItem"
        :source-photo-url="activeDetailPhotoUrl"
        :position-label="activeDetailPosLabel"
        :retrying="Boolean(activeDetailItem && retryingItemIds[activeDetailItem.id])"
        @close="closePhotoItemDetail"
        @select-option="(opt) => { if (activeDetailItem) selectDoubtOption(activeDetailItem, opt); }"
        @update-fields="(p) => { if (activeDetailItem) handleDetailUpdateFields(activeDetailItem, p); }"
        @retry-bnf="(cand) => { if (activeDetailItem) handleDetailRetryBnf(activeDetailItem, cand); }"
      />
    </section>

    <!-- ================================================================ -->
    <!-- ONGLET 2 : RAFALE CODE-BARRES (LA MODALE CAMÉRA S'OUVRE AU CLIC) -->
    <!-- ================================================================ -->
    <section v-if="activeMode === 'burst'" class="scan-section">
      <div v-if="burstFeedback" class="success-banner">{{ burstFeedback }}</div>

      <div v-if="burstBooks.length === 0" class="scan-card empty-burst-card">
        <p class="simple-hint" style="margin: 0;">
          Aucun livre scanné pour le moment. Appuyez sur l'onglet <strong>Rafale</strong> ci-dessus pour ouvrir la caméra : les fiches de vos livres apparaîtront ici dès que vous fermerez la fenêtre.
        </p>
      </div>

      <div v-else class="scan-card">
        <div class="section-header-row">
          <label class="select-all-label">
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
            class="link-btn"
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
          >
            <template #extra>
              <button type="button" class="inline-integral-trigger" @click="toggleInlineIntegralEditor(livre)">
                {{ livre.isIntegral ? 'Modifier intégrale' : 'Déclarer intégrale' }}
              </button>
              <div v-if="editingIntegralBookUri === livre.uri" class="inline-integral-panel">
                <IntegralConfigFields
                  v-model:is-integral="inlineIntegralFlag"
                  v-model:included-volumes-text="inlineIntegralVolsText"
                  :compact="true"
                  :disabled="inlineIntegralSaving"
                  :input-id="`burst-int-${livre.uri}`"
                />
                <div class="inline-integral-actions">
                  <button type="button" class="wireframe-btn small-btn primary" :disabled="inlineIntegralSaving" @click="applyInlineIntegralEditor(livre)">
                    Valider
                  </button>
                  <button type="button" class="wireframe-btn small-btn" :disabled="inlineIntegralSaving" @click="editingIntegralBookUri = null">
                    Fermer
                  </button>
                </div>
              </div>
            </template>
          </BookMiniCard>
        </WireframeTable>

        <BatchActionBar
          :inline="true"
          :selected-count="burstSelectedUris.length"
          :selected-books="selectedBurstBooks"
          @execute="dispatchBurstBatchAction"
          @clear="burstSelectedUris = []"
        />
      </div>

      <LendModal
        :show="showBurstLendModal"
        :bookCount="selectedBurstBooks.length"
        @close="showBurstLendModal = false"
        @confirm="confirmBurstGroupLend"
      />
    </section>

    <!-- ================================================================ -->
    <!-- ONGLET 3 : SCAN SIMPLE (CAMÉRA -> AFFICHAGE IDENTIQUE AU RAFALE) -->
    <!-- ================================================================ -->
    <section v-if="activeMode === 'simple'" class="scan-section">
      <div v-if="simpleFeedback" class="success-banner">{{ simpleFeedback }}</div>

      <div v-if="scannerState.isSimpleResolving.value" class="scan-card progress-card simple-loading-card">
        <div class="ingest-toast-row">
          <span class="ingest-spinner" aria-hidden="true"></span>
          <strong>
            Chargement de l'ouvrage ({{ scannerState.simpleResolvingIsbn.value }}) en cours...
          </strong>
        </div>
      </div>

      <div v-if="simpleBooks.length === 0" class="scan-card empty-burst-card">
        <p class="simple-hint" style="margin: 0;">
          Aucun livre scanné pour le moment. Appuyez sur l'onglet <strong>Scan simple</strong> ci-dessus pour ouvrir la caméra : la fiche apparaîtra ici dès que vous fermerez la fenêtre.
        </p>
      </div>

      <div v-else class="scan-card">
        <div class="section-header-row">
          <label class="select-all-label">
            <input
              type="checkbox"
              class="wireframe-checkbox"
              :checked="isAllSimpleSelected"
              @change="toggleAllSimple(($event.target as HTMLInputElement).checked)"
            />
            <span>
              {{ simpleSelectedUris.length === 0 ? `Tout cocher (${simpleBooks.length})` : `${simpleSelectedUris.length} sélectionné(s)` }}
            </span>
          </label>
          <button
            type="button"
            class="link-btn"
            @click="() => { scannerState.clearSimpleBooks(); simpleSelectedUris = []; }"
          >
            Vider la liste
          </button>
        </div>

        <WireframeTable>
          <BookMiniCard
            v-for="livre in simpleBooks"
            :key="livre.uri"
            :book="livre"
            :model-value="simpleSelectedUris.includes(livre.uri)"
            @update:model-value="(val) => {
              if (val) {
                if (!simpleSelectedUris.includes(livre.uri)) simpleSelectedUris.push(livre.uri);
              } else {
                const idx = simpleSelectedUris.indexOf(livre.uri);
                if (idx > -1) simpleSelectedUris.splice(idx, 1);
              }
            }"
          >
            <template #extra>
              <button type="button" class="inline-integral-trigger" @click="toggleInlineIntegralEditor(livre)">
                {{ livre.isIntegral ? 'Modifier intégrale' : 'Déclarer intégrale' }}
              </button>
              <div v-if="editingIntegralBookUri === livre.uri" class="inline-integral-panel">
                <IntegralConfigFields
                  v-model:is-integral="inlineIntegralFlag"
                  v-model:included-volumes-text="inlineIntegralVolsText"
                  :compact="true"
                  :disabled="inlineIntegralSaving"
                  :input-id="`simple-int-${livre.uri}`"
                />
                <div class="inline-integral-actions">
                  <button type="button" class="wireframe-btn small-btn primary" :disabled="inlineIntegralSaving" @click="applyInlineIntegralEditor(livre)">
                    Valider
                  </button>
                  <button type="button" class="wireframe-btn small-btn" :disabled="inlineIntegralSaving" @click="editingIntegralBookUri = null">
                    Fermer
                  </button>
                </div>
              </div>
            </template>
          </BookMiniCard>
        </WireframeTable>

        <BatchActionBar
          :inline="true"
          :selected-count="simpleSelectedUris.length"
          :selected-books="selectedSimpleBooks"
          @execute="dispatchSimpleBatchAction"
          @clear="simpleSelectedUris = []"
        />
      </div>

      <LendModal
        :show="showSimpleLendModal"
        :bookCount="selectedSimpleBooks.length"
        @close="showSimpleLendModal = false"
        @confirm="confirmSimpleGroupLend"
      />
    </section>

    <!-- ================================================================ -->
    <!-- ONGLET 4 : RECHERCHE TEXTUELLE MULTI-CHAMPS                      -->
    <!-- ================================================================ -->
    <section v-if="activeMode === 'search'" class="scan-section">
      <form class="scan-card text-search-card" @submit.prevent="handleMultiFieldSearch">
        <p class="simple-hint" style="margin-bottom: 0.6rem;">
          Renseignez un ou plusieurs champs pour rechercher un ouvrage (BnF &amp; catalogue) :
        </p>

        <div class="text-search-grid">
          <label class="ts-field">
            <span>Nom / Titre</span>
            <input
              v-model="textSearchForm.title"
              type="text"
              class="ts-input"
              placeholder="Ex: Le Secret de la Licorne"
            />
          </label>
          <label class="ts-field">
            <span>Série</span>
            <input
              v-model="textSearchForm.series"
              type="text"
              class="ts-input"
              placeholder="Ex: Tintin"
            />
          </label>
          <label class="ts-field">
            <span>N° de tome</span>
            <input
              v-model="textSearchForm.volumeNumber"
              type="text"
              class="ts-input"
              placeholder="Ex: 11"
            />
          </label>
          <label class="ts-field">
            <span>Auteur</span>
            <input
              v-model="textSearchForm.author"
              type="text"
              class="ts-input"
              placeholder="Ex: Hergé"
            />
          </label>
          <label class="ts-field">
            <span>Édition / Collection</span>
            <input
              v-model="textSearchForm.edition"
              type="text"
              class="ts-input"
              placeholder="Ex: Collector, Intégrale..."
            />
          </label>
          <label class="ts-field">
            <span>Éditeur</span>
            <input
              v-model="textSearchForm.publisher"
              type="text"
              class="ts-input"
              placeholder="Ex: Casterman, Dargaud..."
            />
          </label>
          <label class="ts-field">
            <span>ISBN</span>
            <input
              v-model="textSearchForm.isbn"
              type="text"
              class="ts-input"
              placeholder="Ex: 9782203001107"
            />
          </label>
        </div>

        <div class="ts-actions-row">
          <button
            type="submit"
            class="wireframe-btn primary"
            :disabled="textSearchBusy || !hasTextSearchCriteria"
          >
            {{ textSearchBusy ? 'Recherche en cours...' : 'Rechercher' }}
          </button>
          <button
            type="button"
            class="wireframe-btn"
            :disabled="textSearchBusy"
            @click="resetTextSearchForm"
          >
            Effacer
          </button>
        </div>

        <div v-if="textSearchError" class="error-banner">{{ textSearchError }}</div>
        <div v-if="textSearchFeedback" class="success-banner">{{ textSearchFeedback }}</div>
      </form>

      <div v-if="textSearchDone && textSearchBooks.length === 0" class="scan-card">
        <p class="simple-hint" style="margin: 0;">
          Aucun résultat trouvé pour ces critères. Essayez de simplifier le titre ou de retirer un filtre.
        </p>
      </div>

      <div v-if="textSearchBooks.length > 0" class="scan-card">
        <div class="section-header-row">
          <label class="select-all-label">
            <input
              type="checkbox"
              class="wireframe-checkbox"
              :checked="isAllTextSearchSelected"
              @change="toggleAllTextSearch(($event.target as HTMLInputElement).checked)"
            />
            <span>
              {{ textSearchSelectedUris.length === 0 ? `Tout cocher (${textSearchBooks.length})` : `${textSearchSelectedUris.length} sélectionné(s)` }}
            </span>
          </label>
        </div>

        <WireframeTable>
          <BookMiniCard
            v-for="livre in textSearchBooks"
            :key="livre.uri"
            :book="livre"
            :model-value="textSearchSelectedUris.includes(livre.uri)"
            @update:model-value="(val) => {
              if (val) {
                if (!textSearchSelectedUris.includes(livre.uri)) textSearchSelectedUris.push(livre.uri);
              } else {
                const idx = textSearchSelectedUris.indexOf(livre.uri);
                if (idx > -1) textSearchSelectedUris.splice(idx, 1);
              }
            }"
          >
            <template #extra>
              <button type="button" class="inline-integral-trigger" @click="toggleInlineIntegralEditor(livre)">
                {{ livre.isIntegral ? 'Modifier intégrale' : 'Déclarer intégrale' }}
              </button>
              <div v-if="editingIntegralBookUri === livre.uri" class="inline-integral-panel">
                <IntegralConfigFields
                  v-model:is-integral="inlineIntegralFlag"
                  v-model:included-volumes-text="inlineIntegralVolsText"
                  :compact="true"
                  :disabled="inlineIntegralSaving"
                  :input-id="`search-int-${livre.uri}`"
                />
                <div class="inline-integral-actions">
                  <button type="button" class="wireframe-btn small-btn primary" :disabled="inlineIntegralSaving" @click="applyInlineIntegralEditor(livre)">
                    Valider
                  </button>
                  <button type="button" class="wireframe-btn small-btn" :disabled="inlineIntegralSaving" @click="editingIntegralBookUri = null">
                    Fermer
                  </button>
                </div>
              </div>
            </template>
          </BookMiniCard>
        </WireframeTable>

        <BatchActionBar
          :inline="true"
          :selected-count="textSearchSelectedUris.length"
          :selected-books="selectedTextSearchBooks"
          :busy="textSearchBatchBusy"
          @execute="dispatchTextSearchBatchAction"
          @clear="textSearchSelectedUris = []"
        />
      </div>

      <LendModal
        :show="showTextSearchLendModal"
        :bookCount="selectedTextSearchBooks.length"
        @close="showTextSearchLendModal = false"
        @confirm="confirmTextSearchGroupLend"
      />
    </section>
  </div>
</template>

<style scoped>
.scan-view {
  max-width: 980px;
  margin: 0 auto;
  padding-bottom: 3rem;
}

.scan-mode-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.4rem;
  margin-bottom: 1rem;
}

@media (max-width: 600px) {
  .scan-mode-tabs {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.scan-tab-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  min-width: 0;
  min-height: 44px;
  padding: 0.5rem 0.4rem;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: #fff;
  color: #1e293b;
  font-weight: 700;
  font-size: 0.84rem;
  white-space: nowrap;
  cursor: pointer;
}

.scan-tab-btn.active {
  background: #0f172a;
  color: #fff;
  border-color: #0f172a;
}

.tab-badge {
  background: #3b82f6;
  color: #fff;
  border-radius: 999px;
  padding: 0.1rem 0.45rem;
  font-size: 0.74rem;
}

.scan-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.scan-card {
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 14px;
  padding: 1rem;
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.byok-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.88rem;
}

.photo-help-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.75rem;
}

.photo-help-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.35rem;
}

.photo-help-text {
  margin: 0;
  font-size: 0.85rem;
  color: #475569;
}

.photo-triggers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
}

.photo-trigger-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 0.25rem;
  padding: 1.15rem;
  border: 2px dashed #94a3b8;
  border-radius: 12px;
  background: #f8fafc;
  cursor: pointer;
}

.photo-trigger-card:hover {
  border-color: #2563eb;
  background: #eff6ff;
}

.queue-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.queue-header-actions {
  display: flex;
  gap: 0.5rem;
}

.queue-metrics-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: 0.86rem;
  color: #334155;
}

.queue-live-step {
  font-size: 0.85rem;
  color: #1d4ed8;
  font-weight: 600;
}

.progress-card {
  background: #eff6ff;
  border-color: #bfdbfe;
}

.progress-track {
  height: 8px;
  border-radius: 999px;
  background: #dbeafe;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #2563eb;
  transition: width 0.25s ease;
}

.section-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}

.select-all-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 700;
  cursor: pointer;
}

.edition-arbitration-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.35rem;
  align-items: center;
}

.edition-select {
  flex: 1 1 240px;
  max-width: 100%;
  padding: 0.32rem 0.5rem;
  border: 1px solid #93c5fd;
  background: #eff6ff;
  color: #1e3a8a;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
}

.refine-btn {
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #334155;
  border-radius: 6px;
  padding: 0.28rem 0.55rem;
  font-size: 0.76rem;
  cursor: pointer;
}

.doubt-card {
  border: 1px solid #fde68a;
  background: #fffbeb;
  border-radius: 10px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.65rem;
}

.doubt-options-list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.doubt-option-card {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
}

.doubt-option-card.chosen {
  border-color: #2563eb;
  background: #eff6ff;
}

.small-thumb {
  width: 38px;
  height: 54px;
  object-fit: cover;
  border-radius: 4px;
}

.doubt-opt-meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.85rem;
}

.pill {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: #e2e8f0;
  color: #1e293b;
  font-size: 0.72rem;
  font-weight: 700;
  margin-right: 0.35rem;
}

.integral-pill {
  background: #dcfce7;
  color: #166534;
}

.series-accordion-card {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  margin-bottom: 0.5rem;
}

.series-accordion-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.55rem 0.75rem;
  background: #f8fafc;
}

.series-accordion-toggle {
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 700;
  cursor: pointer;
}

.series-inner-list {
  padding: 0.5rem;
}

.unresolved-card {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin-bottom: 0.5rem;
}

.cand-sub-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.cand-input {
  flex: 1 1 140px;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 0.86rem;
}

.cand-input.small {
  flex: 0 0 80px;
}

.cand-input.bold {
  font-weight: 700;
}

.unresolved-msg {
  color: #991b1b;
}

.burst-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

.manual-isbn-inline {
  display: flex;
  flex: 1 1 260px;
  gap: 0.5rem;
}

.link-btn {
  border: none;
  background: transparent;
  color: #2563eb;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  font-size: 0.84rem;
}

.small-btn {
  padding: 0.3rem 0.6rem;
  font-size: 0.8rem;
}

.error-banner {
  background: #fee2e2;
  color: #991b1b;
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  font-weight: 600;
}

.success-banner {
  background: #dcfce7;
  color: #166534;
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  font-weight: 600;
}

.feedback-with-cta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
}

.photo-cover-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
  gap: 0.75rem;
  margin-top: 0.65rem;
}

@media (max-width: 480px) {
  .photo-cover-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.65rem;
  }
}

.photo-cover-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.45rem;
  border: 1.5px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.photo-cover-card.is-checked {
  border-color: #2563eb;
  background: #f8fbff;
}

.photo-cover-card.is-doubt {
  border-color: #f59e0b;
  background: #fffdf5;
}

.photo-cover-card.is-unresolved {
  border-style: dashed;
  border-color: #94a3b8;
}

.photo-cover-card.is-owned {
  opacity: 0.85;
}

.card-check-corner {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.18);
  cursor: pointer;
}

.card-cover-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: 8px;
  overflow: hidden;
  background: #f1f5f9;
}

.card-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.card-cover-placeholder {
  width: 100%;
  height: 100%;
  padding: 0.5rem;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 0.76rem;
  font-weight: 600;
  color: #475569;
  background: linear-gradient(145deg, #e2e8f0, #f1f5f9);
}

.cover-pill {
  position: absolute;
  left: 6px;
  top: 6px;
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.14rem 0.42rem;
  border-radius: 999px;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
}

.cover-pill.integral {
  background: #fef3c7;
  color: #92400e;
}

.cover-pill.vol {
  background: #1e293b;
  color: #fff;
}

.cover-pill.owned {
  background: #dcfce7;
  color: #166534;
}

.cover-pill.shelf {
  background: rgba(15, 23, 42, 0.85);
  color: #fff;
}

.card-cover-caption {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
  min-width: 0;
}

.card-cover-title {
  font-size: 0.8rem;
  line-height: 1.25;
  color: #0f172a;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.edition-pill-trigger {
  align-self: flex-start;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
  border-radius: 999px;
  padding: 0.14rem 0.48rem;
  font-size: 0.7rem;
  font-weight: 700;
  cursor: pointer;
}

.edition-pill-trigger.warn {
  border-color: #fcd34d;
  background: #fef3c7;
  color: #92400e;
}

.ingest-sticky-toast {
  position: fixed;
  left: 50%;
  bottom: max(4.75rem, calc(env(safe-area-inset-bottom) + 4rem));
  transform: translateX(-50%);
  z-index: 2050;
  width: min(92vw, 440px);
  background: #0f172a;
  color: #fff;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.45);
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.ingest-toast-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.88rem;
}

.ingest-spinner {
  width: 18px;
  height: 18px;
  border: 2.5px solid rgba(255, 255, 255, 0.3);
  border-top-color: #60a5fa;
  border-radius: 50%;
  flex-shrink: 0;
  animation: ingest-spin 0.8s linear infinite;
}

.simple-loading-card .ingest-spinner {
  border-color: rgba(37, 99, 235, 0.25);
  border-top-color: #2563eb;
}

@keyframes ingest-spin {
  to {
    transform: rotate(360deg);
  }
}

.text-search-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
  gap: 0.5rem;
}

.ts-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.74rem;
  font-weight: 700;
  color: #334155;
}

.ts-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 34px;
  padding: 0.35rem 0.5rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 0.82rem;
  background: #fff;
  color: #0f172a;
}

.ts-actions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.inline-integral-trigger {
  margin-top: 0.3rem;
  padding: 0.16rem 0.5rem;
  font-size: 0.72rem;
  font-weight: 700;
  color: #0f766e;
  background: #f0fdfa;
  border: 1px solid #99f6e4;
  border-radius: 999px;
  cursor: pointer;
}

.inline-integral-panel {
  margin-top: 0.45rem;
  padding: 0.55rem;
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.inline-integral-actions {
  display: flex;
  gap: 0.4rem;
}
</style>
