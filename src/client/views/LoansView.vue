<!-- src/client/views/LoansView.vue -->
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

const state = libraryStore.loansState;
const collapsedBorrowers = ref<Set<string>>(new Set());
const selectedIds = ref<Set<string>>(new Set());
const deleteModalOpen = ref(false);
const genreModalOpen = ref(false);
const modalBusy = ref(false);

const filteredLentBooks = computed(() => {
  const needle = normalizeTextKey(state.query);
  const list = libraryStore.lentBooks.filter((b) => {
    if (!needle) return true;
    const hay = normalizeTextKey(
      [b.title, b.seriesName ?? '', b.activeLoan?.borrowerName ?? '', ...b.authors].join(' ')
    );
    return hay.includes(needle);
  });

  return [...list].sort((a, b) =>
    (b.activeLoan?.loanedAt ?? '').localeCompare(a.activeLoan?.loanedAt ?? '')
  );
});

const borrowerGroups = computed(() => {
  const map = new Map<string, BookView[]>();
  for (const book of filteredLentBooks.value) {
    const borrower = book.activeLoan?.borrowerName ?? '';
    if (!borrower) continue;
    const list = map.get(borrower) ?? [];
    list.push(book);
    map.set(borrower, list);
  }
  return Array.from(map.entries())
    .map(([borrower, books]) => ({ borrower, books }))
    .sort((a, b) => a.borrower.localeCompare(b.borrower, 'fr'));
});

const selectedBooks = computed(() =>
  filteredLentBooks.value.filter((b) => selectedIds.value.has(b.id))
);

function toggleBorrower(name: string): void {
  const next = new Set(collapsedBorrowers.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  collapsedBorrowers.value = next;
}

function toggleSelect(bookId: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedIds.value = next;
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('fr-FR');
  } catch {
    return iso.slice(0, 10);
  }
}

async function handleReturnSingle(bookId: string): Promise<void> {
  const res = await libraryStore.returnBooks([bookId]);
  uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('loans.returnedToast'), 'success');
}

async function handleBatchAction(action: BatchActionType): Promise<void> {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, action);
  if (eligible.length === 0) return;

  if (action === 'DELETE') {
    deleteModalOpen.value = true;
    return;
  }
  if (action === 'RETURN') {
    const res = await libraryStore.returnBooks(eligible.map((b) => b.id));
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('loans.returnedToast'), 'success');
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
      <h1>{{ t('loans.title') }}</h1>
      <span class="ds-badge">{{ t('collection.booksCount', { count: filteredLentBooks.length }) }}</span>
    </div>

    <div class="ds-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': state.mode === 'borrower' }"
        @click="state.mode = 'borrower'"
      >
        {{ t('loans.modeBorrower') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': state.mode === 'chrono' }"
        @click="state.mode = 'chrono'"
      >
        {{ t('loans.modeChrono') }}
      </button>
    </div>

    <div class="ds-panel">
      <input
        v-model="state.query"
        type="search"
        class="ds-input"
        :placeholder="t('loans.searchPlaceholder')"
      />
    </div>

    <p v-if="filteredLentBooks.length === 0" class="ds-card ds-text-muted">
      {{ t('loans.empty') }}
    </p>

    <!-- Mode Par Emprunteur (accordéons dépliables/repliables) -->
    <div v-else-if="state.mode === 'borrower'" class="ds-stack">
      <div v-for="grp in borrowerGroups" :key="grp.borrower" class="ds-card ds-stack">
        <button
          type="button"
          class="loan-accordion-header"
          :aria-expanded="!collapsedBorrowers.has(grp.borrower)"
          @click="toggleBorrower(grp.borrower)"
        >
          <span class="loan-accordion-header__title">{{ grp.borrower }}</span>
          <span class="ds-badge">
            {{ t('loans.borrowerBooksCount', { count: grp.books.length }) }}
          </span>
        </button>

        <div v-if="!collapsedBorrowers.has(grp.borrower)" class="ds-grid-2">
          <BookCard
            v-for="book in grp.books"
            :key="book.id"
            :book="book"
            selectable
            :selected="selectedIds.has(book.id)"
            @toggle-select="toggleSelect"
            @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
          >
            <template #actions>
              <span v-if="book.activeLoan" class="ds-text-muted">
                {{ t('loans.lentSince', { date: formatDate(book.activeLoan.loanedAt) }) }}
              </span>
              <button type="button" class="ds-btn ds-btn--sm" @click="handleReturnSingle(book.id)">
                {{ t('loans.returnBook') }}
              </button>
            </template>
          </BookCard>
        </div>
      </div>
    </div>

    <!-- Mode Chronologique -->
    <div v-else class="ds-grid-2">
      <BookCard
        v-for="book in filteredLentBooks"
        :key="book.id"
        :book="book"
        selectable
        :selected="selectedIds.has(book.id)"
        @toggle-select="toggleSelect"
        @open="(id) => router.push(`/book/${encodeURIComponent(id)}`)"
      >
        <template #actions>
          <span v-if="book.activeLoan" class="ds-text-muted">
            {{ t('loans.lentSince', { date: formatDate(book.activeLoan.loanedAt) }) }}
          </span>
          <button type="button" class="ds-btn ds-btn--sm" @click="handleReturnSingle(book.id)">
            {{ t('loans.returnBook') }}
          </button>
        </template>
      </BookCard>
    </div>

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
.loan-accordion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  color: var(--text-primary);
  text-align: left;
}

.loan-accordion-header__title {
  font-size: 1.05rem;
  font-weight: 700;
}
</style>
