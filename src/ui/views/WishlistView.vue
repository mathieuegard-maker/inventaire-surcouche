<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { databaseService } from '../../core/database/database.service';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const allWishBooks = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);

const selectedGenre = ref('all');
const selectedAuthor = ref('all');

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

const groupedWishlist = computed(() => {
  const list = filteredBooks.value;
  const seriesGroups: Record<string, HumanizedBook[]> = {};
  const independents: HumanizedBook[] = [];

  list.forEach(book => {
    if (book.series || book.seriesId) {
      const key = book.series || book.seriesId || 'unknown';
      if (!seriesGroups[key]) {
        seriesGroups[key] = [];
      }
      seriesGroups[key].push(book);
    } else {
      independents.push(book);
    }
  });

  for (const key in seriesGroups) {
    seriesGroups[key].sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
  }

  independents.sort((a, b) => a.title.localeCompare(b.title));

  return {
    series: seriesGroups,
    independents
  };
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
    <BaseHeader :title="TEXTS.wishlistView?.title" showBack />

    <BatchActionBar 
      v-if="!isLoading"
      :model-value="isAllSelected"
      :selected-count="selectedIds.length"
      :is-mixed="false"
      context="wishlist"
      @update:model-value="handleToggleAll"
      @execute="dispatchBatchAction"
    />

    <div class="collection-controls-bar" v-if="!isLoading">
      <div class="control-group">
        <label>{{ TEXTS.collectionView?.filterGenreLabel }}</label>
        <select v-model="selectedGenre" class="control-select" @change="resetFilters">
          <option value="all">{{ TEXTS.collectionView?.filterGenreAll }}</option>
          <option v-for="genre in dynamicGenres" :key="genre" :value="genre">{{ genre }}</option>
        </select>
      </div>

      <div class="control-group">
        <label>{{ TEXTS.wishlistView?.filterAuthorLabel }}</label>
        <select v-model="selectedAuthor" class="control-select" @change="resetFilters">
          <option value="all">{{ TEXTS.wishlistView?.filterAuthorAll }}</option>
          <option v-for="author in dynamicAuthors" :key="author" :value="author">{{ author }}</option>
        </select>
      </div>
    </div>

    <BaseLoading v-if="isLoading" />

    <div class="series-list-container" v-else>
      <BaseBanner v-if="filteredBooks.length === 0" type="error" :message="TEXTS.wishlistView?.emptyWishlist" />

      <template v-else>
        <div v-for="(tomes, seriesName) in groupedWishlist.series" :key="seriesName">
          <div class="wishlist-section-header">
            {{ TEXTS.wishlistView?.seriesSection }}{{ seriesName }}
          </div>
          <BookMiniCard 
            v-for="livre in tomes" 
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
        </div>

        <div v-if="groupedWishlist.independents.length > 0">
          <div class="wishlist-section-header">
            ✨ {{ TEXTS.wishlistView?.independentBooks }}
          </div>
          <BookMiniCard 
            v-for="livre in groupedWishlist.independents" 
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
        </div>
      </template>
    </div>
  </div>
</template>