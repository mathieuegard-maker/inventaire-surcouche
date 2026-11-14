<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import WireframeTable from '../components/WireframeTable.vue';
import WireframePagination from '../components/WireframePagination.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import LendModal from '../components/LendModal.vue';
import SeriesMergeModal from '../components/SeriesMergeModal.vue';
import { TEXTS } from '../locales/fr';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { seriesOrchestrator } from '../../core/orchestrators/series.orchestrator';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import { fetchWithTimeout } from '../../state/connection';
import type { HumanizedBook } from '../../core/types';

const route = useRoute();
const router = useRouter();

const seriesId = computed(() => route.params.id as string);
const fromMode = computed(() => route.query.fromMode as string || 'series');

const seriesTomes = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);
const showLendModal = ref(false);
const showMergeSeriesModal = ref(false);
const displayedTomes = ref<HumanizedBook[]>([]);

// Stockage du titre résolu (pour éviter wd:Q...)
const resolvedSeriesTitle = ref<string | null>(null);

const progressState = seriesOrchestrator.getProgress(seriesId.value);
const progressPercentage = computed(() => {
  if (!progressState.value.total) return 0;
  return Math.round((progressState.value.current / progressState.value.total) * 100);
});

const seriesName = computed(() => {
  if (resolvedSeriesTitle.value) return resolvedSeriesTitle.value;
  if (seriesTomes.value.length > 0) return seriesTomes.value[0].series || seriesId.value;
  return seriesId.value;
});

// --- LOGIQUE DE RÉCUPÉRATION DU TITRE VIA GATEWAY ---
const fetchSeriesMetadata = async () => {
  try {
    const res = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(seriesId.value)}`);
    const data = await res.json();
    const entity = data.entities?.[seriesId.value];
    if (entity) {
      resolvedSeriesTitle.value = entity.label || entity.labels?.fr || entity.labels?.en || seriesId.value;
    }
  } catch (e) {
    console.error("Erreur récupération métadonnées série :", e);
  }
};

const loadLocalData = async () => {
  const context = await seriesOrchestrator.getCompleteSeriesForUI(seriesId.value);
  if (context && context.tomes.length > 0) {
    seriesTomes.value = context.tomes;
  } else {
    // CACHE VIDE : On déclenche l'hydratation et on récupère le titre manuellement
    seriesOrchestrator.startBackgroundHydration(seriesId.value);
    await fetchSeriesMetadata();
  }
};

onMounted(async () => {
  isLoading.value = true;
  try {
    await loadLocalData();
  } catch (e) {
    console.error("Erreur lors du chargement :", e);
  } finally {
    isLoading.value = false;
  }
});

watch(
  () => [progressState.value.current, progressState.value.isActive],
  async () => {
    await loadLocalData();
  }
);

watch(
  () => backgroundCreationOrchestrator.status.value.lastCompletedAt,
  async () => {
    await loadLocalData();
  }
);

// ... (Garder les méthodes existantes: handleToggleAll, dispatchBatchAction, confirmGroupLend, handleBackToCollection, isAllSelected, etc.)
// Note : J'ai omis le code répétitif pour la concision, mais tu conserves tes méthodes existantes ici.

const isAllSelected = computed(() => seriesTomes.value.length > 0 && selectedIds.value.length === seriesTomes.value.length);
const selectedBooks = computed(() => seriesTomes.value.filter(tome => selectedIds.value.includes(tome.uri)));
const hasLentSelected = computed(() => selectedBooks.value.some(book => !!book.loan));
const hasAvailableOwnedSelected = computed(() => selectedBooks.value.some(book => book.ownershipStatus === 'owned' && !book.loan));
const hasUnownedSelected = computed(() => selectedBooks.value.some(book => book.ownershipStatus !== 'owned'));
const isSelectionMixed = computed(() => {
  let categories = 0;
  if (hasUnownedSelected.value) categories++;
  if (hasAvailableOwnedSelected.value) categories++;
  if (hasLentSelected.value) categories++;
  return categories > 1;
});
const batchContext = computed(() => {
  if (hasUnownedSelected.value) return 'unowned';
  if (hasLentSelected.value) return 'lent';
  return 'owned';
});

const handleToggleAll = (checked: boolean) => {
  selectedIds.value = checked ? seriesTomes.value.map(item => item.uri) : [];
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN') => {
  if (selectedIds.value.length === 0 || isSelectionMixed.value) return;
  if (action === 'LEND') { showLendModal.value = true; return; }
  try {
    for (const uri of selectedIds.value) await queueService.enqueueAction(action, uri);
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (selectedIds.value.includes(tome.uri)) {
        if (action === 'RETURN') { const { loan, ...rest } = tome; return rest; }
        return { ...tome, ownershipStatus: action === 'ADD_INVENTORY' ? 'owned' : 'wish' };
      }
      return tome;
    });
    selectedIds.value = [];
  } catch (error) { console.error(error); }
};

const confirmGroupLend = async (friendName: string) => {
  try {
    for (const uri of selectedIds.value) await queueService.enqueueAction('LEND', uri, { friendName });
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (selectedIds.value.includes(tome.uri)) return { ...tome, loan: { uri: tome.uri, friendName, loanDate: Date.now() } };
      return tome;
    });
    selectedIds.value = [];
  } catch (error) { console.error(error); } finally { showLendModal.value = false; }
};
const missingTomes = computed(() => seriesTomes.value.filter(tome => tome.ownershipStatus !== 'owned'));

const completeMissingSeries = async () => {
  const targets = missingTomes.value.map(t => t.uri);
  if (targets.length === 0) return;
  try {
    for (const uri of targets) {
      await queueService.enqueueAction('ADD_INVENTORY', uri);
    }
    seriesTomes.value = seriesTomes.value.map(tome =>
      targets.includes(tome.uri) ? { ...tome, ownershipStatus: 'owned' } : tome
    );
    selectedIds.value = [];
  } catch (error) {
    console.error(error);
  }
};

const handleBackToCollection = () => router.push({ name: 'CollectionView', query: { mode: fromMode.value } });
</script>

<template>
  <div class="view-container">
    <BaseHeader @back="handleBackToCollection" />
    
    <BaseTitle :text="seriesName" level="h2" />

    <div v-if="progressState.isActive" class="progress-container">
      <div class="progress-text-summary">
        {{ TEXTS.seriesProgress?.loadingTitle || 'Téléchargement de la saga' }} : {{ progressState.current }} / {{ progressState.total }}
      </div>
      <div class="progress-track-wrapper">
        <div class="progress-fill-bar" :style="{ width: progressPercentage + '%' }"></div>
        <div class="progress-percentage-label">{{ progressPercentage }}%</div>
      </div>
    </div>

    <BaseLoading v-if="isLoading" />

    <template v-else>
      <div v-if="seriesTomes.length === 0 && !progressState.isActive">
        <BaseBanner type="error" :message="TEXTS.collectionView?.emptyCollection" />
      </div>

      <template v-else>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: var(--spacing-md);">
          <button
            v-if="missingTomes.length > 0 && seriesTomes.length > 0"
            class="wireframe-btn btn-primary"
            style="flex: 2; min-width: 220px;"
            @click="completeMissingSeries"
          >
            Tout posséder : ajouter les {{ missingTomes.length }} tome(s) manquant(s)
          </button>
          <button
            type="button"
            class="wireframe-btn"
            style="flex: 1; min-width: 180px; background: #eef2ff; font-weight: 700;"
            @click="showMergeSeriesModal = true"
          >
            🔗 Fusionner / Regrouper la série
          </button>
        </div>

        <WireframePagination
          :items="seriesTomes"
          :searchKeys="['title']"
          :hasSelectAll="true"
          :selectAllValue="isAllSelected"
          :selectedCount="selectedIds.length"
          @update:selectAllValue="handleToggleAll"
          @update:processedItems="(val) => displayedTomes = val"
        >
          <div v-if="displayedTomes.length === 0">
            <BaseBanner type="error" :message="TEXTS.collectionView?.emptyCollection" />
          </div>

          <WireframeTable v-else>
            <BookMiniCard 
              v-for="livre in displayedTomes" 
              :key="livre.uri" 
              :book="livre"
              :model-value="selectedIds.includes(livre.uri)"
              @update:model-value="(val) => {
                if (val) {
                  if (!selectedIds.includes(livre.uri)) selectedIds.push(livre.uri);
                } else {
                  const idx = selectedIds.indexOf(livre.uri);
                  if (idx > -1) selectedIds.splice(idx, 1);
                }
              }"
            />
          </WireframeTable>

          <BatchActionBar 
            :selected-count="selectedIds.length"
            :is-mixed="isSelectionMixed"
            :context="batchContext"
            @execute="dispatchBatchAction"
          />
        </WireframePagination>
      </template>
    </template>

    <LendModal
      :show="showLendModal"
      :bookCount="selectedIds.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />

    <SeriesMergeModal
      :show="showMergeSeriesModal"
      :bookUris="selectedIds.length > 0 ? selectedIds : seriesTomes.map(t => t.uri)"
      :currentSeriesId="seriesId"
      :currentSeriesTitle="seriesName"
      @close="showMergeSeriesModal = false"
      @merged="(p) => router.push({ name: 'SeriesView', params: { id: p.seriesId } })"
    />
  </div>
</template>