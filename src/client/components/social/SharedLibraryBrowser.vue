<!-- src/client/components/social/SharedLibraryBrowser.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Gift } from '@lucide/vue';
import BaseModal from '../base/BaseModal.vue';
import ListControlBar from '../base/ListControlBar.vue';
import PaginationBar from '../base/PaginationBar.vue';
import { useSocialStore, type SharedBookItem, type SharedLibraryData } from '../../stores/social.store';
import { useUiStore } from '../../stores/ui.store';
import { ApiClientError } from '../../api/client';
import {
  createEmptyListFilters,
  type CompositeListFilters,
  type ExtractedFilterFacets
} from '../../../shared/bibliographic/list-filter.util';
import { normalizeSeriesNumber, normalizeTextKey } from '../../../shared/bibliographic/text-normalize.util';
import { t } from '../../../shared/locales';

const props = defineProps<{
  shared: SharedLibraryData;
  token: string;
}>();

const emit = defineEmits<{
  (e: 'updated-reservation', payload: { bookId: string; status: SharedBookItem['giftReservation'] }): void;
}>();

const router = useRouter();
const socialStore = useSocialStore();
const uiStore = useUiStore();

type StatusFilter = 'all' | 'owned' | 'wish' | 'lent';

const statusFilter = ref<StatusFilter>('all');
const filters = ref<CompositeListFilters>(createEmptyListFilters());
const page = ref(1);
const pageSize = ref(20);
const busyBookId = ref<string | null>(null);
const loginPromptOpen = ref(false);

const counts = computed(() => {
  const books = props.shared.books;
  return {
    all: books.length,
    owned: books.filter((b) => b.ownershipStatus === 'owned').length,
    wish: books.filter((b) => b.ownershipStatus === 'wish').length,
    lent: books.filter((b) => b.isLent).length
  };
});

const facets = computed<ExtractedFilterFacets>(() => {
  const genres = new Set<string>();
  const authors = new Set<string>();
  const seriesNames = new Set<string>();
  for (const b of props.shared.books) {
    if (b.mainCategory) genres.add(b.mainCategory);
    for (const g of b.genres) genres.add(g);
    for (const a of b.authors) authors.add(a);
    if (b.seriesName) seriesNames.add(b.seriesName);
  }
  return {
    genres: Array.from(genres).sort((a, b) => a.localeCompare(b, 'fr')),
    authors: Array.from(authors).sort((a, b) => a.localeCompare(b, 'fr')),
    publishers: [],
    seriesNames: Array.from(seriesNames).sort((a, b) => a.localeCompare(b, 'fr'))
  };
});

const filteredBooks = computed(() => {
  const qNorm = normalizeTextKey(filters.value.query);
  const gNorm = normalizeTextKey(filters.value.genre);
  const aNorm = normalizeTextKey(filters.value.author);
  const sNorm = normalizeTextKey(filters.value.series);
  const vNorm = normalizeSeriesNumber(filters.value.volumeNumber);

  return props.shared.books.filter((b) => {
    if (statusFilter.value === 'owned' && b.ownershipStatus !== 'owned') return false;
    if (statusFilter.value === 'wish' && b.ownershipStatus !== 'wish') return false;
    if (statusFilter.value === 'lent' && !b.isLent) return false;

    if (gNorm) {
      const hasGenre =
        normalizeTextKey(b.mainCategory) === gNorm || b.genres.some((g) => normalizeTextKey(g) === gNorm);
      if (!hasGenre) return false;
    }
    if (aNorm && !b.authors.some((a) => normalizeTextKey(a).includes(aNorm))) return false;
    if (sNorm && !normalizeTextKey(b.seriesName ?? '').includes(sNorm)) return false;
    if (vNorm && normalizeSeriesNumber(b.volumeLabel) !== vNorm) return false;

    if (!qNorm) return true;
    const hay = normalizeTextKey([b.title, b.seriesName ?? '', ...b.authors, b.mainCategory, ...b.genres].join(' '));
    return hay.includes(qNorm);
  });
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredBooks.value.length / pageSize.value)));

watch([statusFilter, filters, pageSize], () => {
  page.value = 1;
}, { deep: true });

const paginatedBooks = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return filteredBooks.value.slice(start, start + pageSize.value);
});

async function handleReserve(book: SharedBookItem): Promise<void> {
  if (!props.shared.canReserveGifts) {
    loginPromptOpen.value = true;
    return;
  }
  busyBookId.value = book.id;
  try {
    const status = await socialStore.reserveGift(props.token, book.id);
    emit('updated-reservation', { bookId: book.id, status });
    uiStore.pushToast(t('social.giftReservedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    busyBookId.value = null;
  }
}

async function handleCancelReserve(book: SharedBookItem): Promise<void> {
  busyBookId.value = book.id;
  try {
    const status = await socialStore.cancelGiftReservation(props.token, book.id);
    emit('updated-reservation', { bookId: book.id, status });
    uiStore.pushToast(t('social.giftCanceledToast'), 'info');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    busyBookId.value = null;
  }
}

function goLoginToReserve(): void {
  loginPromptOpen.value = false;
  void router.push({
    path: '/login',
    query: { friend: props.token, redirect: `/shared/${props.token}` }
  });
}
</script>

<template>
  <div class="ds-stack">
    <div v-if="shared.isOwnLibrary" class="ds-banner ds-banner--warning" role="status">
      {{ t('social.ownLibraryPreviewBanner') }}
    </div>

    <div class="ds-segmented shared-segmented" role="tablist">
      <button
        type="button"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': statusFilter === 'all' }"
        @click="statusFilter = 'all'"
      >
        {{ t('social.filterAll', { count: counts.all }) }}
      </button>
      <button
        type="button"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': statusFilter === 'owned' }"
        @click="statusFilter = 'owned'"
      >
        {{ t('social.filterOwned', { count: counts.owned }) }}
      </button>
      <button
        type="button"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': statusFilter === 'wish' }"
        @click="statusFilter = 'wish'"
      >
        {{ t('social.filterWish', { count: counts.wish }) }}
      </button>
      <button
        type="button"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': statusFilter === 'lent' }"
        @click="statusFilter = 'lent'"
      >
        {{ t('social.filterLent', { count: counts.lent }) }}
      </button>
    </div>

    <ListControlBar
      :filters="filters"
      :facets="facets"
      :enabled-facets="['genre', 'author', 'series', 'volumeNumber']"
      :placeholder="t('social.searchPlaceholder')"
      @update:filters="(next) => (filters = next)"
    />

    <p v-if="filteredBooks.length === 0" class="ds-card ds-text-muted">
      {{ t('social.sharedEmpty') }}
    </p>

    <div v-else class="shared-grid">
      <article v-for="book in paginatedBooks" :key="book.id" class="ds-card shared-book-card">
        <div class="shared-book-card__cover">
          <img v-if="book.coverUrl" :src="book.coverUrl" :alt="book.title" loading="lazy" />
          <div v-else class="shared-book-card__placeholder">{{ book.title.slice(0, 2).toUpperCase() }}</div>
        </div>

        <div class="shared-book-card__body ds-stack--sm">
          <div class="ds-row ds-row--between">
            <span class="ds-badge" :class="book.ownershipStatus === 'owned' ? 'ds-badge--accent' : ''">
              {{ book.ownershipStatus === 'owned' ? t('book.statusOwned') : t('book.statusWished') }}
            </span>

            <span v-if="book.ownershipStatus === 'owned'" class="ds-badge">
              {{ book.isLent ? t('social.sharedStatusLent') : t('social.sharedStatusAvailable') }}
            </span>
          </div>

          <h3 class="shared-book-card__title">{{ book.title }}</h3>

          <p v-if="book.seriesName" class="ds-text-muted shared-book-card__meta">
            {{ book.seriesName }}
            <span v-if="book.volumeLabel"> · T.{{ book.volumeLabel }}</span>
          </p>

          <p class="ds-text-muted shared-book-card__meta">
            {{ book.authors.length > 0 ? book.authors.join(', ') : t('app.unknownAuthor') }}
          </p>

          <!-- Réservation Cadeau anti-spoiler -->
          <div v-if="book.ownershipStatus === 'wish' && !shared.isOwnLibrary" class="shared-gift-box">
            <template v-if="shared.canReserveGifts">
              <button
                v-if="book.giftReservation === 'available' || book.giftReservation === null"
                type="button"
                class="ds-btn ds-btn--primary ds-btn--sm"
                :disabled="busyBookId === book.id"
                @click="handleReserve(book)"
              >
                <Gift :size="15" aria-hidden="true" />
                <span>{{ t('social.giftReserveBtn') }}</span>
              </button>

              <div v-else-if="book.giftReservation === 'reserved_by_me'" class="ds-stack--sm">
                <span class="ds-badge ds-badge--accent">{{ t('social.giftReservedByMe') }}</span>
                <button
                  type="button"
                  class="ds-btn ds-btn--sm"
                  :disabled="busyBookId === book.id"
                  @click="handleCancelReserve(book)"
                >
                  {{ t('social.giftCancelReserveBtn') }}
                </button>
              </div>

              <span v-else class="ds-badge">
                {{ t('social.giftReservedByOther') }}
              </span>
            </template>

            <button
              v-else
              type="button"
              class="ds-btn ds-btn--sm"
              @click="loginPromptOpen = true"
            >
              <Gift :size="15" aria-hidden="true" />
              <span>{{ t('social.giftReserveBtn') }}</span>
            </button>
          </div>
        </div>
      </article>
    </div>

    <PaginationBar
      :page="page"
      :total-pages="totalPages"
      :page-size="pageSize"
      :total-items="filteredBooks.length"
      @update:page="(p) => (page = p)"
      @update:page-size="(s) => (pageSize = s)"
    />

    <BaseModal
      :open="loginPromptOpen"
      :title="t('social.giftLoginRequiredTitle')"
      @close="loginPromptOpen = false"
    >
      <p>{{ t('social.giftLoginRequired') }}</p>
      <template #footer>
        <button type="button" class="ds-btn" @click="loginPromptOpen = false">
          {{ t('app.close') }}
        </button>
        <button type="button" class="ds-btn ds-btn--primary" @click="goLoginToReserve">
          {{ t('social.loginToReserveBtn') }}
        </button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.shared-segmented {
  overflow-x: auto;
}

.shared-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
  gap: var(--space-3);
}

.shared-book-card {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}

.shared-book-card__cover {
  width: 72px;
  min-width: 72px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

.shared-book-card__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.shared-book-card__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: var(--text-muted);
}

.shared-book-card__body {
  flex: 1;
  min-width: 0;
}

.shared-book-card__title {
  font-size: 0.96rem;
  line-height: 1.3;
  margin: 0;
}

.shared-book-card__meta {
  font-size: 0.84rem;
  margin: 0;
}

.shared-gift-box {
  margin-top: var(--space-1);
}
</style>
