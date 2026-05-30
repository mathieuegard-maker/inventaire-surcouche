<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { wishlistService } from '../../core/services/wishlist.service';
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
import { getOrCreateViewState, saveViewState } from '../../state/viewState';

const allWishBooks = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);
const showDeleteModal = ref(false);

const stateKey = 'wishlist';
const pageState = getOrCreateViewState(stateKey, {
  currentPage: 1,
  pageSize: 20,
  searchQuery: '',
  filters: {
    genre: 'all',
    author: 'all'
  }
});

const selectedGenre = ref(pageState.filters.genre || 'all');
const selectedAuthor = ref(pageState.filters.author || 'all');

const currentPage = ref(pageState.currentPage);
const pageSize = ref(pageState.pageSize);
const searchQuery = ref(pageState.searchQuery);

const displayedWishBooks = ref<HumanizedBook[]>([]);

const isAllSelected = computed(() => {
  const targets = filteredBooks.value;
  return targets.length > 0 && selectedIds.value.length === targets.length;
});

watch(selectedGenre, (newGenre) => {
  pageState.filters.genre = newGenre;
});
watch(selectedAuthor, (newAuthor) => {
  pageState.filters.author = newAuthor;
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
  await fetchWishlist();
  if (pageState.scrollPosition > 0) {
    setTimeout(() => {
      window.scrollTo({ top: pageState.scrollPosition, behavior: 'instant' });
    }, 100);
  }
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

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE') => {
  if (selectedIds.value.length === 0) return;

  if (action === 'DELETE') {
    showDeleteModal.value = true;
    return;
  }

  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction(action, uri);
    }
    await fetchWishlist();
  } catch (e) {
    console.error("[WISHLIST BATCH ERROR]", e);
  }
};

const confirmGroupDelete = async () => {
  try {
    await wishlistService.removeFromWishlist(selectedIds.value);
    await fetchWishlist();
  } catch (e) {
    console.error("Erreur lors de la suppression en lot de la wishlist :", e);
  } finally {
    showDeleteModal.value = false;
    selectedIds.value = [];
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

    <BaseLoading v-if="isLoading" />

    <template v-else>
      <WireframePagination
        :items="filteredBooks"
        :searchKeys="['title', 'series', 'authors']"
        :hasSelectAll="true"
        :selectAllValue="isAllSelected"
        :selectedCount="selectedIds.length"
        v-model:currentPage="currentPage"
        v-model:pageSize="pageSize"
        v-model:searchQuery="searchQuery"
        @update:selectAllValue="handleToggleAll"
        @update:processedItems="(val) => displayedWishBooks = val"
      >
        <div class="main-content-wrapper">
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

        <BatchActionBar 
          :selected-count="selectedIds.length"
          :is-mixed="false"
          context="wishlist"
          @execute="dispatchBatchAction"
        />
      </WireframePagination>
    </template>

    <!-- Modal de confirmation de suppression en lot pour la wishlist -->
    <div v-if="showDeleteModal" class="modal-overlay" @click.self="showDeleteModal = false">
      <div class="modal-box">
        <h2>{{ TEXTS.batchActionBar?.deleteConfirmTitle || 'Confirmer la suppression' }}</h2>
        <p class="modal-text">
          {{ selectedIds.length > 1 
            ? (TEXTS.batchActionBar?.deleteConfirmWishMsgPlural || 'Voulez-vous vraiment retirer ces {count} ouvrages de votre liste d\'envies ? Cette action est définitive et les retirera également de votre compte inventaire.io.').replace('{count}', selectedIds.length.toString())
            : (TEXTS.batchActionBar?.deleteConfirmWishMsgSingular || 'Voulez-vous vraiment retirer cet ouvrage de votre liste d\'envies ? Cette action est définitive et le retirera également de votre compte inventaire.io.') 
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
  </div>
</template>