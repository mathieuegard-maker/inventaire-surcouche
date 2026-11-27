<!-- src/client/views/CollectionView.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BookCard from '../components/books/BookCard.vue';
import SeriesCard from '../components/books/SeriesCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import ListControlBar from '../components/base/ListControlBar.vue';
import PaginationBar from '../components/base/PaginationBar.vue';
import ConfirmDeleteModal from '../components/modals/ConfirmDeleteModal.vue';
import LendModal from '../components/modals/LendModal.vue';
import BatchGenreModal from '../components/modals/BatchGenreModal.vue';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import {
  applyBookListFilters,
  applySeriesListFilters,
  createEmptyListFilters,
  extractFilterFacets
} from '../../shared/bibliographic/list-filter.util';
import { stripLeadingArticles } from '../../shared/bibliographic/text-normalize.util';
import type { BookView } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

const route = useRoute();
const router = useRouter();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();

const state = libraryStore.collectionState;
const selectedIds = ref<Set<string>>(new Set());
const deleteModalOpen = ref(false);
const lendModalOpen = ref(false);
const genreModalOpen = ref(false);
const modalBusy = ref(false);

const sortOptions = computed(() => [
  { value: 'date', label: t('collection.sortDate') },
  { value: 'alpha', label: t('collection.sortAlpha') },
  { value: 'author', label: t('collection.sortAuthor') }
]);

const enabledFacets = computed(() =>
  state.tab === 'series'
    ? (['genre', 'author', 'publisher', 'series', 'seriesCompletion'] as const)
    : ([
        'genre',
        'author',
        'publisher',
        'series',
        'volumeNumber',
        'readingStatus',
        'loanState',
        'integralOnly'
      ] as const)
);

const facets = computed(() =>
  extractFilterFacets(libraryStore.ownedBooks, authStore.profile?.defaultGenres ?? [])
);

const booksBySeriesId = computed(() => {
  const map = new Map<string, BookView[]>();
  for (const b of libraryStore.ownedBooks) {
    if (!b.seriesId) continue;
    const list = map.get(b.seriesId) ?? [];
    list.push(b);
    map.set(b.seriesId, list);
  }
  return map;
});

const baseBooksList = computed(() =>
  state.tab === 'oneshots' ? libraryStore.oneshotOwnedBooks : libraryStore.ownedBooks
);

const filteredBooks = computed(() => {
  const filtered = applyBookListFilters(baseBooksList.value, state.filters);
  if (state.sortBy === 'alpha') {
    filtered.sort((a, b) =>
      stripLeadingArticles(a.title).localeCompare(stripLeadingArticles(b.title), 'fr', { sensitivity: 'base' })
    );
  } else if (state.sortBy === 'author') {
    filtered.sort((a, b) => (a.authors[0] ?? 'zzz').localeCompare(b.authors[0] ?? 'zzz', 'fr', { sensitivity: 'base' }));
  } else {
    filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return filtered;
});

const filteredSeries = computed(() => {
  const ownedSeries = libraryStore.series.filter((s) => s.ownedCount > 0);
  const list = applySeriesListFilters(ownedSeries, state.filters, booksBySeriesId.value);

  if (state.sortBy === 'alpha') {
    list.sort((a, b) =>
      stripLeadingArticles(a.canonicalName).localeCompare(stripLeadingArticles(b.canonicalName), 'fr', {
        sensitivity: 'base'
      })
    );
  } else if (state.sortBy === 'author') {
    list.sort((a, b) =>
      (a.primaryAuthors[0] ?? 'zzz').localeCompare(b.primaryAuthors[0] ?? 'zzz', 'fr', { sensitivity: 'base' })
    );
  } else {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return list;
});

const totalItems = computed(() =>
  state.tab === 'series' ? filteredSeries.value.length : filteredBooks.value.length
);

const totalPages = computed(() => Math.max(1, Math.ceil(totalItems.value / state.pageSize)));

watch(
  [() => state.tab, () => state.filters, () => state.sortBy, () => state.pageSize],
  () => {
    state.page = 1;
  },
  { deep: true }
);

watch(totalPages, (max) => {
  if (state.page > max) state.page = max;
});

// Permet de filtrer directement via query URL (ex: clic sur un genre depuis une fiche œuvre -> /collection?genre=BD)
watch(
  () => route.query,
  (q) => {
    const genreParam = typeof q.genre === 'string' ? q.genre.trim() : '';
    const authorParam = typeof q.author === 'string' ? q.author.trim() : '';
    const publisherParam = typeof q.publisher === 'string' ? q.publisher.trim() : '';
    if (genreParam || authorParam || publisherParam) {
      const next = createEmptyListFilters();
      next.genre = genreParam;
      next.author = authorParam;
      next.publisher = publisherParam;
      state.tab = 'books';
      state.filters = next;
      state.page = 1;
    }
  },
  { immediate: true }
);

const paginatedBooks = computed(() => {
  const start = (state.page - 1) * state.pageSize;
  return filteredBooks.value.slice(start, start + state.pageSize);
});

const paginatedSeries = computed(() => {
  const start = (state.page - 1) * state.pageSize;
  return filteredSeries.value.slice(start, start + state.pageSize);
});

const selectedBooks = computed(() =>
  filteredBooks.value.filter((b) => selectedIds.value.has(b.id))
);

function toggleSelect(bookId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedIds.value = next;
}

function toggleSelectAllPage(): void {
  const pageIds = paginatedBooks.value.map((b) => b.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.value.has(id));
  const next = new Set(selectedIds.value);
  if (allSelected) {
    for (const id of pageIds) next.delete(id);
  } else {
    for (const id of pageIds) next.add(id);
  }
  selectedIds.value = next;
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

async function handleBatchAction(action: BatchActionType): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, action);
  if (eligible.length === 0) return;

  if (action === 'DELETE') {
    deleteModalOpen.value = true;
    return;
  }
  if (action === 'LEND') {
    lendModalOpen.value = true;
    return;
  }
  if (action === 'RETURN') {
    const res = await libraryStore.returnBooks(eligible.map((b) => b.id));
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('loans.returnedToast'), 'success');
    clearSelection();
    return;
  }

  const targetStatus = action === 'ADD_OWNED' ? 'owned' : 'wish';
  const res = await libraryStore.applyBatchStatus({
    bookIds: eligible.map((b) => b.id),
    status: targetStatus
  });
  uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('batch.statusUpdatedToast'), 'success');
  clearSelection();
}

async function confirmDelete(payload: {
  bookIds: string[];
  lentDecisions: Record<string, 'keep' | 'return_and_delete'>;
}): Promise<void> {
  modalBusy.value = true;
  try {
    const res = await libraryStore.applyBatchStatus({
      bookIds: payload.bookIds,
      status: 'none',
      lentDecisions: payload.lentDecisions
    });
    deleteModalOpen.value = false;
    clearSelection();
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('batch.statusUpdatedToast'), 'success');
  } finally {
    modalBusy.value = false;
  }
}

async function confirmLend(payload: { borrowerName: string; notes?: string }): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, 'LEND');
  if (eligible.length === 0) return;
  modalBusy.value = true;
  try {
    const res = await libraryStore.lendBooks({
      bookIds: eligible.map((b) => b.id),
      borrowerName: payload.borrowerName,
      notes: payload.notes
    });
    lendModalOpen.value = false;
    clearSelection();
    uiStore.pushToast(
      res.offlineQueued ? t('batch.offlineQueuedToast') : t('loans.lentToast', { name: payload.borrowerName }),
      'success'
    );
  } finally {
    modalBusy.value = false;
  }
}

async function confirmGenres(genres: string[]): Promise<void> {
  const ids = selectedBooks.value.map((b) => b.id);
  if (ids.length === 0) return;
  modalBusy.value = true;
  try {
    await libraryStore.applyBatchGenres(ids, genres);
    genreModalOpen.value = false;
    clearSelection();
    uiStore.pushToast(t('batch.genresAppliedToast'), 'success');
  } finally {
    modalBusy.value = false;
  }
}

function openBook(bookId: string): void {
  libraryStore.setNavigationList(filteredBooks.value.map((b) => b.id));
  void router.push(`/book/${encodeURIComponent(bookId)}`);
}

function handleAddDefaultGenre(genre: string): void {
  void authStore.updateDefaultGenres('add', genre);
}

onMounted(() => {
  if (state.scrollY > 0 && !route.query.genre && !route.query.author) {
    window.scrollTo({ top: state.scrollY, behavior: 'auto' });
  }
});

onBeforeUnmount(() => {
  state.scrollY = window.scrollY;
});
</script>

<template>
  <section class="ds-stack">
    <div class="ds-page-head">
      <h1>{{ t('dashboard.myCollection') }}</h1>
      <span class="ds-badge ds-badge--accent">
        {{ t('collection.booksCount', { count: totalItems }) }}
      </span>
    </div>

    <div class="ds-segmented" role="tablist">
      <button
        type="button"
        role="tab"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': state.tab === 'books' }"
        @click="state.tab = 'books'"
      >
        {{ t('collection.modeBooks') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': state.tab === 'series' }"
        @click="state.tab = 'series'"
      >
        {{ t('collection.modeSeries') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': state.tab === 'oneshots' }"
        @click="state.tab = 'oneshots'"
      >
        {{ t('collection.modeOneshots') }}
      </button>
    </div>

    <ListControlBar
      :filters="state.filters"
      :facets="facets"
      :enabled-facets="enabledFacets"
      :sort-value="state.sortBy"
      :sort-options="sortOptions"
      :show-select-all="state.tab !== 'series' && paginatedBooks.length > 0"
      @update:filters="(next) => (state.filters = next)"
      @update:sort-value="(v) => (state.sortBy = v as 'date' | 'alpha' | 'author')"
      @select-all="toggleSelectAllPage"
    />

    <!-- Liste Séries -->
    <template v-if="state.tab === 'series'">
      <p v-if="paginatedSeries.length === 0" class="ds-card ds-text-muted">
        {{ t('collection.empty') }}
      </p>
      <div v-else class="ds-grid-2">
        <SeriesCard
          v-for="ser in paginatedSeries"
          :key="ser.id"
          :series="ser"
          @open="(id) => router.push(`/series/${encodeURIComponent(id)}`)"
        />
      </div>
    </template>

    <!-- Liste Livres / One-shots -->
    <template v-else>
      <p v-if="paginatedBooks.length === 0" class="ds-card ds-text-muted">
        {{ t('collection.empty') }}
      </p>
      <div v-else class="ds-grid-2">
        <BookCard
          v-for="book in paginatedBooks"
          :key="book.id"
          :book="book"
          selectable
          :selected="selectedIds.has(book.id)"
          @toggle-select="toggleSelect"
          @open="openBook"
        />
      </div>
    </template>

    <PaginationBar
      :page="state.page"
      :total-pages="totalPages"
      :page-size="state.pageSize"
      :total-items="totalItems"
      @update:page="(p) => (state.page = p)"
      @update:page-size="(s) => (state.pageSize = s)"
    />

    <BatchActionBar
      :selected-books="selectedBooks"
      @action="handleBatchAction"
      @open-genres="genreModalOpen = true"
      @clear="clearSelection"
    />

    <ConfirmDeleteModal
      :open="deleteModalOpen"
      :books="selectedBooks"
      :busy="modalBusy"
      @close="deleteModalOpen = false"
      @confirm="confirmDelete"
    />

    <LendModal
      :open="lendModalOpen"
      :book-count="filterEligibleBooksForBatchAction(selectedBooks, 'LEND').length"
      :contacts="libraryStore.contacts"
      :busy="modalBusy"
      @close="lendModalOpen = false"
      @confirm="confirmLend"
    />

    <BatchGenreModal
      :open="genreModalOpen"
      :book-count="selectedBooks.length"
      :default-genres="authStore.profile?.defaultGenres ?? []"
      :busy="modalBusy"
      @close="genreModalOpen = false"
      @confirm="confirmGenres"
      @add-default-genre="handleAddDefaultGenre"
    />
  </section>
</template>
