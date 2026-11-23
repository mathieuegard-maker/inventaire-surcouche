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
import { apiRequest, ApiClientError } from '../api/client';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type { BookView, SeriesView } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

interface AuthorExternalSeriesHit {
  seriesName: string;
  normalizedKey: string;
  sampleIsbn13: string;
  volumesCount: number;
  sampleTitles: string[];
  coverUrl: string | null;
  source: string;
}

interface AuthorExternalBookHit {
  isbn13: string;
  title: string;
  authors: string[];
  publisher: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  source: string;
}

const route = useRoute();
const router = useRouter();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();

const loading = ref(true);
const importingIsbn = ref<string | null>(null);
const authorName = ref('');
const seriesList = ref<SeriesView[]>([]);
const books = ref<BookView[]>([]);
const externalSeries = ref<AuthorExternalSeriesHit[]>([]);
const externalBooks = ref<AuthorExternalBookHit[]>([]);
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
    const res = await apiRequest<{
      ok: true;
      authorName: string;
      series: SeriesView[];
      books: BookView[];
      externalSeries?: AuthorExternalSeriesHit[];
      externalBooks?: AuthorExternalBookHit[];
    }>(`/api/authors/${encodeURIComponent(raw)}`, { timeoutMs: 30000 });
    authorName.value = res.authorName;
    seriesList.value = res.series;
    books.value = res.books;
    externalSeries.value = res.externalSeries ?? [];
    externalBooks.value = res.externalBooks ?? [];
  } finally {
    loading.value = false;
  }
}

watch(() => route.params.name, () => {
  void loadAuthor();
}, { immediate: true });

const needle = computed(() => normalizeTextKey(query.value));

function matchesSeriesFilter(name: string, extra = ''): boolean {
  if (!needle.value) return true;
  return normalizeTextKey(`${name} ${extra}`).includes(needle.value);
}

function matchesBookFilter(b: BookView): boolean {
  if (!needle.value) return true;
  return normalizeTextKey([b.title, b.seriesName ?? '', ...b.genres].join(' ')).includes(needle.value);
}

// Séries qui contiennent au moins 1 livre possédé ou en wishlist dans le foyer
const wishedSeriesIds = computed(() => {
  const set = new Set<string>();
  for (const b of books.value) {
    if (b.seriesId && (b.ownershipStatus === 'owned' || b.ownershipStatus === 'wish')) {
      set.add(b.seriesId);
    }
  }
  return set;
});

// 1. Dans votre bibliothèque : d'abord vos séries, puis vos œuvres indépendantes
const ownedSeries = computed(() =>
  seriesList.value.filter(
    (s) => (s.ownedCount > 0 || wishedSeriesIds.value.has(s.id)) && matchesSeriesFilter(s.canonicalName)
  )
);

const ownedStandaloneBooks = computed(() =>
  books.value.filter(
    (b) => !b.seriesId && (b.ownershipStatus === 'owned' || b.ownershipStatus === 'wish') && matchesBookFilter(b)
  )
);

const hasOwnedSection = computed(() => ownedSeries.value.length > 0 || ownedStandaloneBooks.value.length > 0);

// 2. Autres œuvres de cet auteur : d'abord les séries (locales non possédées + externes), puis les œuvres indépendantes
const otherLocalSeries = computed(() =>
  seriesList.value.filter(
    (s) => s.ownedCount === 0 && !wishedSeriesIds.value.has(s.id) && matchesSeriesFilter(s.canonicalName)
  )
);

const filteredExternalSeries = computed(() =>
  externalSeries.value.filter((s) => matchesSeriesFilter(s.seriesName, s.sampleTitles.join(' ')))
);

const otherLocalStandaloneBooks = computed(() =>
  books.value.filter((b) => !b.seriesId && b.ownershipStatus === 'none' && matchesBookFilter(b))
);

const filteredExternalBooks = computed(() =>
  externalBooks.value.filter((b) =>
    !needle.value || normalizeTextKey(`${b.title} ${b.publisher ?? ''}`).includes(needle.value)
  )
);

const totalOtherSeriesCount = computed(() => otherLocalSeries.value.length + filteredExternalSeries.value.length);
const totalOtherStandaloneCount = computed(
  () => otherLocalStandaloneBooks.value.length + filteredExternalBooks.value.length
);
const hasOtherSection = computed(() => totalOtherSeriesCount.value > 0 || totalOtherStandaloneCount.value > 0);

const selectedBooks = computed(() =>
  books.value.filter((b) => selectedIds.value.has(b.id))
);

function toggleSelect(bookId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedIds.value = next;
}

async function importExternalIsbn(isbn13: string, openSeriesIfAvailable: boolean): Promise<void> {
  importingIsbn.value = isbn13;
  try {
    const res = await apiRequest<{
      ok: true;
      results: Array<{ found: boolean; book: BookView | null }>;
    }>('/api/books/resolve-isbn', {
      method: 'POST',
      body: { isbns: [isbn13], channel: 'text_search', action: 'preview' },
      timeoutMs: 45000
    });
    const book = res.results[0]?.book;
    if (book) {
      if (openSeriesIfAvailable && book.seriesId) {
        await router.push(`/series/${encodeURIComponent(book.seriesId)}`);
      } else {
        await router.push(`/book/${encodeURIComponent(book.id)}`);
      }
    } else {
      uiStore.pushToast(t('book.notFound'), 'warning');
    }
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    importingIsbn.value = null;
  }
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
    <div v-else-if="!hasOwnedSection && !hasOtherSection" class="ds-card ds-text-muted">
      {{ t('series.authorEmpty') }}
    </div>

    <template v-else>
      <!-- 1. En priorité : ce que l'utilisateur possède / souhaite déjà -->
      <div v-if="hasOwnedSection" class="ds-stack">
        <h2>{{ t('series.authorOwnedSection') }}</h2>

        <div v-if="ownedSeries.length > 0" class="ds-stack">
          <h3>{{ t('series.authorOwnedSeriesHeader', { count: ownedSeries.length }) }}</h3>
          <div class="ds-grid-2">
            <SeriesCard
              v-for="ser in ownedSeries"
              :key="ser.id"
              :series="ser"
              @open="(id) => router.push(`/series/${encodeURIComponent(id)}`)"
            />
          </div>
        </div>

        <div v-if="ownedStandaloneBooks.length > 0" class="ds-stack">
          <h3>{{ t('series.authorOwnedStandaloneHeader', { count: ownedStandaloneBooks.length }) }}</h3>
          <div class="ds-grid-2">
            <BookCard
              v-for="book in ownedStandaloneBooks"
              :key="book.id"
              :book="book"
              selectable
              :selected="selectedIds.has(book.id)"
              @toggle-select="toggleSelect"
              @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
            />
          </div>
        </div>
      </div>

      <!-- 2. Ensuite : autres œuvres de cet auteur (séries d'abord, puis œuvres indépendantes) -->
      <div v-if="hasOtherSection" class="ds-stack">
        <h2>{{ t('series.authorOtherSection') }}</h2>

        <div v-if="totalOtherSeriesCount > 0" class="ds-stack">
          <h3>{{ t('series.authorOtherSeriesHeader', { count: totalOtherSeriesCount }) }}</h3>
          <div v-if="otherLocalSeries.length > 0" class="ds-grid-2">
            <SeriesCard
              v-for="ser in otherLocalSeries"
              :key="ser.id"
              :series="ser"
              @open="(id) => router.push(`/series/${encodeURIComponent(id)}`)"
            />
          </div>
          <div v-if="filteredExternalSeries.length > 0" class="ds-grid-2">
            <article
              v-for="extSer in filteredExternalSeries"
              :key="extSer.normalizedKey"
              class="ds-card author-ext-card"
            >
              <div class="ds-stack">
                <strong>{{ extSer.seriesName }}</strong>
                <span class="ds-text-muted">
                  {{ t('series.authorExternalSeriesVolumes', { count: extSer.volumesCount }) }}
                </span>
                <span v-if="extSer.sampleTitles.length > 0" class="ds-text-muted">
                  {{ extSer.sampleTitles.join(' · ') }}
                </span>
              </div>
              <button
                type="button"
                class="ds-btn ds-btn--sm ds-btn--primary"
                :disabled="importingIsbn === extSer.sampleIsbn13"
                @click="importExternalIsbn(extSer.sampleIsbn13, true)"
              >
                {{ importingIsbn === extSer.sampleIsbn13 ? t('app.loading') : t('series.authorImportBtn') }}
              </button>
            </article>
          </div>
        </div>

        <div v-if="totalOtherStandaloneCount > 0" class="ds-stack">
          <h3>{{ t('series.authorOtherStandaloneHeader', { count: totalOtherStandaloneCount }) }}</h3>
          <div v-if="otherLocalStandaloneBooks.length > 0" class="ds-grid-2">
            <BookCard
              v-for="book in otherLocalStandaloneBooks"
              :key="book.id"
              :book="book"
              selectable
              :selected="selectedIds.has(book.id)"
              @toggle-select="toggleSelect"
              @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
            />
          </div>
          <div v-if="filteredExternalBooks.length > 0" class="ds-grid-2">
            <article
              v-for="extBook in filteredExternalBooks"
              :key="extBook.isbn13"
              class="ds-card author-ext-card"
            >
              <div class="ds-stack">
                <strong>{{ extBook.title }}</strong>
                <span class="ds-text-muted">
                  {{ [extBook.publisher, extBook.publishYear].filter(Boolean).join(' · ') || extBook.isbn13 }}
                </span>
              </div>
              <button
                type="button"
                class="ds-btn ds-btn--sm"
                :disabled="importingIsbn === extBook.isbn13"
                @click="importExternalIsbn(extBook.isbn13, false)"
              >
                {{ importingIsbn === extBook.isbn13 ? t('app.loading') : t('series.authorImportBtn') }}
              </button>
            </article>
          </div>
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

<style scoped>
.author-ext-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
</style>
