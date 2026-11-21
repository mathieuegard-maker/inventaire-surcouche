<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRouter, useRoute, onBeforeRouteLeave } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { inventoryService } from '../../core/services/inventory.service';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseHeader from '../components/BaseHeader.vue';
import CollectionSubNav from '../components/CollectionSubNav.vue';
import CollectionControls from '../components/CollectionControls.vue';
import SeriesMiniCard from '../components/SeriesMiniCard.vue';
import WireframeTable from '../components/WireframeTable.vue';
import WireframePagination from '../components/WireframePagination.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import LendModal from '../components/LendModal.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';
import { getOrCreateViewState, saveViewState } from '../../state/viewState';
import { imageUtil } from '../../core/utils/image.util';
import { normalizeTextKey } from '../../core/resolvers/bnf.resolver';
import { scannerState } from '../../state/scanner';
import { syncOrchestrator } from '../../core/orchestrators/sync.orchestrator';
import { saveBookNavigationOrder, sortBooksByCollectionMode, sortSeriesTomes } from '../../state/bookNavigation';

const router = useRouter();
const route = useRoute();

const allOwnedBooks = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);
const showLendModal = ref(false);
const showDeleteModal = ref(false);

const stateKey = 'collection';
const pageState = getOrCreateViewState(stateKey, {
  currentPage: 1,
  pageSize: 20,
  searchQuery: '',
  filters: {
    mode: 'books',
    genre: '',
    sort: 'date'
  }
});

// COHÉRENCE ROUTAGE : Initialisation native basée sur l'URL courante ou l'état sauvegardé
const currentMode = ref<'books' | 'series' | 'oneshots'>((route.query.mode as any) || pageState.filters.mode || 'books');
const filterText = ref(pageState.filters.genre === 'all' ? '' : (pageState.filters.genre || ''));
const currentSort = ref(pageState.filters.sort || 'date');

const currentPage = ref(pageState.currentPage);
const pageSize = ref(pageState.pageSize);
const searchQuery = ref(pageState.searchQuery);

const displayedBooks = ref<HumanizedBook[]>([]);
const filteredCollectionBooks = ref<HumanizedBook[]>([]);
const displayedSeries = ref<any[]>([]);

const isAllSelected = computed(() => {
  const targets = filteredCollectionBooks.value.length > 0 || searchQuery.value.trim()
    ? filteredCollectionBooks.value
    : currentSortBooks.value;
  return targets.length > 0 && targets.every((b) => selectedIds.value.includes(b.uri));
});

// COHÉRENCE ROUTAGE : Met à jour l'URL de manière transparente dès que l'utilisateur change d'onglet
watch(currentMode, (newMode) => {
  router.replace({ query: { ...route.query, mode: newMode } });
  pageState.filters.mode = newMode;
});
watch(filterText, (newFilter) => {
  pageState.filters.genre = newFilter;
});
watch(currentSort, (newSort) => {
  pageState.filters.sort = newSort;
});
watch(currentPage, (val) => {
  pageState.currentPage = val;
});
watch(pageSize, (val) => {
  pageState.pageSize = val;
});
watch(searchQuery, (val) => {
  pageState.searchQuery = val;
});

onBeforeRouteLeave((to, from) => {
  saveViewState(stateKey, {
    scrollPosition: window.scrollY || document.documentElement.scrollTop
  });
});

onMounted(async () => {
  await fetchCatalogue();
  if (pageState.scrollPosition > 0) {
    setTimeout(() => {
      window.scrollTo({ top: pageState.scrollPosition, behavior: 'instant' });
    }, 100);
  }
});

watch(
  () => scannerState.lastUpdatedTick.value,
  () => {
    fetchCatalogue();
  }
);

const fetchCatalogue = async () => {
  isLoading.value = true;
  try {
    let cached = await databaseService.getAllBooksFromCache();
    let owned = cached.filter(b => b.ownershipStatus === 'owned');
    const registryUris = await databaseService.getAllRegistryUris('inventory');
    if (registryUris.length !== owned.length) {
      await syncOrchestrator.hydrateCacheInBackground();
      cached = await databaseService.getAllBooksFromCache();
      owned = cached.filter(b => b.ownershipStatus === 'owned');
    }
    
    for (const livre of owned) {
      const activeLoan = await databaseService.getLoan(livre.uri);
      if (activeLoan) {
        livre.loan = activeLoan;
      }
    }
    
    allOwnedBooks.value = owned;
    selectedIds.value = [];
  } catch (e) {
    console.error(e);
  } finally {
    isLoading.value = false;
  }
};

// COHÉRENCE ROUTAGE : Injection du mode actuel dans l'URL lors du départ vers la fiche série
const navigateToSeries = (seriesId: string) => {
  if (seriesId) {
    router.push({ 
      name: 'SeriesView', 
      params: { id: seriesId },
      query: { fromMode: currentMode.value }
    });
  }
};

const dynamicFilterSuggestions = computed(() => {
  const set = new Set<string>();
  for (const book of allOwnedBooks.value) {
    if (Array.isArray(book.genres)) {
      for (const g of book.genres) {
        if (g?.trim()) set.add(g.trim());
      }
    }
    if (book.series?.trim()) set.add(book.series.trim());
    if (Array.isArray(book.authors)) {
      for (const a of book.authors) {
        if (a?.trim()) set.add(a.trim());
      }
    }
    if (book.publisher?.trim()) set.add(book.publisher.trim());
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
});

const matchesFreeFilter = (book: HumanizedBook, rawFilter: string): boolean => {
  const needle = normalizeTextKey(rawFilter);
  if (!needle) return true;
  const fields: string[] = [
    book.title || '',
    book.series || '',
    book.publisher || '',
    ...(book.genres || []),
    ...(book.authors || [])
  ];
  return fields.some((f) => normalizeTextKey(f).includes(needle));
};

const processedBooks = computed(() => {
  let list = [...allOwnedBooks.value];

  if (filterText.value.trim()) {
    list = list.filter((b) => matchesFreeFilter(b, filterText.value));
  }

  if (currentMode.value === 'oneshots') {
    return list.filter(b => !b.seriesId && !b.series);
  }
  return list;
});

const seriesGondolas = computed(() => {
  let list = allOwnedBooks.value.filter(b => b.seriesId || b.series);

  if (filterText.value.trim()) {
    list = list.filter((b) => matchesFreeFilter(b, filterText.value));
  }

  const groups: Record<string, { id: string; name: string; tomes: HumanizedBook[] }> = {};

  list.forEach(book => {
    const key = book.seriesId || book.series || 'unknown';
    if (!groups[key]) {
      groups[key] = {
        id: book.seriesId || book.series || '',
        name: book.series || book.seriesId || '',
        tomes: []
      };
    }
    groups[key].tomes.push(book);
  });

  const gondolas = Object.values(groups).map(g => {
    const sortedTomes = sortSeriesTomes(g.tomes);
    const coverBook = sortedTomes.find(t => t.localCover || t.coverUrl) || sortedTomes[0];
    return {
      id: g.id,
      name: g.name,
      ownedCount: sortedTomes.length,
      coverUrl: imageUtil.resolveCoverUrl(coverBook)
    };
  });

  return gondolas.sort((a, b) => {
    const cleanA = a.name.replace(/^(les\s+|la\s+|le\s+|l'|une\s+|un\s+)/i, '').trim().toLowerCase();
    const cleanB = b.name.replace(/^(les\s+|la\s+|le\s+|l'|une\s+|un\s+)/i, '').trim().toLowerCase();
    return cleanA.localeCompare(cleanB);
  });
});

const currentSortBooks = computed(() => {
  return sortBooksByCollectionMode(processedBooks.value, currentSort.value);
});

const selectedBooks = computed(() => {
  return allOwnedBooks.value.filter(b => selectedIds.value.includes(b.uri));
});

const hasLentSelected = computed(() => selectedBooks.value.some(b => !!b.loan));
const hasAvailableSelected = computed(() => selectedBooks.value.some(b => !b.loan));
const isSelectionMixed = computed(() => hasLentSelected.value && hasAvailableSelected.value);
const batchContext = computed(() => hasLentSelected.value ? 'lent' : 'owned');

const handleToggleAll = (checked: boolean) => {
  if (!checked) {
    selectedIds.value = [];
  } else {
    const targets = filteredCollectionBooks.value.length > 0 || searchQuery.value.trim()
      ? filteredCollectionBooks.value
      : currentSortBooks.value;
    selectedIds.value = targets.map(b => b.uri);
  }
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE') => {
  if (selectedIds.value.length === 0) return;

  if (action === 'LEND') {
    showLendModal.value = true;
    return;
  }

  if (action === 'DELETE') {
    showDeleteModal.value = true;
    return;
  }

  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction(action, uri);
    }
    await fetchCatalogue();
  } catch (e) {
    console.error(e);
  }
};

const confirmGroupLend = async (friendName: string) => {
  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction('LEND', uri, { friendName });
    }
    await fetchCatalogue();
  } catch (e) {
    console.error(e);
  } finally {
    showLendModal.value = false;
  }
};

const confirmGroupDelete = async () => {
  try {
    for (const uri of selectedIds.value) {
      await inventoryService.removeFromLibrary(uri);
    }
    await fetchCatalogue();
  } catch (e) {
    console.error("Erreur lors de la suppression en lot :", e);
  } finally {
    showDeleteModal.value = false;
    selectedIds.value = [];
  }
};

const resetSelection = () => {
  selectedIds.value = [];
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <CollectionSubNav
      inline
      :active-mode="currentMode"
      @select-mode="(mode) => { currentMode = mode; resetSelection(); }"
    />

    <CollectionControls
      v-if="!isLoading"
      :filterSuggestions="dynamicFilterSuggestions"
      :currentMode="currentMode"
      :filterValue="filterText"
      :sortValue="currentSort"
      @update:filterValue="(val) => { filterText = val; resetSelection(); }"
      @update:sortValue="(val) => currentSort = val"
    />

    <BaseLoading v-if="isLoading" />

    <template v-else>
      <WireframePagination
        v-if="currentMode === 'series'"
        :items="seriesGondolas"
        :searchKeys="['name']"
        :hasSelectAll="false"
        v-model:currentPage="currentPage"
        v-model:pageSize="pageSize"
        v-model:searchQuery="searchQuery"
        @update:processedItems="(val) => displayedSeries = val"
      >
        <div v-if="displayedSeries.length === 0">
          <BaseBanner type="error" :message="TEXTS.collectionView?.emptyCollection" />
        </div>

        <WireframeTable v-else>
          <SeriesMiniCard
            v-for="saga in displayedSeries"
            :key="saga.id"
            :name="saga.name"
            :ownedCount="saga.ownedCount"
            :coverUrl="saga.coverUrl"
            @click="navigateToSeries(saga.id)"
          />
        </WireframeTable>
      </WireframePagination>

      <WireframePagination
        v-if="currentMode !== 'series'"
        :items="currentSortBooks"
        :searchKeys="['title', 'series', 'authors']"
        :hasSelectAll="true"
        :selectAllValue="isAllSelected"
        :selectedCount="selectedIds.length"
        v-model:currentPage="currentPage"
        v-model:pageSize="pageSize"
        v-model:searchQuery="searchQuery"
        @update:selectAllValue="handleToggleAll"
        @update:filteredItems="(val) => { filteredCollectionBooks = val; saveBookNavigationOrder(val.map((b: HumanizedBook) => b.uri), 'collection'); }"
        @update:processedItems="(val) => displayedBooks = val"
      >
        <div v-if="displayedBooks.length === 0">
          <BaseBanner type="error" :message="TEXTS.collectionView?.emptyCollection" />
        </div>

        <WireframeTable v-else>
          <BookMiniCard 
            v-for="livre in displayedBooks" 
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
          @execute="dispatchBatchAction"
          @clear="selectedIds = []"
        />
      </WireframePagination>
    </template>

    <LendModal
      :show="showLendModal"
      :bookCount="selectedIds.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />

    <!-- Modal de confirmation de suppression en lot -->
    <Teleport to="body">
      <div v-if="showDeleteModal" class="modal-overlay" @click.self="showDeleteModal = false">
        <div class="modal-box">
          <h2>{{ TEXTS.batchActionBar?.deleteConfirmTitle || 'Confirmer la suppression' }}</h2>
          <p class="modal-text">
            {{ selectedIds.length > 1 
              ? (TEXTS.batchActionBar?.deleteConfirmMsgPlural || 'Voulez-vous vraiment supprimer ces {count} ouvrages de votre collection ? Cette action est définitive et les retirera également de votre compte inventaire.io.').replace('{count}', selectedIds.length.toString())
              : (TEXTS.batchActionBar?.deleteConfirmMsgSingular || 'Voulez-vous vraiment supprimer cet ouvrage de votre collection ? Cette action est définitive et le retirera également de votre compte inventaire.io.') 
            }}
          </p>
          
          <div class="modal-actions">
            <button 
              @click="confirmGroupDelete" 
              class="btn-danger"
            >
              {{ TEXTS.batchActionBar?.btnDeleteConfirm || 'Supprimer' }}
            </button>
            
            <button @click="showDeleteModal = false" class="btn-close">
              {{ TEXTS.batchActionBar?.btnDeleteCancel || 'Annuler' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>