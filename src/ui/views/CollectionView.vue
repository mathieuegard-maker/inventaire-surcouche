<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import LendModal from '../components/LendModal.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const router = useRouter();

const allOwnedBooks = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);
const showLendModal = ref(false);

const currentMode = ref<'books' | 'series' | 'oneshots'>('books');
const selectedGenre = ref('all');
const currentSort = ref('title');

const isAllSelected = computed(() => {
  const targets = currentSortBooks.value;
  return targets.length > 0 && selectedIds.value.length === targets.length;
});

onMounted(async () => {
  await fetchCatalogue();
});

const fetchCatalogue = async () => {
  isLoading.value = true;
  try {
    const cached = await databaseService.getAllBooksFromCache();
    const owned = cached.filter(b => b.ownershipStatus === 'owned');
    
    // HYDRATATION DES PRÊTS : On injecte les données de prêt locales dans chaque livre du catalogue
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

const navigateToSeries = (seriesId: string) => {
  if (seriesId) {
    router.push({ name: 'SeriesView', params: { id: seriesId } });
  }
};

const dynamicGenres = computed(() => {
  const genresSet = new Set<string>();
  allOwnedBooks.value.forEach(book => {
    if (book.genres && Array.isArray(book.genres)) {
      book.genres.forEach(g => genresSet.add(g));
    }
  });
  return Array.from(genresSet).sort();
});

const processedBooks = computed(() => {
  let list = [...allOwnedBooks.value];

  if (selectedGenre.value !== 'all') {
    list = list.filter(b => b.genres && b.genres.includes(selectedGenre.value));
  }

  if (currentMode.value === 'oneshots') {
    return list.filter(b => !b.seriesId && !b.series);
  }
  return list;
});

const seriesGondolas = computed(() => {
  let list = allOwnedBooks.value.filter(b => b.seriesId || b.series);

  if (selectedGenre.value !== 'all') {
    list = list.filter(b => b.genres && b.genres.includes(selectedGenre.value));
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
    g.tomes.sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
    return {
      id: g.id,
      name: g.name,
      ownedCount: g.tomes.length,
      coverUrl: g.tomes[0]?.coverUrl
    };
  });

  return gondolas.sort((a, b) => a.name.localeCompare(b.name));
});

const currentSortBooks = computed(() => {
  const list = [...processedBooks.value];

  if (currentSort.value === 'title') {
    return list.sort((a, b) => a.title.localeCompare(b.title));
  } else if (currentSort.value === 'author') {
    return list.sort((a, b) => {
      const authA = a.authors && a.authors[0] ? a.authors[0] : '';
      const authB = b.authors && b.authors[0] ? b.authors[0] : '';
      return authA.localeCompare(authB);
    });
  } else if (currentSort.value === 'date') {
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return list;
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
    selectedIds.value = currentSortBooks.value.map(b => b.uri);
  }
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN') => {
  if (selectedIds.value.length === 0 || isSelectionMixed.value) return;

  if (action === 'LEND') {
    showLendModal.value = true;
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

const resetSelection = () => {
  selectedIds.value = [];
};
</script>

<template>
  <div class="view-container">
    <BaseHeader :title="TEXTS.collectionView?.title" showBack />

    <div class="collection-modes-tabs">
      <button :class="['tab-button', { active: currentMode === 'books' }]" @click="currentMode = 'books'; resetSelection()">
        {{ TEXTS.collectionView?.modeBooks }}
      </button>
      <button :class="['tab-button', { active: currentMode === 'series' }]" @click="currentMode = 'series'; resetSelection()">
        {{ TEXTS.collectionView?.modeSeries }}
      </button>
      <button :class="['tab-button', { active: currentMode === 'oneshots' }]" @click="currentMode = 'oneshots'; resetSelection()">
        {{ TEXTS.collectionView?.modeOneShots }}
      </button>
    </div>

    <BatchActionBar 
      v-if="!isLoading && currentMode !== 'series'"
      :model-value="isAllSelected"
      :selected-count="selectedIds.length"
      :is-mixed="isSelectionMixed"
      :context="batchContext"
      @update:model-value="handleToggleAll"
      @execute="dispatchBatchAction"
    />

    <div class="collection-controls-bar" v-if="!isLoading">
      <div class="control-group">
        <label>{{ TEXTS.collectionView?.filterGenreLabel }}</label>
        <select v-model="selectedGenre" class="control-select" @change="resetSelection">
          <option value="all">{{ TEXTS.collectionView?.filterGenreAll }}</option>
          <option v-for="genre in dynamicGenres" :key="genre" :value="genre">{{ genre }}</option>
        </select>
      </div>

      <div class="control-group" v-if="currentMode !== 'series'">
        <label>{{ TEXTS.collectionView?.sortLabel }}</label>
        <select v-model="currentSort" class="control-select">
          <option value="title">{{ TEXTS.collectionView?.sortByTitle }}</option>
          <option value="author">{{ TEXTS.collectionView?.sortByAuthor }}</option>
          <option value="date">{{ TEXTS.collectionView?.sortByDate }}</option>
        </select>
      </div>
    </div>

    <BaseLoading v-if="isLoading" />

    <div class="series-list-container" v-else>
      <template v-if="currentMode === 'series'">
        <BaseBanner v-if="seriesGondolas.length === 0" type="error" :message="TEXTS.collectionView?.emptyCollection" />
        
        <div v-for="saga in seriesGondolas" :key="saga.id" class="mini-card-row" @click="navigateToSeries(saga.id)">
          <div class="row-cover-container">
            <img v-if="saga.coverUrl" :src="saga.coverUrl" class="row-cover-image" />
            <div v-else class="row-cover-fallback"><span class="fallback-title">{{ saga.name }}</span></div>
          </div>
          <div class="row-info-content">
            <p class="row-title">{{ saga.name }}</p>
            <p class="row-series-meta">{{ saga.ownedCount }} {{ TEXTS.collectionView?.tomesOwned }}</p>
          </div>
        </div>
      </template>

      <template v-else>
        <BaseBanner v-if="currentSortBooks.length === 0" type="error" :message="TEXTS.collectionView?.emptyCollection" />
        
        <BookMiniCard 
          v-for="livre in currentSortBooks" 
          :key="livre.uri" 
          :book="livre"
          :model-value="selectedIds.includes(livre.uri)"
          @update:model-value="(val) => {
            if(val) {
              if (!selectedIds.includes(livre.uri)) selectedIds.push(livre.uri);
            }
            else selectedIds = selectedIds.filter(id => id !== livre.uri);
          }"
        />
      </template>
    </div>

    <LendModal
      :show="showLendModal"
      :bookCount="selectedIds.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />
  </div>
</template>