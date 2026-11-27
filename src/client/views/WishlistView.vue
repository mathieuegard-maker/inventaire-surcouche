<!-- src/client/views/WishlistView.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import BookCard from '../components/books/BookCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import ListControlBar from '../components/base/ListControlBar.vue';
import PaginationBar from '../components/base/PaginationBar.vue';
import ConfirmDeleteModal from '../components/modals/ConfirmDeleteModal.vue';
import BatchGenreModal from '../components/modals/BatchGenreModal.vue';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import { applyBookListFilters, extractFilterFacets } from '../../shared/bibliographic/list-filter.util';
import { normalizeTextKey, stripLeadingArticles } from '../../shared/bibliographic/text-normalize.util';
import type { BookView } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

const router = useRouter();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();

const state = libraryStore.wishlistState;
const selectedIds = ref<Set<string>>(new Set());
const deleteModalOpen = ref(false);
const genreModalOpen = ref(false);
const modalBusy = ref(false);

const sortOptions = computed(() => [
  { value: 'alpha', label: t('collection.sortAlpha') },
  { value: 'date', label: t('collection.sortDate') },
  { value: 'author', label: t('collection.sortAuthor') }
]);

const facets = computed(() =>
  extractFilterFacets(libraryStore.wishedBooks, authStore.profile?.defaultGenres ?? [])
);

const filteredWished = computed(() => {
  const list = applyBookListFilters(libraryStore.wishedBooks, state.filters);
  if (state.sortBy === 'date') {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } else if (state.sortBy === 'author') {
    list.sort((a, b) => (a.authors[0] ?? 'zzz').localeCompare(b.authors[0] ?? 'zzz', 'fr', { sensitivity: 'base' }));
  } else {
    list.sort((a, b) =>
      stripLeadingArticles(a.title).localeCompare(stripLeadingArticles(b.title), 'fr', { sensitivity: 'base' })
    );
  }
  return list;
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredWished.value.length / state.pageSize)));

watch(
  [() => state.filters, () => state.sortBy, () => state.pageSize],
  () => {
    state.page = 1;
  },
  { deep: true }
);

watch(totalPages, (max) => {
  if (state.page > max) state.page = max;
});

const paginatedWished = computed(() => {
  const start = (state.page - 1) * state.pageSize;
  return filteredWished.value.slice(start, start + state.pageSize);
});

// Regroupement Séries puis Livres indépendants sur la page courante
const seriesGroups = computed(() => {
  const map = new Map<string, { seriesName: string; books: BookView[] }>();
  for (const b of paginatedWished.value) {
    if (!b.seriesId && !b.seriesName) continue;
    const key = b.seriesId ?? normalizeTextKey(b.seriesName ?? '');
    const label = b.seriesName ?? '';
    let grp = map.get(key);
    if (!grp) {
      grp = { seriesName: label, books: [] };
      map.set(key, grp);
    }
    grp.books.push(b);
  }
  return Array.from(map.values())
    .map((g) => ({
      ...g,
      books: [...g.books].sort((a, b) => (a.sortOrder ?? a.volumeNumber ?? 999) - (b.sortOrder ?? b.volumeNumber ?? 999))
    }))
    .sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'fr'));
});

const standaloneBooks = computed(() =>
  paginatedWished.value.filter((b) => !b.seriesId && !b.seriesName)
);

const selectedBooks = computed(() =>
  filteredWished.value.filter((b) => selectedIds.value.has(b.id))
);

function toggleSelect(bookId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedIds.value = next;
}

function toggleSelectAllPage(): void {
  const pageIds = paginatedWished.value.map((b) => b.id);
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
  if (action === 'ADD_OWNED') {
    const res = await libraryStore.applyBatchStatus({
      bookIds: eligible.map((b) => b.id),
      status: 'owned'
    });
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('batch.statusUpdatedToast'), 'success');
    clearSelection();
  }
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
  const orderedIds = [
    ...seriesGroups.value.flatMap((g) => g.books.map((b) => b.id)),
    ...standaloneBooks.value.map((b) => b.id)
  ];
  const fullIds = filteredWished.value.map((b) => b.id);
  libraryStore.setNavigationList(fullIds.length > orderedIds.length ? fullIds : orderedIds);
  void router.push(`/book/${encodeURIComponent(bookId)}`);
}

onMounted(() => {
  if (state.scrollY > 0) window.scrollTo({ top: state.scrollY, behavior: 'auto' });
});

onBeforeUnmount(() => {
  state.scrollY = window.scrollY;
});
</script>

<template>
  <section class="ds-stack">
    <div class="ds-page-head">
      <h1>{{ t('wishlist.title') }}</h1>
      <span class="ds-badge ds-badge--accent">{{ t('collection.booksCount', { count: filteredWished.length }) }}</span>
    </div>

    <ListControlBar
      :filters="state.filters"
      :facets="facets"
      :enabled-facets="['genre', 'author', 'publisher', 'series', 'volumeNumber', 'integralOnly']"
      :placeholder="t('wishlist.searchPlaceholder')"
      :sort-value="state.sortBy"
      :sort-options="sortOptions"
      :show-select-all="paginatedWished.length > 0"
      @update:filters="(next) => (state.filters = next)"
      @update:sort-value="(v) => (state.sortBy = v as 'date' | 'alpha' | 'author')"
      @select-all="toggleSelectAllPage"
    />

    <p v-if="filteredWished.length === 0" class="ds-card ds-text-muted">
      {{ t('wishlist.empty') }}
    </p>

    <template v-else>
      <div v-if="seriesGroups.length > 0" class="ds-stack">
        <h2>{{ t('wishlist.seriesSection') }}</h2>
        <div v-for="grp in seriesGroups" :key="grp.seriesName" class="ds-card ds-stack">
          <h3>{{ grp.seriesName }}</h3>
          <div class="ds-grid-2">
            <BookCard
              v-for="book in grp.books"
              :key="book.id"
              :book="book"
              selectable
              show-wished-by
              :selected="selectedIds.has(book.id)"
              @toggle-select="toggleSelect"
              @open="openBook"
            />
          </div>
        </div>
      </div>

      <div v-if="standaloneBooks.length > 0" class="ds-stack">
        <h2>{{ t('wishlist.standaloneSection') }}</h2>
        <div class="ds-grid-2">
          <BookCard
            v-for="book in standaloneBooks"
            :key="book.id"
            :book="book"
            selectable
            show-wished-by
            :selected="selectedIds.has(book.id)"
            @toggle-select="toggleSelect"
            @open="openBook"
          />
        </div>
      </div>
    </template>

    <PaginationBar
      :page="state.page"
      :total-pages="totalPages"
      :page-size="state.pageSize"
      :total-items="filteredWished.length"
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

    <BatchGenreModal
      :open="genreModalOpen"
      :book-count="selectedBooks.length"
      :default-genres="authStore.profile?.defaultGenres ?? []"
      :busy="modalBusy"
      @close="genreModalOpen = false"
      @confirm="confirmGenres"
      @add-default-genre="(g) => authStore.updateDefaultGenres('add', g)"
    />
  </section>
</template>
