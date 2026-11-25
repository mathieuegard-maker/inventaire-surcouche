<!-- src/client/views/BookDetailView.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseModal from '../components/base/BaseModal.vue';
import BookActions from '../components/books/BookActions.vue';
import IntegralFields from '../components/books/IntegralFields.vue';
import SeriesAttachModal from '../components/modals/SeriesAttachModal.vue';
import { useLibraryStore, type BookSeriesContext } from '../stores/library.store';
import { useUiStore } from '../stores/ui.store';
import { apiRequest, ApiClientError } from '../api/client';
import { formatIntegralRangeLabel } from '../../shared/bibliographic/integral.util';
import type { BookView, ReadingStatus } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

const route = useRoute();
const router = useRouter();
const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const loading = ref(true);
const book = ref<BookView | null>(null);
const seriesContext = ref<BookSeriesContext | null>(null);

// Bloc Lecture individuelle (strictement user_id)
const readingStatus = ref<ReadingStatus>('none');
const readingRating = ref(0);
const readingNotes = ref('');
const savingReading = ref(false);

// Modale Intégrale rapide
const integralModalOpen = ref(false);
const draftIsIntegral = ref(false);
const draftIncludedVolumes = ref<string[]>([]);
const integralModalMode = ref<'create_separate' | 'convert_self'>('create_separate');
const savingOverrides = ref(false);

// Modale confirmation Réinitialiser Couche 3 & Rattachement série
const resetModalOpen = ref(false);
const attachModalOpen = ref(false);

const readingOptions = computed<Array<{ value: ReadingStatus; label: string }>>(() => [
  { value: 'none', label: t('book.readingNone') },
  { value: 'to_read', label: t('book.readingToRead') },
  { value: 'reading', label: t('book.readingInProgress') },
  { value: 'read', label: t('book.readingRead') },
  { value: 'abandoned', label: t('book.readingAbandoned') }
]);

function syncReadingForm(b: BookView | null): void {
  readingStatus.value = b?.readingState?.status ?? 'none';
  readingRating.value = b?.readingState?.rating ?? 0;
  readingNotes.value = b?.readingState?.notes ?? '';
}

async function loadBook(): Promise<void> {
  const rawId = typeof route.params.bookId === 'string' ? route.params.bookId : '';
  if (!rawId) return;
  loading.value = true;
  try {
    const res = await libraryStore.fetchBookDetail(rawId);
    book.value = res?.book ?? null;
    seriesContext.value = res?.seriesContext ?? null;
    syncReadingForm(book.value);
  } finally {
    loading.value = false;
  }
}

watch(() => route.params.bookId, () => {
  void loadBook();
}, { immediate: true });

async function handleSaveReading(): Promise<void> {
  if (!book.value) return;
  savingReading.value = true;
  try {
    const res = await libraryStore.saveReadingState(book.value.id, {
      status: readingStatus.value,
      rating: readingRating.value,
      notes: readingNotes.value
    });
    book.value = { ...book.value, readingState: res.readingState };
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('book.readingSavedToast'), 'success');
  } finally {
    savingReading.value = false;
  }
}

function openIntegralModal(): void {
  if (!book.value) return;
  if (!book.value.isIntegral && book.value.seriesId) {
    // Par défaut sur un tome unitaire d'une série : créer/associer une œuvre Intégrale distincte SANS écraser ce tome !
    integralModalMode.value = 'create_separate';
    draftIsIntegral.value = true;
    draftIncludedVolumes.value =
      book.value.volumeNumber !== null ? [String(book.value.volumeNumber)] : [];
  } else {
    integralModalMode.value = 'convert_self';
    draftIsIntegral.value = book.value.isIntegral;
    draftIncludedVolumes.value = [...book.value.includedVolumes];
  }
  integralModalOpen.value = true;
}

async function saveIntegralModal(): Promise<void> {
  if (!book.value) return;
  savingOverrides.value = true;
  try {
    if (!book.value.isIntegral && book.value.seriesId && integralModalMode.value === 'create_separate') {
      if (draftIncludedVolumes.value.length === 0) {
        uiStore.pushToast(t('book.integralVolumesRequiredError'), 'warning');
        return;
      }
      await apiRequest(`/api/series/${encodeURIComponent(book.value.seriesId)}/integrals`, {
        method: 'POST',
        body: {
          includedVolumes: draftIncludedVolumes.value,
          sourceBookId: book.value.id,
          ownershipStatus: 'owned'
        }
      });
      integralModalOpen.value = false;
      await libraryStore.syncNow();
      await loadBook();
      uiStore.pushToast(t('book.integralSeparateCreatedToast'), 'success');
      return;
    }

    book.value = await libraryStore.saveBookOverrides(book.value.id, {
      isIntegral: draftIsIntegral.value,
      includedVolumes: draftIsIntegral.value ? draftIncludedVolumes.value : []
    });
    integralModalOpen.value = false;
    uiStore.pushToast(t('book.overridesSavedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    savingOverrides.value = false;
  }
}

async function handleExcludeFromSeries(): Promise<void> {
  if (!book.value || !book.value.seriesId) return;
  savingOverrides.value = true;
  try {
    const nextHidden = Array.from(new Set([...book.value.hiddenSeriesIds, book.value.seriesId]));
    book.value = await libraryStore.saveBookOverrides(book.value.id, {
      hiddenSeriesIds: nextHidden,
      oneShotForced: true
    });
    seriesContext.value = null;
    uiStore.pushToast(t('book.excludedFromSeriesToast'), 'info');
  } finally {
    savingOverrides.value = false;
  }
}

async function confirmResetOverrides(): Promise<void> {
  if (!book.value) return;
  savingOverrides.value = true;
  try {
    book.value = await libraryStore.resetBookOverrides(book.value.id);
    resetModalOpen.value = false;
    await loadBook();
    uiStore.pushToast(t('book.resetOverridesDone'), 'success');
  } finally {
    savingOverrides.value = false;
  }
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-row ds-row--between">
      <button type="button" class="ds-btn ds-btn--sm" @click="router.back()">
        ← {{ t('app.back') }}
      </button>

      <div v-if="seriesContext" class="ds-row">
        <button
          type="button"
          class="ds-btn ds-btn--sm"
          :disabled="!seriesContext.prevBookId"
          :aria-label="t('book.prevBook')"
          @click="seriesContext.prevBookId && router.push(`/book/${encodeURIComponent(seriesContext.prevBookId)}`)"
        >
          ‹ {{ t('book.prevBook') }}
        </button>
        <button
          type="button"
          class="ds-btn ds-btn--sm"
          :disabled="!seriesContext.nextBookId"
          :aria-label="t('book.nextBook')"
          @click="seriesContext.nextBookId && router.push(`/book/${encodeURIComponent(seriesContext.nextBookId)}`)"
        >
          {{ t('book.nextBook') }} ›
        </button>
      </div>
    </div>

    <div v-if="loading" class="ds-card ds-text-muted">
      {{ t('app.loading') }}
    </div>

    <div v-else-if="!book" class="ds-card ds-text-muted">
      {{ t('book.notFound') }}
    </div>

    <template v-else>
      <article class="ds-card book-hero">
        <div class="book-hero__cover">
          <img v-if="book.coverUrl" :src="book.coverUrl" :alt="book.title" />
          <div v-else class="book-hero__placeholder">
            {{ book.title.slice(0, 2).toUpperCase() }}
          </div>
        </div>

        <div class="book-hero__info ds-stack">
          <div class="ds-row">
            <span v-if="book.activeLoan" class="detail-badge detail-badge--lent">
              {{ t('loans.lentTo', { name: book.activeLoan.borrowerName }) }}
            </span>
            <span v-else-if="book.ownershipStatus === 'owned'" class="detail-badge detail-badge--owned">
              {{ t('book.statusOwned') }}
            </span>
            <span v-else-if="book.ownershipStatus === 'wish'" class="detail-badge detail-badge--wish">
              {{ t('book.statusWished') }}
              <template v-if="book.wishedByName"> · {{ t('wishlist.wishedBy', { name: book.wishedByName }) }}</template>
            </span>
            <span v-else-if="book.ownedViaIntegral" class="detail-badge detail-badge--integral">
              {{ t('book.includedIn', { title: book.ownedViaIntegral.title }) }}
            </span>
            <span v-else class="ds-badge">{{ t('book.statusUnowned') }}</span>

            <span v-if="book.isIntegral" class="detail-badge detail-badge--integral">
              {{ formatIntegralRangeLabel(book.includedVolumes, book.volumeLabel ?? undefined) }}
            </span>
            <span v-else-if="book.volumeLabel" class="ds-badge">T.{{ book.volumeLabel }}</span>

            <span v-if="book.hasUserOverrides" class="ds-badge ds-badge--accent">
              {{ t('book.overridesActiveBadge') }}
            </span>
          </div>

          <h1>{{ book.title }}</h1>

          <div v-if="book.seriesName && book.seriesId" class="ds-row">
            <router-link :to="`/series/${encodeURIComponent(book.seriesId)}`" class="book-hero__series-link">
              {{ book.seriesName }}
              <span v-if="seriesContext">
                ({{ t('book.seeWholeSeries', { count: seriesContext.totalVolumes }) }})
              </span>
            </router-link>
          </div>

          <div v-if="book.authors.length > 0" class="ds-row">
            <router-link
              v-for="author in book.authors"
              :key="author"
              :to="`/author/${encodeURIComponent(author)}`"
              class="ds-chip"
            >
              {{ author }}
            </router-link>
          </div>

          <div v-if="book.scriptwriters.length > 0 || book.illustrators.length > 0" class="ds-text-muted">
            <span v-if="book.scriptwriters.length > 0">
              {{ t('book.scriptwritersLabel') }} : {{ book.scriptwriters.join(', ') }}
            </span>
            <span v-if="book.scriptwriters.length > 0 && book.illustrators.length > 0"> · </span>
            <span v-if="book.illustrators.length > 0">
              {{ t('book.illustratorsLabel') }} : {{ book.illustrators.join(', ') }}
            </span>
          </div>

          <p class="ds-text-muted">
            <span v-if="book.publisher">{{ book.publisher }}</span>
            <span v-if="book.publishYear"> · {{ book.publishYear }}</span>
            <span v-if="book.pageCount"> · {{ book.pageCount }} p.</span>
            <span v-if="book.collectionName"> · {{ book.collectionName }}</span>
          </p>

          <div v-if="book.genres.length > 0" class="ds-chips">
            <span v-for="genre in book.genres" :key="genre" class="ds-badge">{{ genre }}</span>
          </div>

          <BookActions :book="book" @updated="loadBook" />

          <div class="ds-row">
            <router-link :to="`/book/${encodeURIComponent(book.id)}/edit`" class="ds-btn ds-btn--sm">
              {{ t('book.editBtn') }}
            </router-link>
            <button type="button" class="ds-btn ds-btn--sm" @click="attachModalOpen = true">
              {{ t('book.attachSeriesBtn') }}
            </button>
            <button type="button" class="ds-btn ds-btn--sm" @click="openIntegralModal">
              {{ book.isIntegral ? t('book.editIntegralBtn') : t('book.integralBtn') }}
            </button>
            <button
              v-if="book.seriesId"
              type="button"
              class="ds-btn ds-btn--sm"
              :disabled="savingOverrides"
              @click="handleExcludeFromSeries"
            >
              {{ t('book.excludeFromSeriesBtn') }}
            </button>
            <button
              v-if="book.hasUserOverrides"
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--sm"
              @click="resetModalOpen = true"
            >
              {{ t('book.resetOverridesBtn') }}
            </button>
          </div>
        </div>
      </article>

      <!-- Résumé & ISBN -->
      <div v-if="book.description || book.knownIsbns.length > 0" class="ds-card ds-stack">
        <div v-if="book.description" class="ds-stack">
          <h2>{{ t('book.descriptionLabel') }}</h2>
          <p>{{ book.description }}</p>
        </div>
        <div v-if="book.knownIsbns.length > 0" class="ds-text-muted">
          <strong>{{ t('book.editionsLabel') }} :</strong> {{ book.knownIsbns.join(', ') }}
        </div>
      </div>

      <!-- Bloc Lecture, Note & Notes personnelles (strictement individuel user_id) -->
      <div class="ds-card ds-stack">
        <h2>{{ t('book.myReadingLabel') }}</h2>

        <form class="ds-stack" @submit.prevent="handleSaveReading">
          <div class="ds-grid-2">
            <div class="ds-field">
              <label class="ds-label" for="reading-status-select">{{ t('book.myReadingLabel') }}</label>
              <select id="reading-status-select" v-model="readingStatus" class="ds-input">
                <option v-for="opt in readingOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>

            <div class="ds-field">
              <span class="ds-label">{{ t('book.myRatingLabel') }}</span>
              <div class="ds-row">
                <button
                  v-for="star in [1, 2, 3, 4, 5]"
                  :key="star"
                  type="button"
                  class="ds-btn ds-btn--sm rating-star"
                  :class="{ 'rating-star--active': star <= readingRating }"
                  :aria-label="t('book.ratingStarLabel', { n: star })"
                  @click="readingRating = star"
                >
                  ★
                </button>
                <button
                  v-if="readingRating > 0"
                  type="button"
                  class="ds-btn ds-btn--ghost ds-btn--sm"
                  @click="readingRating = 0"
                >
                  {{ t('book.ratingClear') }}
                </button>
              </div>
            </div>
          </div>

          <div class="ds-field">
            <label class="ds-label" for="reading-notes-area">{{ t('book.personalNotesLabel') }}</label>
            <textarea
              id="reading-notes-area"
              v-model="readingNotes"
              rows="3"
              class="ds-input"
              :placeholder="t('book.personalNotesPlaceholder')"
            />
          </div>

          <div class="ds-row detail-actions-end">
            <button type="submit" class="ds-btn ds-btn--primary" :disabled="savingReading">
              {{ savingReading ? t('app.loading') : t('app.save') }}
            </button>
          </div>
        </form>
      </div>

      <!-- Modale Intégrale rapide -->
      <BaseModal
        :open="integralModalOpen"
        :title="book.isIntegral ? t('book.editIntegralBtn') : t('book.integralBtn')"
        @close="integralModalOpen = false"
      >
        <div class="ds-stack">
          <div v-if="!book.isIntegral && book.seriesId" class="ds-stack">
            <label class="ds-row">
              <input v-model="integralModalMode" type="radio" value="create_separate" />
              <span>{{ t('book.integralCreateSeparateMode') }}</span>
            </label>
            <label class="ds-row">
              <input v-model="integralModalMode" type="radio" value="convert_self" />
              <span>{{ t('book.integralConvertSelfMode') }}</span>
            </label>
            <p v-if="integralModalMode === 'create_separate'" class="ds-text-muted">
              {{ t('book.integralSeparateHint') }}
            </p>
          </div>
          <IntegralFields
            v-model:is-integral="draftIsIntegral"
            v-model:included-volumes="draftIncludedVolumes"
          />
        </div>
        <template #footer>
          <button type="button" class="ds-btn" :disabled="savingOverrides" @click="integralModalOpen = false">
            {{ t('app.cancel') }}
          </button>
          <button type="button" class="ds-btn ds-btn--primary" :disabled="savingOverrides" @click="saveIntegralModal">
            {{ savingOverrides ? t('app.loading') : t('app.save') }}
          </button>
        </template>
      </BaseModal>

      <!-- Modale Confirmation Réinitialisation Couche 3 -->
      <BaseModal
        :open="resetModalOpen"
        :title="t('book.resetOverridesConfirmTitle')"
        @close="resetModalOpen = false"
      >
        <p>{{ t('book.resetOverridesConfirmDesc') }}</p>
        <template #footer>
          <button type="button" class="ds-btn" :disabled="savingOverrides" @click="resetModalOpen = false">
            {{ t('app.cancel') }}
          </button>
          <button type="button" class="ds-btn ds-btn--danger" :disabled="savingOverrides" @click="confirmResetOverrides">
            {{ t('app.confirm') }}
          </button>
        </template>
      </BaseModal>
      <SeriesAttachModal
        :open="attachModalOpen"
        :book-ids="[book.id]"
        :source-series-id="book.seriesId"
        @close="attachModalOpen = false"
        @attached="loadBook"
      />
    </template>
  </section>
</template>

<style scoped>
.book-hero {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
}

.book-hero__cover {
  flex: 0 0 180px;
  width: 180px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
}

.book-hero__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.book-hero__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2rem;
  font-weight: 700;
  color: var(--text-muted);
}

.book-hero__info {
  flex: 1;
  min-width: 260px;
}

.book-hero__series-link {
  font-weight: 700;
  color: var(--accent);
}

.detail-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 0.82rem;
  font-weight: 600;
}

.detail-badge--owned {
  background: var(--status-owned-bg);
  color: var(--status-owned-text);
}

.detail-badge--wish {
  background: var(--status-wish-bg);
  color: var(--status-wish-text);
}

.detail-badge--lent {
  background: var(--status-lent-bg);
  color: var(--status-lent-text);
}

.detail-badge--integral {
  background: var(--status-integral-bg);
  color: var(--status-integral-text);
}

.rating-star {
  font-size: 1.05rem;
  color: var(--text-muted);
}

.rating-star--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.detail-actions-end {
  justify-content: flex-end;
}
</style>
