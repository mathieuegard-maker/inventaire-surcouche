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

const router = useRouter();

const activeMode = computed(() => scannerState.activeMode.value);
const burstBooks = computed(() => scannerState.burstBooks.value);
const burstSelectedUris = ref<string[]>([]);
const showBurstLendModal = ref(false);
const burstFeedback = ref('');

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
  if (selectedBurstBooks.value.length === 0 || burstBatchState.value.isMixed) return;
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
  <div v-show="scannerState.isScanningActive.value" class="scanner-modal-backdrop">
    <div class="scanner-modal-card">
      <!-- En-tête + Sélecteur 3 Modes (Simple par défaut / Rafale / Photo) -->
      <div class="scanner-header">
        <div class="mode-tabs">
          <button
            type="button"
            class="mode-tab"
            :class="{ active: activeMode === 'simple' }"
            @click="scannerState.switchMode('simple')"
          >
            Scan simple
          </button>
          <button
            type="button"
            class="mode-tab"
            :class="{ active: activeMode === 'burst' }"
            @click="scannerState.switchMode('burst')"
          >
            Scan rafale
            <span v-if="burstBooks.length > 0" class="tab-count-badge">{{ burstBooks.length }}</span>
          </button>
          <button
            type="button"
            class="mode-tab"
            :class="{ active: activeMode === 'photo' }"
            @click="scannerState.switchMode('photo')"
          >
            Photo étagère / couv
            <span v-if="photoStats.totalPhotos > 0" class="tab-count-badge">{{ photoStats.totalPhotos }}</span>
          </button>
        </div>
        <button type="button" class="close-scan-btn" @click="scannerState.stopScan()">
          Fermer
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
        </div>

        <div v-if="burstFeedback" class="quick-feedback">{{ burstFeedback }}</div>

        <!-- Liste à cocher type Ma Collection pour le Scan Rafale (aucun enregistrement auto) -->
        <div v-if="activeMode === 'burst' && burstBooks.length > 0" class="burst-checklist-panel">
          <div class="burst-history-header">
            <label style="display: flex; align-items: center; gap: 6px; font-weight: 800; font-size: 0.85rem; cursor: pointer;">
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
            :selected-count="burstSelectedUris.length"
            :is-mixed="burstBatchState.isMixed"
            :context="burstBatchState.context"
            @execute="dispatchBurstBatchAction"
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

        <!-- Validation après résolution BnF / ISBN / Couvertures + Doutes + Découverte séries -->
        <div
          v-if="resolvedDetectedItems.length > 0 || doubtItems.length > 0 || unresolvedItems.length > 0 || seriesExtraItems.length > 0"
          class="candidates-validation-box"
        >
          <!-- SECTION 1 : LIVRES IDENTIFIÉS AVEC CERTITUDE -->
          <div v-if="resolvedDetectedItems.length > 0" class="validation-section">
            <div class="validation-header">
              <h4>Identifiés sur les photos ({{ resolvedDetectedItems.filter(c => c.selected).length }}/{{ resolvedDetectedItems.length }})</h4>
              <select v-model="photoTargetStatus" class="provider-select">
                <option value="owned">Ajouter à ma Collection</option>
                <option value="wish">Ajouter à ma Wishlist</option>
              </select>
            </div>

            <div class="candidates-list primary-detected-list">
              <div
                v-for="item in resolvedDetectedItems"
                :key="item.id"
                class="candidate-row resolved-row"
              >
                <input type="checkbox" v-model="item.selected" class="cand-check" />
                <img
                  v-if="item.coverUrl"
                  :src="imageUtil.resolveCoverUrl(item.coverUrl)"
                  :alt="item.title"
                  class="cand-cover-thumb"
                  @error="imageUtil.advanceCoverFallback(item)"
                />
                <div v-else class="cand-cover-fallback">—</div>
                <div class="cand-meta">
                  <div class="cand-title-line">
                    <span v-if="item.series" class="cand-series-pill">
                      {{ item.series }}<template v-if="item.seriesNumber"> T.{{ item.seriesNumber }}</template>
                    </span>
                    <strong>{{ item.title }}</strong>
                  </div>
                  <div class="cand-sub-meta">
                    <span v-if="item.authors.length">{{ item.authors.join(', ') }}</span>
                    <span v-if="item.publisher"> • {{ item.publisher }}</span>
                    <span v-if="item.publishDate"> ({{ item.publishDate }})</span>
                  </div>
                  <div class="cand-badges">
                    <code class="isbn-tag">{{ item.isbn13 }}</code>
                    <span v-if="item.correctedFromAi" class="mini-badge corrected">Corrigé par BnF</span>
                    <span v-if="item.sourcesCount && item.sourcesCount > 1" class="mini-badge consensus">
                      {{ item.sourcesCount }} sources
                    </span>
                    <span v-if="item.alreadyOwned" class="mini-badge owned">Déjà possédé</span>
                    <span v-else-if="item.alreadyWished" class="mini-badge wish">En wishlist</span>
                    <span v-if="!item.coverUrl" class="mini-badge warn">Sans couverture trouvée</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- SECTION 1B : DOUTES (ARBITRAGE ENTRE 2–3 PISTES CROISÉES) -->
          <div v-if="doubtItems.length > 0" class="validation-section doubt-section">
            <div class="validation-header">
              <h4>Doutes à arbitrer ({{ selectedDoubtCount }}/{{ doubtItems.length }})</h4>
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

          <!-- SECTION 2 : AUTRES TOMES DES SÉRIES DÉTECTÉES (FERMÉES PAR DÉFAUT) -->
          <div v-if="groupedSeriesExtras.length > 0" class="validation-section series-extras-section">
            <div class="validation-header">
              <h4>Autres tomes des séries ({{ selectedSeriesCount }}/{{ seriesExtraItems.length }})</h4>
              <div class="series-controls-inline">
                <select v-model="seriesExtraTarget" class="provider-select">
                  <option value="none">Fiches série (catalogue seul)</option>
                  <option value="wish">Ajouter en Wishlist</option>
                  <option value="owned">Ajouter en Collection</option>
                </select>
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
                  <div
                    v-for="extra in group.items"
                    :key="extra.id"
                    class="candidate-row resolved-row"
                  >
                    <input type="checkbox" v-model="extra.selected" class="cand-check" />
                    <img
                      v-if="extra.coverUrl"
                      :src="imageUtil.resolveCoverUrl(extra.coverUrl)"
                      :alt="extra.title"
                      class="cand-cover-thumb"
                      @error="imageUtil.advanceCoverFallback(extra)"
                    />
                    <div v-else class="cand-cover-fallback">—</div>
                    <div class="cand-meta">
                      <div class="cand-title-line">
                        <span v-if="extra.series" class="cand-series-pill">
                          {{ extra.series }}<template v-if="extra.seriesNumber"> T.{{ extra.seriesNumber }}</template>
                        </span>
                        <strong>{{ extra.title }}</strong>
                      </div>
                      <div class="cand-sub-meta">
                        <span v-if="extra.authors.length">{{ extra.authors.join(', ') }}</span>
                        <span v-if="extra.publisher"> • {{ extra.publisher }}</span>
                        <span v-if="extra.publishDate"> ({{ extra.publishDate }})</span>
                      </div>
                      <div class="cand-badges">
                        <code class="isbn-tag">{{ extra.isbn13 }}</code>
                        <span v-if="extra.alreadyOwned" class="mini-badge owned">Déjà possédé</span>
                        <span v-else-if="extra.alreadyWished" class="mini-badge wish">En wishlist</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- SECTION 3 : NON IDENTIFIÉS SUR BNF / GOOGLE BOOKS (NON VALIDABLES TEL QUEL) -->
          <div v-if="unresolvedItems.length > 0" class="validation-section unresolved-section">
            <div class="validation-header">
              <h4>Non identifiés sur BnF ({{ unresolvedItems.length }}) — Non validables sans notice</h4>
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

          <button
            v-if="resolvedDetectedItems.length > 0 || doubtItems.length > 0 || seriesExtraItems.length > 0"
            type="button"
            class="action-btn primary full-width"
            :disabled="totalSelectedToSave === 0"
            @click="confirmAndSaveCandidates"
          >
            Valider {{ selectedDetectedCount }} livre(s) + {{ selectedSeriesCount }} tome(s) de série
          </button>
        </div>
      </div>

      <div v-if="scannerState.errorMessage.value" class="error-banner">
        {{ scannerState.errorMessage.value }}
      </div>
    </div>

    <LendModal
      :show="showBurstLendModal"
      :bookCount="selectedBurstBooks.length"
      @close="showBurstLendModal = false"
      @confirm="confirmBurstGroupLend"
    />
  </div>
</template>

<style scoped>
.scanner-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.85);
  z-index: 9999;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 0.75rem;
  overflow-y: auto;
}

.scanner-modal-card {
  width: 100%;
  max-width: 540px;
  background: #fff;
  border: 2px solid #000;
  box-shadow: 6px 6px 0 #000;
  padding: 0.85rem;
  margin-top: 0.5rem;
}

.scanner-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.mode-tabs {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.mode-tab {
  border: 2px solid #000;
  background: #f1f5f9;
  padding: 0.4rem 0.65rem;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

.mode-tab.active {
  background: #4f46e5;
  color: #fff;
}

.close-scan-btn {
  border: 2px solid #000;
  background: #fee2e2;
  color: #991b1b;
  font-weight: 700;
  padding: 0.4rem 0.65rem;
  font-size: 0.8rem;
  cursor: pointer;
}

.burst-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  padding: 0.45rem 0.65rem;
  margin-bottom: 0.5rem;
  font-size: 0.82rem;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.burst-target-switch {
  display: flex;
  gap: 0.35rem;
}

.burst-target-switch button {
  border: 1px solid #000;
  background: #fff;
  padding: 0.25rem 0.55rem;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
}

.burst-target-switch button.active {
  background: #0f172a;
  color: #fff;
}

.scanner-viewport-container {
  position: relative;
  min-height: 220px;
  background: #000;
  border: 2px solid #000;
  overflow: hidden;
}

.scanner-viewport {
  width: 100%;
}

.scanner-placeholder {
  color: #fff;
  text-align: center;
  padding: 2rem 1rem;
  font-size: 0.9rem;
}

.burst-live-toast {
  margin-top: 0.6rem;
  padding: 0.65rem 0.8rem;
  border: 2px solid #000;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  background: #dcfce7;
  color: #14532d;
}

.burst-live-toast.already_owned {
  background: #fef3c7;
  color: #78350f;
}

.toast-main {
  display: flex;
  flex-direction: column;
  font-size: 0.85rem;
}

.undo-btn,
.mini-undo {
  border: 1px solid #000;
  background: #fff;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.burst-history-box {
  margin-top: 0.65rem;
  border: 1px solid #cbd5e1;
  padding: 0.5rem;
  background: #f8fafc;
  font-size: 0.8rem;
}

.burst-history-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.4rem;
}

.clear-btn {
  background: none;
  border: none;
  text-decoration: underline;
  cursor: pointer;
  font-size: 0.75rem;
}

.burst-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.burst-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  padding: 0.3rem 0.5rem;
  border: 1px solid #e2e8f0;
}

.verdict-banner {
  border: 2px solid #000;
  padding: 1rem;
  margin-bottom: 0.75rem;
}

.verdict-banner.owned {
  background: #dcfce7;
  color: #14532d;
}

.verdict-banner.owned-other {
  background: #d1fae5;
  color: #065f46;
}

.verdict-banner.wish {
  background: #dbeafe;
  color: #1e3a8a;
}

.verdict-banner.series-gap {
  background: #ffedd5;
  color: #7c2d12;
}

.verdict-banner.not-owned,
.verdict-banner.neutral {
  background: #f1f5f9;
  color: #0f172a;
}

.verdict-badge {
  font-weight: 900;
  font-size: 0.85rem;
  letter-spacing: 0.03em;
  margin-bottom: 0.3rem;
}

.verdict-title {
  margin: 0 0 0.25rem;
  font-size: 1.15rem;
}

.verdict-sub {
  margin: 0;
  font-size: 0.88rem;
}

.missing-tomes-pill {
  margin-top: 0.6rem;
  padding: 0.4rem 0.6rem;
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid #000;
  font-size: 0.8rem;
}

.check-actions-grid {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.action-btn {
  border: 2px solid #000;
  padding: 0.65rem 0.85rem;
  font-weight: 700;
  font-size: 0.9rem;
  cursor: pointer;
  text-align: center;
}

.action-btn.primary {
  background: #4f46e5;
  color: #fff;
}

.action-btn.secondary {
  background: #0284c7;
  color: #fff;
}

.action-btn.series {
  background: #f59e0b;
  color: #000;
}

.action-btn.outline {
  background: #fff;
  color: #000;
}

.action-btn.rescan {
  background: #0f172a;
  color: #fff;
}

.quick-feedback {
  background: #dcfce7;
  border: 2px solid #166534;
  color: #14532d;
  padding: 0.5rem;
  font-weight: 700;
  text-align: center;
  margin-bottom: 0.6rem;
}

.byok-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  padding: 0.5rem 0.75rem;
  font-size: 0.82rem;
  margin-bottom: 0.65rem;
}

.byok-wizard {
  border: 2px dashed #4f46e5;
  background: #eef2ff;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
  font-size: 0.83rem;
}

.byok-wizard h4 {
  margin: 0 0 0.4rem;
}

.wizard-steps {
  margin: 0 0 0.6rem;
  padding-left: 1.2rem;
}

.wizard-controls {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.provider-select,
.key-input {
  border: 2px solid #000;
  padding: 0.45rem;
  font-size: 0.85rem;
}

.key-status {
  margin-top: 0.45rem;
  padding: 0.4rem;
  font-weight: 700;
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
  gap: 0.6rem;
  margin-bottom: 0.75rem;
}

.photo-trigger-card {
  border: 2px solid #000;
  background: #f8fafc;
  padding: 0.85rem 0.6rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.3rem;
  cursor: pointer;
}

.photo-trigger-card:hover {
  background: #e0e7ff;
}

.trigger-icon {
  font-size: 1.6rem;
}

.photo-loading {
  padding: 1rem;
  text-align: center;
  font-weight: 700;
  background: #eef2ff;
  border: 1px solid #4f46e5;
}

.candidates-validation-box {
  border: 2px solid #000;
  padding: 0.65rem;
  background: #f8fafc;
}

.validation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.validation-header h4 {
  margin: 0;
  font-size: 0.9rem;
}

.candidates-list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  max-height: 260px;
  overflow-y: auto;
  margin-bottom: 0.65rem;
}

.candidate-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  background: #fff;
  border: 1px solid #cbd5e1;
  padding: 0.45rem;
}

.cand-fields {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.cand-sub-row {
  display: flex;
  gap: 0.3rem;
}

.cand-input {
  width: 100%;
  border: 1px solid #94a3b8;
  padding: 0.28rem 0.4rem;
  font-size: 0.8rem;
}

.cand-input.bold {
  font-weight: 700;
}

.cand-input.small {
  max-width: 70px;
}

.validation-section {
  margin-bottom: 0.75rem;
}

.series-extras-section {
  border-top: 2px dashed #cbd5e1;
  padding-top: 0.65rem;
}

.series-controls-inline {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.primary-detected-list {
  max-height: 320px;
}

.series-accordions-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.35rem;
}

.series-accordion-card {
  border: 1.5px solid #94a3b8;
  background: #ffffff;
}

.series-accordion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.35rem 0.5rem;
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
  font-weight: 900;
  width: 14px;
}

.accordion-title {
  font-weight: 800;
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
  padding: 0.05rem 0.35rem;
  white-space: nowrap;
}

.series-group-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}

.series-inner-list {
  max-height: 220px;
  margin-bottom: 0;
  padding: 0.4rem;
  border-top: 1px solid #cbd5e1;
  background: #f8fafc;
}

.unresolved-section {
  border-top: 2px dashed #f59e0b;
  padding-top: 0.65rem;
}

.resolved-row {
  align-items: center;
}

.cand-cover-thumb {
  width: 42px;
  height: 58px;
  object-fit: cover;
  border: 1px solid #0f172a;
  flex-shrink: 0;
  background: #f1f5f9;
}

.cand-cover-fallback {
  width: 42px;
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #cbd5e1;
  background: #f1f5f9;
  font-size: 1.25rem;
  flex-shrink: 0;
}

.cand-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.cand-title-line {
  font-size: 0.84rem;
  line-height: 1.25;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.cand-series-pill {
  background: #eef2ff;
  color: #3730a3;
  border: 1px solid #c7d2fe;
  font-size: 0.72rem;
  font-weight: 800;
  padding: 0.08rem 0.35rem;
}

.cand-sub-meta {
  font-size: 0.75rem;
  color: #475569;
}

.cand-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}

.isbn-tag {
  font-size: 0.7rem;
  background: #f1f5f9;
  padding: 0.05rem 0.3rem;
  border: 1px solid #cbd5e1;
}

.mini-badge {
  font-size: 0.68rem;
  font-weight: 800;
  padding: 0.08rem 0.32rem;
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
  font-size: 0.72rem;
  font-style: italic;
  background: #f1f5f9;
  padding: 0.2rem 0.4rem;
  border-left: 2px solid #94a3b8;
}

.unresolved-row {
  background: #fffbeb;
  border-color: #fbbf24;
}

.retry-bnf-btn {
  padding: 0.28rem 0.55rem;
  font-size: 0.76rem;
  white-space: nowrap;
}

.unresolved-msg {
  color: #92400e;
  font-size: 0.72rem;
  font-weight: 600;
}

.full-width {
  width: 100%;
}

.link-btn {
  background: none;
  border: none;
  color: #4f46e5;
  text-decoration: underline;
  font-weight: 700;
  cursor: pointer;
  font-size: 0.8rem;
}

.error-banner {
  margin-top: 0.5rem;
  padding: 0.6rem;
  border: 2px solid #b91c1c;
  background: #fef2f2;
  color: #991b1b;
  font-weight: 700;
  font-size: 0.85rem;
}

.tab-count-badge {
  display: inline-block;
  margin-left: 4px;
  background: #f59e0b;
  color: #000;
  border-radius: 999px;
  padding: 0 6px;
  font-size: 0.72rem;
  font-weight: 900;
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
  padding: 0.38rem 0.5rem;
  border: 1.5px dashed #475569;
  background: #f1f5f9;
  color: #1e293b;
  font-size: 0.76rem;
  font-weight: 700;
  cursor: pointer;
}

.photo-queue-progress-card {
  border: 2px solid #0f172a;
  background: #fffbeb;
  padding: 0.65rem 0.75rem;
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
  font-weight: 700;
}

.keep-awake-notice {
  display: block;
  color: #92400e;
  font-weight: 600;
  margin-top: 0.2rem;
}

.doubt-section {
  border-top: 2px dashed #6366f1;
  padding-top: 0.65rem;
}

.doubt-row {
  background: #eef2ff;
  border-color: #818cf8;
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
  padding: 0.4rem 0.5rem;
  background: #ffffff;
  border: 1.5px solid #cbd5e1;
  cursor: pointer;
  font-size: 0.8rem;
}

.doubt-option-card.chosen {
  border-color: #4f46e5;
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
  margin: 0 0 0.55rem;
  font-size: 0.76rem;
  color: #475569;
  line-height: 1.3;
  background: #f8fafc;
  padding: 0.35rem 0.5rem;
  border-left: 3px solid #0f172a;
}

.burst-compact-viewport {
  min-height: 170px !important;
  max-height: 200px !important;
}

.burst-checklist-panel {
  margin-top: 0.65rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
</style>
