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
import SeriesMergeModal from '../components/SeriesMergeModal.vue';
import BatchGenreModal from '../components/BatchGenreModal.vue';
import { filterEligibleBooksForBatchAction } from '../../core/utils/batch-actions.util';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';
import { getOrCreateViewState, saveViewState } from '../../state/viewState';
import { imageUtil } from '../../core/utils/image.util';
import { normalizeTextKey } from '../../core/resolvers/bnf.resolver';
import { scannerState } from '../../state/scanner';
import { syncOrchestrator } from '../../core/orchestrators/sync.orchestrator';
import { annotateIntegralCoverage } from '../../core/bibliographic/integral.util';
import { saveBookNavigationOrder, sortBooksByCollectionMode, sortSeriesTomes } from '../../state/bookNavigation';

const router = useRouter();
const route = useRoute();

const allOwnedBooks = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);
const showLendModal = ref(false);
const showSeriesAttachModal = ref(false);
const showBatchGenreModal = ref(false);

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
const queryFilter = typeof route.query.filter === 'string' ? route.query.filter : typeof route.query.genre === 'string' ? route.query.genre : '';
const filterText = ref(queryFilter || (pageState.filters.genre === 'all' ? '' : (pageState.filters.genre || '')));
const currentSort = ref(pageState.filters.sort || 'date');

watch(
  () => [route.query.filter, route.query.genre, route.query.mode],
  ([f, g, m]) => {
    const nextFilter = typeof f === 'string' ? f : typeof g === 'string' ? g : null;
    if (nextFilter !== null) {
      filterText.value = nextFilter;
    }
    if (m === 'books' || m === 'series' || m === 'oneshots') {
      currentMode.value = m;
    }
  }
);

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

let hasTriggeredBackgroundHydration = false;

onMounted(async () => {
  await fetchCatalogue(false);
  if (pageState.scrollPosition > 0) {
    setTimeout(() => {
      window.scrollTo({ top: pageState.scrollPosition, behavior: 'instant' });
    }, 100);
  }
});

watch(
  () => scannerState.lastUpdatedTick.value,
  () => {
    fetchCatalogue(true);
  }
);

const fetchCatalogue = async (silent = false) => {
  if (!silent && allOwnedBooks.value.length === 0) {
    isLoading.value = true;
  }
  try {
    const cached = await databaseService.getAllBooksFromCache();
    const rawOwned = cached.filter(b => b.ownershipStatus === 'owned');

    // Déduplication canonique (évite doublons work + edition + v4)
    const dedupMap = new Map<string, HumanizedBook>();
    for (const book of rawOwned) {
      const key = book.bookId || book.workUri || book.isbn13 || book.uri;
      if (!dedupMap.has(key)) {
        dedupMap.set(key, book);
      }
    }
    const owned = annotateIntegralCoverage(Array.from(dedupMap.values()), cached);

    const loans = await databaseService.getAllLoans();
    const loanByUri = new Map(loans.map((l) => [l.uri, l]));
    for (const livre of owned) {
      const activeLoan = loanByUri.get(livre.uri);
      if (activeLoan) {
        livre.loan = activeLoan;
      }
    }

    const buildSig = (list: HumanizedBook[]) =>
      list
        .map(
          (b) =>
            `${b.uri}|${b.ownershipStatus}|${b.isIntegral ? '1' : '0'}|${(b.integralMetadata?.includedVolumeNumbers || []).join(',')}|${b.ownedViaIntegral?.integralBookId || ''}|${b.loan?.friendName || ''}|${b.localCover ? '1' : b.coverUrl || ''}`
        )
        .sort()
        .join('\n');

    if (!silent || buildSig(allOwnedBooks.value) !== buildSig(owned)) {
      allOwnedBooks.value = owned;
    }
    if (!silent) {
      selectedIds.value = [];
    }

    // Déclencher la synchronisation serveur en arrière-plan sans bloquer ni faire sauter l'UI (au plus 1 fois par montage)
    if (!hasTriggeredBackgroundHydration) {
      const registryUris = await databaseService.getAllRegistryUris('inventory');
      if (registryUris.length !== owned.length) {
        hasTriggeredBackgroundHydration = true;
        syncOrchestrator.hydrateCacheInBackground().catch(() => {});
      }
    }
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
  const idByNormName = new Map<string, string>();

  // Passe 1 : regrouper d'abord les livres ayant un seriesId explicite
  for (const book of list) {
    if (!book.seriesId) continue;
    const key = book.seriesId;
    if (!groups[key]) {
      groups[key] = {
        id: book.seriesId,
        name: book.series || book.seriesId,
        tomes: []
      };
    }
    if (book.series && !idByNormName.has(normalizeTextKey(book.series))) {
      idByNormName.set(normalizeTextKey(book.series), key);
    }
    groups[key].tomes.push(book);
  }

  // Passe 2 : rattacher les livres locaux sans seriesId au groupe existant de même nom si présent
  for (const book of list) {
    if (book.seriesId) continue;
    const nameKey = book.series ? normalizeTextKey(book.series) : '';
    const existingIdKey = nameKey ? idByNormName.get(nameKey) : undefined;
    const key = existingIdKey || book.series || 'unknown';
    if (!groups[key]) {
      groups[key] = {
        id: book.series || '',
        name: book.series || '',
        tomes: []
      };
    }
    groups[key].tomes.push(book);
  }

  const gondolas = Object.values(groups).map(g => {
    const sortedTomes = sortSeriesTomes(g.tomes);
    const coverBook = sortedTomes.find(t => t.localCover || t.coverUrl) || sortedTomes[0];
    const primaryAuthor = (sortedTomes.find(t => t.authors?.length)?.authors?.[0] || '').toLowerCase();
    const latestAdded = Math.max(...sortedTomes.map(t => t.addedDate || 0), 0);
    return {
      id: g.id,
      name: g.name,
      ownedCount: sortedTomes.length,
      coverUrl: imageUtil.resolveCoverUrl(coverBook),
      primaryAuthor,
      latestAdded
    };
  });

  const cleanSortName = (n: string) =>
    n.replace(/^(?:les|la|le|un|une|des|du|de|the|an|a)\s+/i, '').replace(/^l['’]\s*/i, '').trim().toLowerCase();

  return gondolas.sort((a, b) => {
    if (currentSort.value === 'date') {
      if (b.latestAdded !== a.latestAdded) return b.latestAdded - a.latestAdded;
    } else if (currentSort.value === 'author') {
      const authCmp = (a.primaryAuthor || 'zzz').localeCompare(b.primaryAuthor || 'zzz', 'fr');
      if (authCmp !== 0) return authCmp;
    }
    return cleanSortName(a.name).localeCompare(cleanSortName(b.name), 'fr');
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
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, action);
  if (eligible.length === 0) return;

  if (action === 'LEND') {
    showLendModal.value = true;
    return;
  }

  if (action === 'DELETE') {
    try {
      for (const b of eligible) {
        await inventoryService.removeFromLibrary(b.uri);
      }
      await fetchCatalogue();
    } catch (e) {
      console.error("Erreur lors de la suppression en lot :", e);
    } finally {
      selectedIds.value = [];
    }
    return;
  }

  try {
    for (const b of eligible) {
      await queueService.enqueueAction(action, b.uri);
    }
    await fetchCatalogue();
    selectedIds.value = [];
  } catch (e) {
    console.error(e);
  }
};

const eligibleLendBooks = computed(() =>
  filterEligibleBooksForBatchAction(selectedBooks.value, 'LEND')
);

const confirmGroupLend = async (friendName: string) => {
  try {
    for (const b of eligibleLendBooks.value) {
      await queueService.enqueueAction('LEND', b.uri, { friendName });
    }
    await fetchCatalogue();
    selectedIds.value = [];
  } catch (e) {
    console.error(e);
  } finally {
    showLendModal.value = false;
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
          :allow-series-attach="true"
          :allow-genre-add="true"
          @execute="dispatchBatchAction"
          @attach-series="showSeriesAttachModal = true"
          @add-genre="showBatchGenreModal = true"
          @clear="selectedIds = []"
        />
      </WireframePagination>
    </template>

    <LendModal
      :show="showLendModal"
      :bookCount="eligibleLendBooks.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />

    <SeriesMergeModal
      :show="showSeriesAttachModal"
      :bookUris="selectedIds"
      :singleBook="selectedIds.length === 1"
      @close="showSeriesAttachModal = false"
      @merged="() => { selectedIds = []; void fetchCatalogue(); }"
    />

    <BatchGenreModal
      :show="showBatchGenreModal"
      :bookUris="selectedIds"
      @close="showBatchGenreModal = false"
      @applied="() => { selectedIds = []; void fetchCatalogue(); }"
    />
  </div>
</template>