<!-- src/client/views/WishlistView.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BookCard from '../components/books/BookCard.vue';
import BatchActionBar from '../components/books/BatchActionBar.vue';
import ConfirmDeleteModal from '../components/modals/ConfirmDeleteModal.vue';
import BatchGenreModal from '../components/modals/BatchGenreModal.vue';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { filterEligibleBooksForBatchAction, type BatchActionType } from '../../shared/bibliographic/batch-actions.util';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
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

const availableGenres = computed(() => {
  const set = new Set<string>();
  for (const b of libraryStore.wishedBooks) {
    for (const g of b.genres) set.add(g);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
});

const availableAuthors = computed(() => {
  const set = new Set<string>();
  for (const b of libraryStore.wishedBooks) {
    for (const a of b.authors) set.add(a);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
});

const filteredWished = computed(() => {
  const needle = normalizeTextKey(state.query);
  return libraryStore.wishedBooks.filter((b) => {
    if (state.genre && !b.genres.includes(state.genre)) return false;
    if (state.author && !b.authors.includes(state.author)) return false;
    if (needle) {
      const hay = normalizeTextKey([b.title, b.seriesName ?? '', ...b.authors, ...b.genres].join(' '));
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
});

// Regroupement Séries puis Livres indépendants
const seriesGroups = computed(() => {
  const map = new Map<string, { seriesName: string; books: BookView[] }>();
  for (const b of filteredWished.value) {
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
  filteredWished.value.filter((b) => !b.seriesId && !b.seriesName)
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

onMounted(() => {
  if (state.scrollY > 0) window.scrollTo({ top: state.scrollY, behavior: 'auto' });
});

onBeforeUnmount(() => {
  state.scrollY = window.scrollY;
});
</script>

<template>
  <section class="ds-stack">
    <div class="ds-row ds-row--between">
      <h1>{{ t('wishlist.title') }}</h1>
      <span class="ds-badge">{{ t('collection.booksCount', { count: filteredWished.length }) }}</span>
    </div>

    <div class="ds-panel ds-row">
      <input
        v-model="state.query"
        type="search"
        class="ds-input wish-search-input"
        :placeholder="t('wishlist.searchPlaceholder')"
      />
      <select v-model="state.genre" class="ds-input wish-select" :aria-label="t('wishlist.allGenres')">
        <option value="">{{ t('wishlist.allGenres') }}</option>
        <option v-for="g in availableGenres" :key="g" :value="g">{{ g }}</option>
      </select>
      <select v-model="state.author" class="ds-input wish-select" :aria-label="t('wishlist.allAuthors')">
        <option value="">{{ t('wishlist.allAuthors') }}</option>
        <option v-for="a in availableAuthors" :key="a" :value="a">{{ a }}</option>
      </select>
    </div>

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
              @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
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
            @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
          />
        </div>
      </div>
    </template>

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

<style scoped>
.wish-search-input {
  flex: 1;
  min-width: 200px;
}

.wish-select {
  width: auto;
  min-width: 170px;
}
</style>
