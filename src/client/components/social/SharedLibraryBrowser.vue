<!-- src/client/components/social/SharedLibraryBrowser.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import BaseModal from '../base/BaseModal.vue';
import { useSocialStore, type SharedBookItem, type SharedLibraryData } from '../../stores/social.store';
import { useUiStore } from '../../stores/ui.store';
import { ApiClientError } from '../../api/client';
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
const categoryFilter = ref('');
const searchQuery = ref('');
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

const categories = computed(() => {
  const set = new Set<string>();
  for (const b of props.shared.books) {
    if (b.mainCategory) set.add(b.mainCategory);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
});

const filteredBooks = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return props.shared.books.filter((b) => {
    if (statusFilter.value === 'owned' && b.ownershipStatus !== 'owned') return false;
    if (statusFilter.value === 'wish' && b.ownershipStatus !== 'wish') return false;
    if (statusFilter.value === 'lent' && !b.isLent) return false;
    if (categoryFilter.value && b.mainCategory !== categoryFilter.value) return false;
    if (!q) return true;
    return (
      b.title.toLowerCase().includes(q) ||
      (b.seriesName ?? '').toLowerCase().includes(q) ||
      b.authors.some((a) => a.toLowerCase().includes(q)) ||
      b.genres.some((g) => g.toLowerCase().includes(q))
    );
  });
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
    <div v-if="shared.isOwnLibrary" class="ds-banner ds-banner--info" role="status">
      {{ t('social.ownLibraryPreviewBanner') }}
    </div>

    <div class="ds-card ds-stack">
      <div class="ds-row shared-filters-row">
        <input
          v-model="searchQuery"
          type="search"
          class="ds-input shared-search-input"
          :placeholder="t('social.searchPlaceholder')"
        />

        <select v-model="categoryFilter" class="ds-input shared-category-select">
          <option value="">{{ t('social.allCategories') }}</option>
          <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }}</option>
        </select>
      </div>

      <div class="ds-tabs" role="tablist">
        <button
          type="button"
          class="ds-tab"
          :class="{ 'ds-tab--active': statusFilter === 'all' }"
          @click="statusFilter = 'all'"
        >
          {{ t('social.filterAll', { count: counts.all }) }}
        </button>
        <button
          type="button"
          class="ds-tab"
          :class="{ 'ds-tab--active': statusFilter === 'owned' }"
          @click="statusFilter = 'owned'"
        >
          {{ t('social.filterOwned', { count: counts.owned }) }}
        </button>
        <button
          type="button"
          class="ds-tab"
          :class="{ 'ds-tab--active': statusFilter === 'wish' }"
          @click="statusFilter = 'wish'"
        >
          {{ t('social.filterWish', { count: counts.wish }) }}
        </button>
        <button
          type="button"
          class="ds-tab"
          :class="{ 'ds-tab--active': statusFilter === 'lent' }"
          @click="statusFilter = 'lent'"
        >
          {{ t('social.filterLent', { count: counts.lent }) }}
        </button>
      </div>
    </div>

    <p v-if="filteredBooks.length === 0" class="ds-card ds-text-muted">
      {{ t('social.sharedEmpty') }}
    </p>

    <div v-else class="shared-grid">
      <article v-for="book in filteredBooks" :key="book.id" class="ds-card shared-book-card">
        <div class="shared-book-card__cover">
          <img v-if="book.coverUrl" :src="book.coverUrl" :alt="book.title" loading="lazy" />
          <div v-else class="shared-book-card__placeholder">{{ book.title.slice(0, 2).toUpperCase() }}</div>
        </div>

        <div class="shared-book-card__body ds-stack">
          <div class="ds-row ds-row--between">
            <span
              class="ds-badge"
              :class="book.ownershipStatus === 'owned' ? 'ds-badge--accent' : ''"
            >
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

          <!-- Réservation Cadeau anti-spoiler (strictement absente si isOwnLibrary) -->
          <div v-if="book.ownershipStatus === 'wish' && !shared.isOwnLibrary" class="shared-gift-box">
            <template v-if="shared.canReserveGifts">
              <button
                v-if="book.giftReservation === 'available' || book.giftReservation === null"
                type="button"
                class="ds-btn ds-btn--primary ds-btn--sm"
                :disabled="busyBookId === book.id"
                @click="handleReserve(book)"
              >
                {{ t('social.giftReserveBtn') }}
              </button>

              <div v-else-if="book.giftReservation === 'reserved_by_me'" class="ds-stack">
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

            <!-- Visiteur non connecté : précise qu'il faut être inscrit et connecté -->
            <button
              v-else
              type="button"
              class="ds-btn ds-btn--sm"
              @click="loginPromptOpen = true"
            >
              {{ t('social.giftReserveBtn') }}
            </button>
          </div>
        </div>
      </article>
    </div>

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
.shared-filters-row {
  flex-wrap: wrap;
}

.shared-search-input {
  flex: 1;
  min-width: 220px;
}

.shared-category-select {
  width: auto;
  min-width: 180px;
}

.shared-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-4);
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
  gap: var(--space-2);
}

.shared-book-card__title {
  font-size: 1rem;
  line-height: 1.3;
  margin: 0;
}

.shared-book-card__meta {
  font-size: 0.85rem;
  margin: 0;
}

.shared-gift-box {
  margin-top: var(--space-2);
}
</style>
