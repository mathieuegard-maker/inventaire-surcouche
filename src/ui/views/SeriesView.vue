<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import CollectionSubNav from '../components/CollectionSubNav.vue';
import WireframeTable from '../components/WireframeTable.vue';
import WireframePagination from '../components/WireframePagination.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import LendModal from '../components/LendModal.vue';
import SeriesMergeModal from '../components/SeriesMergeModal.vue';
import BatchGenreModal from '../components/BatchGenreModal.vue';
import { TEXTS } from '../locales/fr';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { seriesOrchestrator } from '../../core/orchestrators/series.orchestrator';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import { fetchV4SeriesBooksToIndexedDb } from '../../core/services/v4-client.service';
import { filterEligibleBooksForBatchAction } from '../../core/utils/batch-actions.util';
import { connectionState, fetchWithTimeout } from '../../state/connection';
import { saveBookNavigationOrder, sortSeriesTomes } from '../../state/bookNavigation';
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
const showBatchGenreModal = ref(false);
const isExcluding = ref(false);
const isForceEnriching = ref(false);
const ownershipFilter = ref<'all' | 'owned' | 'unowned'>('all');
const excludeFeedback = ref('');
const displayedTomes = ref<HumanizedBook[]>([]);
const filteredTomes = ref<HumanizedBook[]>([]);

const ownedTomesCount = computed(
  () => seriesTomes.value.filter((t) => t.ownershipStatus === 'owned' || Boolean(t.ownedViaIntegral)).length
);
const unownedTomesCount = computed(
  () => seriesTomes.value.filter((t) => t.ownershipStatus !== 'owned' && !t.ownedViaIntegral).length
);
const ownershipFilteredTomes = computed(() => {
  if (ownershipFilter.value === 'owned') {
    return seriesTomes.value.filter((t) => t.ownershipStatus === 'owned' || Boolean(t.ownedViaIntegral));
  }
  if (ownershipFilter.value === 'unowned') {
    return seriesTomes.value.filter((t) => t.ownershipStatus !== 'owned' && !t.ownedViaIntegral);
  }
  return seriesTomes.value;
});

const triggerImmediateEnrich = async () => {
  if (isForceEnriching.value || connectionState.isOffline.value) return;
  isForceEnriching.value = true;
  excludeFeedback.value = '';
  try {
    await fetchV4SeriesBooksToIndexedDb(seriesId.value, { force: true });
    seriesOrchestrator.startBackgroundHydration(seriesId.value);
    await loadLocalData();
    excludeFeedback.value = 'Enrichissement de la série lancé : les nouveaux tomes détectés ont été mis à jour.';
  } catch {
    excludeFeedback.value = 'Erreur lors de la recherche des tomes manquants.';
  } finally {
    isForceEnriching.value = false;
  }
};

// Stockage du titre résolu (pour éviter wd:Q...)
const resolvedSeriesTitle = ref<string | null>(null);

const progressState = computed(() => seriesOrchestrator.getProgress(seriesId.value).value);
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
  let context = await seriesOrchestrator.getCompleteSeriesForUI(
    seriesId.value,
    resolvedSeriesTitle.value || undefined
  );
  if (!resolvedSeriesTitle.value && (!context || context.tomes.length === 0)) {
    await fetchSeriesMetadata();
    if (resolvedSeriesTitle.value) {
      context = await seriesOrchestrator.getCompleteSeriesForUI(
        seriesId.value,
        resolvedSeriesTitle.value
      );
    }
  }
  if (context && context.tomes.length > 0) {
    seriesTomes.value = sortSeriesTomes(context.tomes);
    saveBookNavigationOrder(seriesTomes.value.map((t) => t.uri), 'series');
  } else if (!resolvedSeriesTitle.value) {
    await fetchSeriesMetadata();
  }
};

onMounted(async () => {
  isLoading.value = true;
  try {
    await loadLocalData();
    // Toujours lancer l'hydratation en arrière-plan pour récupérer tous les tomes manquants de la série via BnF (460$3 / bib.ens2bib)
    seriesOrchestrator.startBackgroundHydration(seriesId.value);
  } catch (e) {
    console.error("Erreur lors du chargement :", e);
  } finally {
    isLoading.value = false;
  }
});

watch(
  () => seriesId.value,
  async (newId) => {
    if (!newId) return;
    resolvedSeriesTitle.value = null;
    selectedIds.value = [];
    seriesTomes.value = [];
    displayedTomes.value = [];
    filteredTomes.value = [];
    await loadLocalData();
    seriesOrchestrator.startBackgroundHydration(newId);
  }
);

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

const isAllSelected = computed(() => {
  const targets = filteredTomes.value.length > 0 ? filteredTomes.value : ownershipFilteredTomes.value;
  return targets.length > 0 && targets.every((tome) => selectedIds.value.includes(tome.uri));
});
const selectedBooks = computed(() => seriesTomes.value.filter(tome => selectedIds.value.includes(tome.uri)));
const eligibleLendBooks = computed(() => filterEligibleBooksForBatchAction(selectedBooks.value, 'LEND'));
const hasLentSelected = computed(() => selectedBooks.value.some(book => !!book.loan));
const hasAvailableOwnedSelected = computed(() => selectedBooks.value.some(book => book.ownershipStatus === 'owned' && !book.loan));
const hasUnownedSelected = computed(() => selectedBooks.value.some(book => book.ownershipStatus !== 'owned'));
const batchContext = computed(() => {
  if (hasUnownedSelected.value) return 'unowned';
  if (hasLentSelected.value) return 'lent';
  return 'owned';
});

const handleToggleAll = (checked: boolean) => {
  const targets = filteredTomes.value.length > 0 ? filteredTomes.value : ownershipFilteredTomes.value;
  selectedIds.value = checked ? targets.map(item => item.uri) : [];
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE') => {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, action);
  if (eligible.length === 0) return;
  if (action === 'LEND') { showLendModal.value = true; return; }
  const eligibleUris = new Set(eligible.map((b) => b.uri));
  try {
    for (const book of eligible) {
      if (action === 'DELETE') {
        const removeAct = book.ownershipStatus === 'wish' ? 'REMOVE_WISHLIST' : 'REMOVE_INVENTORY';
        await queueService.enqueueAction(removeAct, book.uri);
      } else {
        await queueService.enqueueAction(action, book.uri);
      }
    }
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (eligibleUris.has(tome.uri)) {
        if (action === 'RETURN') { const { loan, ...rest } = tome; return rest; }
        if (action === 'DELETE') { const { loan, ...rest } = tome; return { ...rest, ownershipStatus: 'none' }; }
        return { ...tome, ownershipStatus: action === 'ADD_INVENTORY' ? 'owned' : 'wish' };
      }
      return tome;
    });
    selectedIds.value = [];
  } catch (error) { console.error(error); }
};

const confirmGroupLend = async (friendName: string) => {
  const eligible = eligibleLendBooks.value;
  const eligibleUris = new Set(eligible.map((b) => b.uri));
  try {
    for (const book of eligible) await queueService.enqueueAction('LEND', book.uri, { friendName });
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (eligibleUris.has(tome.uri)) return { ...tome, loan: { uri: tome.uri, friendName, loanDate: Date.now() } };
      return tome;
    });
    selectedIds.value = [];
  } catch (error) { console.error(error); } finally { showLendModal.value = false; }
};

const excludeSelectedFromSeries = async () => {
  if (selectedIds.value.length === 0 || isExcluding.value) return;
  const targets = selectedBooks.value.slice();
  if (targets.length === 0) return;
  isExcluding.value = true;
  excludeFeedback.value = '';
  try {
    await seriesOrchestrator.excludeTomesFromSeries(seriesId.value, targets);
    const removedSet = new Set(targets.map((t) => t.uri));
    seriesTomes.value = seriesTomes.value.filter((t) => !removedSet.has(t.uri));
    selectedIds.value = [];
    excludeFeedback.value = `${targets.length} tome(s) retiré(s) de cette série pour votre foyer.`;
  } catch (error) {
    console.error('[SeriesView] Erreur retrait série :', error);
    excludeFeedback.value = 'Erreur lors du retrait des tomes de la série.';
  } finally {
    isExcluding.value = false;
  }
};

const handleBackToCollection = () => router.push({ name: 'CollectionView', query: { mode: fromMode.value } });
</script>

<template>
  <div class="view-container">
    <BaseHeader @back="handleBackToCollection" />
    <CollectionSubNav active-mode="series" />

    <BaseTitle :text="seriesName" level="h3" />

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
        <!-- Bandeau d'information enrichissement en tâche de fond + bouton immédiat -->
        <div
          v-if="unownedTomesCount === 0 || progressState.isActive"
          style="display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; flex-wrap: wrap; padding: 0.65rem 0.9rem; margin-bottom: var(--spacing-sm); border: 1px solid #fde68a; border-radius: 10px; background: #fffbeb; color: #78350f; font-size: 0.84rem;"
        >
          <span>
            <template v-if="progressState.isActive">
              Enrichissement de la série en cours en arrière-plan… Les tomes manquants apparaîtront progressivement.
            </template>
            <template v-else>
              Tous les tomes de cette série ne sont peut-être pas encore chargés (enrichissement automatique en arrière-plan).
            </template>
          </span>
          <button
            type="button"
            class="wireframe-btn"
            style="width: auto; padding: 0.35rem 0.75rem; background: #ffffff; color: #92400e; border-color: #f59e0b; font-weight: 700; font-size: 0.8rem;"
            :disabled="isForceEnriching || connectionState.isOffline.value"
            @click="triggerImmediateEnrich"
          >
            {{ isForceEnriching ? 'Recherche en cours...' : 'Enrichir la série maintenant' }}
          </button>
        </div>

        <!-- Filtre rapide Tout / Possédés / Non possédés -->
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; margin-bottom: var(--spacing-md);">
          <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;" role="tablist" aria-label="Filtrer par possession">
            <button
              type="button"
              role="tab"
              :aria-selected="ownershipFilter === 'all'"
              class="wireframe-btn"
              :style="ownershipFilter === 'all' ? 'width:auto;padding:0.35rem 0.8rem;background:var(--color-primary,#4f46e5);color:#fff;border-color:var(--color-primary,#4f46e5);font-weight:700;' : 'width:auto;padding:0.35rem 0.8rem;'"
              @click="ownershipFilter = 'all'; selectedIds = []"
            >
              Tout ({{ seriesTomes.length }})
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="ownershipFilter === 'owned'"
              class="wireframe-btn"
              :style="ownershipFilter === 'owned' ? 'width:auto;padding:0.35rem 0.8rem;background:#16a34a;color:#fff;border-color:#16a34a;font-weight:700;' : 'width:auto;padding:0.35rem 0.8rem;'"
              @click="ownershipFilter = 'owned'; selectedIds = []"
            >
              Possédés ({{ ownedTomesCount }})
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="ownershipFilter === 'unowned'"
              class="wireframe-btn"
              :style="ownershipFilter === 'unowned' ? 'width:auto;padding:0.35rem 0.8rem;background:#475569;color:#fff;border-color:#475569;font-weight:700;' : 'width:auto;padding:0.35rem 0.8rem;'"
              @click="ownershipFilter = 'unowned'; selectedIds = []"
            >
              Non possédés ({{ unownedTomesCount }})
            </button>
          </div>

          <div style="display: flex; gap: 0.45rem; flex-wrap: wrap;">
            <button
              v-if="unownedTomesCount > 0 && !progressState.isActive"
              type="button"
              class="wireframe-btn"
              style="width: auto; padding: 0.35rem 0.75rem; font-size: 0.82rem;"
              :disabled="isForceEnriching || connectionState.isOffline.value"
              @click="triggerImmediateEnrich"
            >
              {{ isForceEnriching ? 'Enrichissement...' : 'Actualiser la série' }}
            </button>
            <button
              type="button"
              class="wireframe-btn"
              style="width: auto; padding: 0.35rem 0.75rem; background: #eef2ff; font-weight: 700; font-size: 0.82rem;"
              @click="showMergeSeriesModal = true"
            >
              {{ selectedIds.length > 0 ? `Rattacher / Fusionner (${selectedIds.length})` : 'Fusionner la série' }}
            </button>
            <button
              v-if="selectedIds.length > 0"
              type="button"
              class="wireframe-btn"
              :disabled="isExcluding"
              style="width: auto; padding: 0.35rem 0.75rem; background: #fef2f2; color: #b91c1c; border-color: #fca5a5; font-weight: 700; font-size: 0.82rem;"
              @click="excludeSelectedFromSeries"
            >
              {{ isExcluding ? 'Retrait en cours...' : `Ne fait pas partie de cette série (${selectedIds.length})` }}
            </button>
          </div>
        </div>

        <BaseBanner
          v-if="excludeFeedback"
          :type="excludeFeedback.startsWith('Erreur') ? 'error' : 'info'"
          :message="excludeFeedback"
        />

        <WireframePagination
          :items="ownershipFilteredTomes"
          :searchKeys="['title']"
          :hasSelectAll="true"
          :selectAllValue="isAllSelected"
          :selectedCount="selectedIds.length"
          @update:selectAllValue="handleToggleAll"
          @update:filteredItems="(val) => { filteredTomes = val; saveBookNavigationOrder(val.map((b: HumanizedBook) => b.uri), 'series'); }"
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
            :selected-books="selectedBooks"
            :context="batchContext"
            :allow-series-attach="true"
            :allow-genre-add="true"
            @execute="dispatchBatchAction"
            @attach-series="showMergeSeriesModal = true"
            @add-genre="showBatchGenreModal = true"
            @clear="selectedIds = []"
          />
        </WireframePagination>
      </template>
    </template>

    <LendModal
      :show="showLendModal"
      :bookCount="eligibleLendBooks.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />

    <SeriesMergeModal
      :show="showMergeSeriesModal"
      :bookUris="selectedIds.length > 0 ? selectedIds : seriesTomes.map(t => t.uri)"
      :currentSeriesId="seriesId"
      :currentSeriesTitle="seriesName"
      :singleBook="selectedIds.length === 1"
      @close="showMergeSeriesModal = false"
      @merged="(p) => router.push({ name: 'SeriesView', params: { id: p.seriesId } })"
    />

    <BatchGenreModal
      :show="showBatchGenreModal"
      :bookUris="selectedIds"
      @close="showBatchGenreModal = false"
      @applied="() => { selectedIds = []; void loadLocalData(); }"
    />
  </div>
</template>