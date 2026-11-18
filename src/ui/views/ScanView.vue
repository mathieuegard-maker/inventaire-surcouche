<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
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
  v4BookRecordToHumanizedBook
} from '../../core/services/v4-client.service';
import { saveBookNavigationOrder } from '../../state/bookNavigation';
import { pendingScansStore } from '../../state/pendingScans';
import type { HumanizedBook } from '../../core/types';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BookMiniCard from '../components/BookMiniCard.vue';
import WireframeTable from '../components/WireframeTable.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import LendModal from '../components/LendModal.vue';

const route = useRoute();
const router = useRouter();

const activeMode = computed(() => scannerState.activeMode.value);

const syncModeFromRoute = () => {
  const qMode = route.query.mode;
  if (qMode === 'photo' || qMode === 'burst' || qMode === 'simple') {
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

const selectTab = async (mode: ScannerMode) => {
  await scannerState.switchMode(mode);
  if (mode === 'burst' || mode === 'simple') {
    await scannerState.openCameraModal(router, mode);
  }
};

// ============================================================================
// MODE SIMPLE & SAISIE ISBN RAPIDE
// ============================================================================
const manualIsbnInput = ref('');
const manualLookupBusy = ref(false);
const manualLookupError = ref('');

const handleManualIsbnLookup = async () => {
  const clean = isbnUtil.normalize(manualIsbnInput.value);
  if (!clean) return;
  manualLookupBusy.value = true;
  manualLookupError.value = '';
  try {
    const res = await searchService.searchByIsbn(clean);
    if ((res as any)?.isOfflineUnavailable) {
      pendingScansStore.addPendingScan(clean);
      manualLookupError.value = `Hors réseau : le code-barres (${clean}) a été mémorisé pour consultation ultérieure.`;
      return;
    }
    if ((res as any)?.isUnknown) {
      await router.push({ name: 'BookCreateUnknown', query: { isbn: (res as any).isbn || clean } });
      return;
    }
    if (res?.mainBook?.uri) {
      saveBookNavigationOrder([res.mainBook.uri], 'direct');
      await router.push(`/book/${encodeURIComponent(res.mainBook.uri)}`);
      return;
    }
    manualLookupError.value = 'Aucun ouvrage trouvé pour cet ISBN.';
  } catch (e: unknown) {
    manualLookupError.value = e instanceof Error ? e.message : 'Erreur lors de la recherche ISBN.';
  } finally {
    manualLookupBusy.value = false;
  }
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
          action: v4Target
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
const resolvedDetectedItems = ref<ResolvedPhotoItem[]>([]);
const doubtItems = ref<ResolvedPhotoItem[]>([]);
const unresolvedItems = ref<ResolvedPhotoItem[]>([]);
const seriesExtraItems = ref<ResolvedPhotoItem[]>([]);
const detectedSeriesNames = ref<string[]>([]);
const retryingItemId = ref<string | null>(null);
const expandedSeriesKeys = ref<Record<string, boolean>>({});
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
  if (!activeDetailItemId.value) return '';
  const idx = allValidationPool.value.findIndex((i) => i.id === activeDetailItemId.value);
  return idx >= 0 ? `Livre ${idx + 1} / ${allValidationPool.value.length}` : '';
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
  applyEditionChoice(item, option.isbn13);
}

function applyEditionChoice(item: ResolvedPhotoItem, selectedIsbn: string) {
  const opt = (item.alternatives || []).find((a) => a.isbn13 === selectedIsbn);
  if (!opt) return;
  if (opt.isbn13 !== item.isbn13) {
    item.existingUri = undefined;
    item.existingWorkUri = undefined;
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
  item.selected = true;
}

function handleDetailUpdateFields(
  item: ResolvedPhotoItem,
  payload: { title: string; series: string; seriesNumber: string; isIntegral: boolean; selected: boolean }
) {
  if (payload.title) item.title = payload.title;
  item.series = payload.series || undefined;
  item.seriesNumber = payload.isIntegral ? undefined : payload.seriesNumber || undefined;
  item.isIntegral = payload.isIntegral;
  item.selected = payload.selected;
}

async function handleDetailRetryBnf(item: ResolvedPhotoItem, candidate: RecognizedBookCandidate) {
  item.rawCandidate = { ...candidate };
  retryingItemId.value = item.id;
  try {
    const resolved = await photoBookResolutionService.resolveSingleCandidate(candidate, 'retry');
    if (resolved.status === 'unresolved') {
      item.failureReason = resolved.failureReason || 'Toujours introuvable sur la BnF / Google Books.';
      return;
    }
    const oldId = item.id;
    resolvedDetectedItems.value = resolvedDetectedItems.value.filter((i) => i.id !== oldId);
    doubtItems.value = doubtItems.value.filter((d) => d.id !== oldId);
    unresolvedItems.value = unresolvedItems.value.filter((u) => u.id !== oldId);
    if (resolved.status === 'doubt') {
      doubtItems.value.unshift(resolved);
    } else {
      resolvedDetectedItems.value.unshift(resolved);
    }
    activeDetailItemId.value = resolved.id;
  } finally {
    retryingItemId.value = null;
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
          chunkSize: 2,
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
    resolvedDetectedItems.value = resolvedDetectedItems.value.filter((i) => !savedSet.has(i.id));
    doubtItems.value = doubtItems.value.filter((d) => !savedSet.has(d.id));
    seriesExtraItems.value = seriesExtraItems.value.filter((e) => !savedSet.has(e.id));

    if (
      resolvedDetectedItems.value.length === 0 &&
      doubtItems.value.length === 0 &&
      unresolvedItems.value.length === 0
    ) {
      await photoBatchQueueService.clearCompletedJobs();
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
  resolvedDetectedItems.value = [];
  doubtItems.value = [];
  unresolvedItems.value = [];
  seriesExtraItems.value = [];
  detectedSeriesNames.value = [];
}
</script>

<template>
  <div class="view-container scan-view">
    <BaseHeader />
    <BaseTitle text="Scanner &amp; Acquisitions" level="h2" />

    <!-- Sélecteur des 3 modes de numérisation côte à côte -->
    <div class="scan-mode-tabs" role="tablist" aria-label="Mode d'acquisition">
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
                  v-if="item.coverUrl"
                  :src="imageUtil.resolveCoverUrl(item.coverUrl)"
                  :alt="item.title"
                  class="card-cover-img"
                  @error="imageUtil.advanceCoverFallback(item)"
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
                  v-if="d.coverUrl"
                  :src="imageUtil.resolveCoverUrl(d.coverUrl)"
                  :alt="d.title"
                  class="card-cover-img"
                  @error="imageUtil.advanceCoverFallback(d)"
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
          <h4>Non identifiés ({{ unresolvedItems.length }})</h4>
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
        :position-label="activeDetailPosLabel"
        :retrying="Boolean(activeDetailItem && retryingItemId === activeDetailItem.id)"
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

      <LendModal
        :show="showBurstLendModal"
        :count="selectedBurstBooks.length"
        @close="showBurstLendModal = false"
        @confirm="confirmBurstGroupLend"
      />
    </section>

    <!-- ================================================================ -->
    <!-- ONGLET 3 : SCAN SIMPLE (MODALE AUTO-FERMANTE + SAISIE ISBN)      -->
    <!-- ================================================================ -->
    <section v-if="activeMode === 'simple'" class="scan-section">
      <div v-if="scannerState.isSimpleResolving.value" class="scan-card progress-card simple-loading-card">
        <div class="ingest-toast-row">
          <span class="ingest-spinner" aria-hidden="true"></span>
          <strong>
            Chargement de l'ouvrage ({{ scannerState.simpleResolvingIsbn.value }}) en cours...
          </strong>
        </div>
        <small>La fiche complète du livre va s'ouvrir automatiquement.</small>
      </div>

      <div class="scan-card simple-scan-card">
        <p class="simple-hint">
          La caméra s'ouvre automatiquement sur cet onglet. Vous pouvez aussi saisir directement un ISBN-10 / ISBN-13 (ou EAN presse) ci-dessous :
        </p>

        <div class="manual-isbn-inline">
          <input
            v-model="manualIsbnInput"
            type="text"
            placeholder="Ex: 9782203001060 ou 2-203-00106-2"
            class="cand-input"
            @keyup.enter="handleManualIsbnLookup"
          />
          <button
            type="button"
            class="wireframe-btn primary"
            :disabled="manualLookupBusy || !manualIsbnInput.trim()"
            @click="handleManualIsbnLookup"
          >
            {{ manualLookupBusy ? 'Chargement...' : 'Ouvrir' }}
          </button>
        </div>

        <div v-if="manualLookupError" class="error-banner">{{ manualLookupError }}</div>
      </div>
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.4rem;
  margin-bottom: 1rem;
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
</style>
