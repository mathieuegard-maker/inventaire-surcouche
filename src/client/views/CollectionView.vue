<!-- src/client/views/CollectionView.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import BookCard from '../components/books/BookCard.vue';
import SeriesCard from '../components/books/SeriesCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import PaginationBar from '../components/base/PaginationBar.vue';
import ConfirmDeleteModal from '../components/modals/ConfirmDeleteModal.vue';
import LendModal from '../components/modals/LendModal.vue';
import BatchGenreModal from '../components/modals/BatchGenreModal.vue';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import { normalizeTextKey, stripLeadingArticles } from '../../shared/bibliographic/text-normalize.util';
import { t } from '../../shared/locales';

const PAGE_SIZE = 24;

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

// Suggestions dynamiques pour le champ de filtre libre (genres, séries, auteurs, éditeurs)
const filterSuggestions = computed(() => {
  const set = new Set<string>();
  for (const b of libraryStore.ownedBooks) {
    if (b.seriesName) set.add(b.seriesName);
    if (b.publisher) set.add(b.publisher);
    for (const a of b.authors) set.add(a);
    for (const g of b.genres) set.add(g);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr')).slice(0, 120);
});

const baseBooksList = computed(() =>
  state.tab === 'oneshots' ? libraryStore.oneshotOwnedBooks : libraryStore.ownedBooks
);

const filteredBooks = computed(() => {
  const needle = normalizeTextKey(state.filterQuery);
  const filtered = needle
    ? baseBooksList.value.filter((b) => {
        const hay = normalizeTextKey(
          [b.title, b.seriesName ?? '', b.publisher ?? '', ...b.authors, ...b.genres].join(' ')
        );
        return hay.includes(needle);
      })
    : [...baseBooksList.value];

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
  const needle = normalizeTextKey(state.filterQuery);
  const ownedSeries = libraryStore.series.filter((s) => s.ownedCount > 0);
  const list = needle
    ? ownedSeries.filter((s) => {
        const hay = normalizeTextKey([s.canonicalName, ...s.primaryAuthors, ...s.aliases].join(' '));
        return hay.includes(needle);
      })
    : [...ownedSeries];

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

const totalPages = computed(() => Math.max(1, Math.ceil(totalItems.value / PAGE_SIZE)));

watch([() => state.tab, () => state.filterQuery, () => state.sortBy], () => {
  state.page = 1;
});

watch(totalPages, (max) => {
  if (state.page > max) state.page = max;
});

const paginatedBooks = computed(() => {
  const start = (state.page - 1) * PAGE_SIZE;
  return filteredBooks.value.slice(start, start + PAGE_SIZE);
});

const paginatedSeries = computed(() => {
  const start = (state.page - 1) * PAGE_SIZE;
  return filteredSeries.value.slice(start, start + PAGE_SIZE);
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

function handleAddDefaultGenre(genre: string): void {
  void authStore.updateDefaultGenres('add', genre);
}

onMounted(() => {
  if (state.scrollY > 0) {
    window.scrollTo({ top: state.scrollY, behavior: 'auto' });
  }
});

onBeforeUnmount(() => {
  state.scrollY = window.scrollY;
});
</script>

<template>
  <section class="ds-stack">
    <div class="ds-row ds-row--between">
      <h1>{{ t('dashboard.myCollection') }}</h1>
      <span class="ds-badge">
        {{ t('collection.booksCount', { count: totalItems }) }}
      </span>
    </div>

    <div class="ds-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': state.tab === 'books' }"
        @click="state.tab = 'books'"
      >
        {{ t('collection.modeBooks') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': state.tab === 'series' }"
        @click="state.tab = 'series'"
      >
        {{ t('collection.modeSeries') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': state.tab === 'oneshots' }"
        @click="state.tab = 'oneshots'"
      >
        {{ t('collection.modeOneshots') }}
      </button>
    </div>

    <!-- Barre filtres & tris -->
    <div class="ds-panel ds-row">
      <input
        v-model="state.filterQuery"
        type="search"
        list="collection-filter-suggestions"
        class="ds-input collection-filter-input"
        :placeholder="t('collection.filterPlaceholder')"
      />
      <datalist id="collection-filter-suggestions">
        <option v-for="sug in filterSuggestions" :key="sug" :value="sug" />
      </datalist>

      <select v-model="state.sortBy" class="ds-input collection-sort-select" :aria-label="t('collection.sortDate')">
        <option value="date">{{ t('collection.sortDate') }}</option>
        <option value="alpha">{{ t('collection.sortAlpha') }}</option>
        <option value="author">{{ t('collection.sortAuthor') }}</option>
      </select>

      <button
        v-if="state.tab !== 'series' && paginatedBooks.length > 0"
        type="button"
        class="ds-btn ds-btn--sm"
        @click="toggleSelectAllPage"
      >
        {{ t('collection.selectAll') }}
      </button>
    </div>

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
          @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
        />
      </div>
    </template>

    <PaginationBar :page="state.page" :total-pages="totalPages" @update:page="(p) => (state.page = p)" />

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

<style scoped>
.collection-filter-input {
  flex: 1;
  min-width: 220px;
}

.collection-sort-select {
  width: auto;
  min-width: 170px;
}
</style>
