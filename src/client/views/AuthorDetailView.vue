<!-- src/client/views/AuthorDetailView.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BookCard from '../components/books/BookCard.vue';
import SeriesCard from '../components/books/SeriesCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import ConfirmDeleteModal from '../components/modals/ConfirmDeleteModal.vue';
import LendModal from '../components/modals/LendModal.vue';
import BatchGenreModal from '../components/modals/BatchGenreModal.vue';
import { apiRequest } from '../api/client';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type { BookView, SeriesView } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

const route = useRoute();
const router = useRouter();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();

const loading = ref(true);
const authorName = ref('');
const seriesList = ref<SeriesView[]>([]);
const books = ref<BookView[]>([]);
const query = ref('');
const selectedIds = ref<Set<string>>(new Set());

const deleteOpen = ref(false);
const lendOpen = ref(false);
const genreOpen = ref(false);
const modalBusy = ref(false);

async function loadAuthor(): Promise<void> {
  const raw = typeof route.params.name === 'string' ? decodeURIComponent(route.params.name) : '';
  if (!raw) return;
  authorName.value = raw;
  loading.value = true;
  selectedIds.value = new Set();
  try {
    const res = await apiRequest<{ ok: true; authorName: string; series: SeriesView[]; books: BookView[] }>(
      `/api/authors/${encodeURIComponent(raw)}`
    );
    authorName.value = res.authorName;
    seriesList.value = res.series;
    books.value = res.books;
  } finally {
    loading.value = false;
  }
}

watch(() => route.params.name, () => {
  void loadAuthor();
}, { immediate: true });

const filteredBooks = computed(() => {
  const needle = normalizeTextKey(query.value);
  if (!needle) return books.value;
  return books.value.filter((b) =>
    normalizeTextKey([b.title, b.seriesName ?? '', ...b.genres].join(' ')).includes(needle)
  );
});

const selectedBooks = computed(() =>
  books.value.filter((b) => selectedIds.value.has(b.id))
);

function toggleSelect(bookId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedIds.value = next;
}

async function handleBatchAction(action: BatchActionType): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, action);
  if (eligible.length === 0) return;
  if (action === 'DELETE') {
    deleteOpen.value = true;
    return;
  }
  if (action === 'LEND') {
    lendOpen.value = true;
    return;
  }
  if (action === 'RETURN') {
    await libraryStore.returnBooks(eligible.map((b) => b.id));
    uiStore.pushToast(t('loans.returnedToast'), 'success');
    await loadAuthor();
    return;
  }
  await libraryStore.applyBatchStatus({
    bookIds: eligible.map((b) => b.id),
    status: action === 'ADD_OWNED' ? 'owned' : 'wish'
  });
  uiStore.pushToast(t('batch.statusUpdatedToast'), 'success');
  await loadAuthor();
}

async function confirmDelete(payload: {
  bookIds: string[];
  lentDecisions: Record<string, 'keep' | 'return_and_delete'>;
}): Promise<void> {
  modalBusy.value = true;
  try {
    await libraryStore.applyBatchStatus({
      bookIds: payload.bookIds,
      status: 'none',
      lentDecisions: payload.lentDecisions
    });
    deleteOpen.value = false;
    await loadAuthor();
    uiStore.pushToast(t('batch.statusUpdatedToast'), 'success');
  } finally {
    modalBusy.value = false;
  }
}

async function confirmLend(payload: { borrowerName: string; notes?: string }): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, 'LEND');
  if (eligible.length === 0) return;
  modalBusy.value = true;
  try {
    await libraryStore.lendBooks({
      bookIds: eligible.map((b) => b.id),
      borrowerName: payload.borrowerName,
      notes: payload.notes
    });
    lendOpen.value = false;
    await loadAuthor();
    uiStore.pushToast(t('loans.lentToast', { name: payload.borrowerName }), 'success');
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
    genreOpen.value = false;
    await loadAuthor();
    uiStore.pushToast(t('batch.genresAppliedToast'), 'success');
  } finally {
    modalBusy.value = false;
  }
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-row">
      <button type="button" class="ds-btn ds-btn--sm" @click="router.back()">
        ← {{ t('app.back') }}
      </button>
    </div>

    <h1>{{ t('series.authorTitle', { name: authorName }) }}</h1>

    <div class="ds-panel">
      <input
        v-model="query"
        type="search"
        class="ds-input"
        :placeholder="t('series.authorSearchPlaceholder')"
      />
    </div>

    <div v-if="loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</div>
    <div v-else-if="seriesList.length === 0 && filteredBooks.length === 0" class="ds-card ds-text-muted">
      {{ t('series.authorEmpty') }}
    </div>

    <template v-else>
      <div v-if="seriesList.length > 0" class="ds-stack">
        <h2>{{ t('series.authorSeriesHeader', { count: seriesList.length }) }}</h2>
        <div class="ds-grid-2">
          <SeriesCard
            v-for="ser in seriesList"
            :key="ser.id"
            :series="ser"
            @open="(id) => router.push(`/series/${encodeURIComponent(id)}`)"
          />
        </div>
      </div>

      <div v-if="filteredBooks.length > 0" class="ds-stack">
        <h2>{{ t('series.authorBooksHeader', { count: filteredBooks.length }) }}</h2>
        <div class="ds-grid-2">
          <BookCard
            v-for="book in filteredBooks"
            :key="book.id"
            :book="book"
            selectable
            :selected="selectedIds.has(book.id)"
            @toggle-select="toggleSelect"
            @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
          />
        </div>
      </div>
    </template>

    <BatchActionBar
      :selected-books="selectedBooks"
      @action="handleBatchAction"
      @open-genres="genreOpen = true"
      @clear="selectedIds = new Set()"
    />

    <ConfirmDeleteModal
      :open="deleteOpen"
      :books="selectedBooks"
      :busy="modalBusy"
      @close="deleteOpen = false"
      @confirm="confirmDelete"
    />

    <LendModal
      :open="lendOpen"
      :book-count="filterEligibleBooksForBatchAction(selectedBooks, 'LEND').length"
      :contacts="libraryStore.contacts"
      :busy="modalBusy"
      @close="lendOpen = false"
      @confirm="confirmLend"
    />

    <BatchGenreModal
      :open="genreOpen"
      :book-count="selectedBooks.length"
      :default-genres="authStore.profile?.defaultGenres ?? []"
      :busy="modalBusy"
      @close="genreOpen = false"
      @confirm="confirmGenres"
      @add-default-genre="(g) => authStore.updateDefaultGenres('add', g)"
    />
  </section>
</template>
