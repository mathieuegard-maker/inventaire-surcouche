<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { databaseService } from '../../core/database/database.service';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import WireframeTable from '../components/WireframeTable.vue';
import WireframePagination from '../components/WireframePagination.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const allWishBooks = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);

const selectedGenre = ref('all');
const selectedAuthor = ref('all');

const displayedWishBooks = ref<HumanizedBook[]>([]);

const isAllSelected = computed(() => {
  const targets = filteredBooks.value;
  return targets.length > 0 && selectedIds.value.length === targets.length;
});

onMounted(async () => {
  await fetchWishlist();
});

const fetchWishlist = async () => {
  isLoading.value = true;
  try {
    const cached = await databaseService.getAllBooksFromCache();
    allWishBooks.value = cached.filter(b => b.ownershipStatus === 'wish');
    selectedIds.value = [];
  } catch (e) {
    console.error("[WISHLIST VIEW] Échec de lecture du cache :", e);
  } finally {
    isLoading.value = false;
  }
};

const dynamicGenres = computed(() => {
  const genresSet = new Set<string>();
  allWishBooks.value.forEach(book => {
    if (book.genres && Array.isArray(book.genres)) {
      book.genres.forEach(g => genresSet.add(g));
    }
  });
  return Array.from(genresSet).sort();
});

const dynamicAuthors = computed(() => {
  const authorsSet = new Set<string>();
  allWishBooks.value.forEach(book => {
    if (book.authors && Array.isArray(book.authors)) {
      book.authors.forEach(a => authorsSet.add(a));
    }
  });
  return Array.from(authorsSet).sort();
});

const filteredBooks = computed(() => {
  let list = [...allWishBooks.value];

  if (selectedGenre.value !== 'all') {
    list = list.filter(b => b.genres && b.genres.includes(selectedGenre.value));
  }

  if (selectedAuthor.value !== 'all') {
    list = list.filter(b => b.authors && b.authors.includes(selectedAuthor.value));
  }

  return list;
});

const sortedSeriesGroups = computed(() => {
  const list = displayedWishBooks.value;
  const seriesGroups: Record<string, HumanizedBook[]> = {};

  list.forEach(book => {
    if (book.series || book.seriesId) {
      const key = book.series || book.seriesId || 'unknown';
      if (!seriesGroups[key]) {
        seriesGroups[key] = [];
      }
      seriesGroups[key].push(book);
    }
  });

  for (const key in seriesGroups) {
    seriesGroups[key].sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
  }

  return Object.keys(seriesGroups)
    .map(name => ({ name, tomes: seriesGroups[name] }))
    .sort((a, b) => {
      const cleanA = a.name.replace(/^(les\s+|la\s+|le\s+|l'|une\s+|un\s+)/i, '').trim().toLowerCase();
      const cleanB = b.name.replace(/^(les\s+|la\s+|le\s+|l'|une\s+|un\s+)/i, '').trim().toLowerCase();
      return cleanA.localeCompare(cleanB);
    });
});

const independentBooksSorted = computed(() => {
  return displayedWishBooks.value
    .filter(b => !b.series && !b.seriesId)
    .sort((a, b) => a.title.localeCompare(b.title));
});

const handleToggleAll = (checked: boolean) => {
  if (!checked) {
    selectedIds.value = [];
  } else {
    selectedIds.value = filteredBooks.value.map(b => b.uri);
  }
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN') => {
  if (selectedIds.value.length === 0) return;

  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction(action, uri);
    }
    await fetchWishlist();
  } catch (e) {
    console.error("[WISHLIST BATCH ERROR]", e);
  }
};

const resetFilters = () => {
  selectedIds.value = [];
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle :text="TEXTS.wishlistView?.title" level="h2" />

    <div class="collection-controls-bar" v-if="!isLoading">
      <div class="control-group">
        <label class="control-label">{{ TEXTS.collectionView?.filterGenreLabel }}</label>
        <select v-model="selectedGenre" class="wireframe-input control-select" @change="resetFilters">
          <option value="all">{{ TEXTS.collectionView?.filterGenreAll }}</option>
          <option v-for="genre in dynamicGenres" :key="genre" :value="genre">{{ genre }}</option>
        </select>
      </div>

      <div class="control-group">
        <label class="control-label">{{ TEXTS.wishlistView?.filterAuthorLabel }}</label>
        <select v-model="selectedAuthor" class="wireframe-input control-select" @change="resetFilters">
          <option value="all">{{ TEXTS.wishlistView?.filterAuthorAll }}</option>
          <option v-for="author in dynamicAuthors" :key="author" :value="author">{{ author }}</option>
        </select>
      </div>
    </div>

    <WireframePagination
      v-if="!isLoading"
      :items="filteredBooks"
      :searchKeys="['title']"
      :hasSelectAll="true"
      :selectAllValue="isAllSelected"
      :selectedCount="selectedIds.length"
      @update:selectAllValue="handleToggleAll"
      @update:processedItems="(val) => displayedWishBooks = val"
    />

    <BatchActionBar 
      v-if="!isLoading"
      :selected-count="selectedIds.length"
      :is-mixed="false"
      context="wishlist"
      @execute="dispatchBatchAction"
    />

    <BaseLoading v-if="isLoading" />

    <div class="main-content-wrapper" v-else>
      <BaseBanner v-if="displayedWishBooks.length === 0" type="error" :message="TEXTS.wishlistView?.emptyWishlist" />

      <template v-else>
        <div v-for="group in sortedSeriesGroups" :key="group.name">
          <div class="wishlist-section-header">
            {{ TEXTS.wishlistView?.seriesSection }}{{ group.name }}
          </div>
          <WireframeTable>
            <BookMiniCard 
              v-for="livre in group.tomes" 
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
        </div>

        <div v-if="independentBooksSorted.length > 0">
          <div class="wishlist-section-header">
            ✨ {{ TEXTS.wishlistView?.independentBooks }}
          </div>
          <WireframeTable>
            <BookMiniCard 
              v-for="livre in independentBooksSorted" 
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
        </div>
      </template>
    </div>
  </div>
</template>