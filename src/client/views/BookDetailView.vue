<!-- src/client/views/BookDetailView.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Image,
  Layers,
  Link2,
  Pencil,
  RotateCcw,
  Star,
  Unlink
} from '@lucide/vue';
import BaseModal from '../components/base/BaseModal.vue';
import HelpTooltip from '../components/base/HelpTooltip.vue';
import BookActions from '../components/books/BookActions.vue';
import IntegralFields from '../components/books/IntegralFields.vue';
import CoverChangeModal from '../components/modals/CoverChangeModal.vue';
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
const moreActionsOpen = ref(false);

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

// Modales secondaires & confirmations
const resetModalOpen = ref(false);
const excludeModalOpen = ref(false);
const attachModalOpen = ref(false);
const coverModalOpen = ref(false);

const readingOptions = computed<Array<{ value: ReadingStatus; label: string }>>(() => [
  { value: 'none', label: t('book.readingNone') },
  { value: 'to_read', label: t('book.readingToRead') },
  { value: 'reading', label: t('book.readingInProgress') },
  { value: 'read', label: t('book.readingRead') },
  { value: 'abandoned', label: t('book.readingAbandoned') }
]);

// Genres cliquables : catégorie principale + sous-genres dédupliqués
const displayGenres = computed(() => {
  if (!book.value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const candidates = [book.value.mainCategory, ...(book.value.genres ?? [])];
  for (const g of candidates) {
    const clean = (g ?? '').trim();
    if (!clean || clean === 'Autre') continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
});

// Masque totalement les ISBN inconnus / factices
const validKnownIsbns = computed(() =>
  (book.value?.knownIsbns ?? []).filter((isbn) => /^(97[89]\d{10}|\d{9}[\dX])$/i.test(isbn.replace(/[-\s]/g, '')))
);

function syncReadingForm(b: BookView | null): void {
  readingStatus.value = b?.readingState?.status ?? 'none';
  readingRating.value = b?.readingState?.rating ?? 0;
  readingNotes.value = b?.readingState?.notes ?? '';
}

async function loadBook(): Promise<void> {
  const rawId = typeof route.params.bookId === 'string' ? route.params.bookId : '';
  if (!rawId) return;
  loading.value = true;
  moreActionsOpen.value = false;
  try {
    const res = await libraryStore.fetchBookDetail(rawId);
    book.value = res?.book ?? null;
    seriesContext.value = res?.seriesContext ?? null;
    syncReadingForm(book.value);
  } finally {
    loading.value = false;
  }
}

watch(
  () => route.params.bookId,
  () => {
    void loadBook();
  },
  { immediate: true }
);

function navigateAdjacent(targetBookId: string | null): void {
  if (!targetBookId) return;
  // Remplace l'entrée d'historique pour qu'un seul Retour ramène directement à la série / liste d'origine
  void router.replace(`/book/${encodeURIComponent(targetBookId)}`);
}

function openGenreFilter(genre: string): void {
  void router.push({ path: '/collection', query: { genre } });
}

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
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('book.readingSavedToast'), 'success', 2400);
  } finally {
    savingReading.value = false;
  }
}

function openIntegralModal(): void {
  if (!book.value) return;
  if (!book.value.isIntegral && book.value.seriesId) {
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

async function confirmExcludeFromSeries(): Promise<void> {
  if (!book.value || !book.value.seriesId) return;
  savingOverrides.value = true;
  try {
    const nextHidden = Array.from(new Set([...book.value.hiddenSeriesIds, book.value.seriesId]));
    book.value = await libraryStore.saveBookOverrides(book.value.id, {
      hiddenSeriesIds: nextHidden,
      oneShotForced: true
    });
    seriesContext.value = null;
    excludeModalOpen.value = false;
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
    <div v-if="loading" class="ds-card ds-text-muted">
      {{ t('app.loading') }}
    </div>

    <div v-else-if="!book" class="ds-card ds-text-muted">
      {{ t('book.notFound') }}
    </div>

    <template v-else>
      <article class="ds-card book-hero">
        <!-- Couverture centrée + flèches latérales œuvre précédente / suivante -->
        <div class="book-cover-stage">
          <button
            v-if="seriesContext"
            type="button"
            class="ds-btn ds-btn--icon book-cover-stage__arrow"
            :disabled="!seriesContext.prevBookId"
            :aria-label="t('book.prevBook')"
            @click="navigateAdjacent(seriesContext.prevBookId)"
          >
            <ChevronLeft :size="22" aria-hidden="true" />
          </button>

          <div class="book-hero__cover">
            <img v-if="book.coverUrl" :src="book.coverUrl" :alt="book.title" />
            <div v-else class="book-hero__placeholder">
              {{ book.title.slice(0, 2).toUpperCase() }}
            </div>
          </div>

          <button
            v-if="seriesContext"
            type="button"
            class="ds-btn ds-btn--icon book-cover-stage__arrow"
            :disabled="!seriesContext.nextBookId"
            :aria-label="t('book.nextBook')"
            @click="navigateAdjacent(seriesContext.nextBookId)"
          >
            <ChevronRight :size="22" aria-hidden="true" />
          </button>
        </div>

        <div class="book-hero__info ds-stack--sm">
          <div class="ds-row">
            <span v-if="book.isIntegral" class="detail-badge detail-badge--integral">
              {{ formatIntegralRangeLabel(book.includedVolumes, book.volumeLabel ?? undefined) }}
            </span>
            <span v-else-if="book.volumeLabel" class="ds-badge">T.{{ book.volumeLabel }}</span>

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
          </div>

          <h1 class="book-hero__title">{{ book.title }}</h1>

          <div v-if="book.seriesName && book.seriesId" class="ds-row">
            <router-link :to="`/series/${encodeURIComponent(book.seriesId)}`" class="book-hero__series-link">
              {{ book.seriesName }}
              <span v-if="seriesContext">
                · {{ t('book.seeWholeSeries', { count: seriesContext.totalVolumes }) }}
              </span>
            </router-link>
          </div>

          <div v-if="book.authors.length > 0" class="ds-chips">
            <router-link
              v-for="author in book.authors"
              :key="author"
              :to="`/author/${encodeURIComponent(author)}`"
              class="ds-chip ds-chip--clickable"
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

          <p v-if="book.publisher || book.publishYear || book.pageCount || book.collectionName" class="ds-text-muted book-hero__meta">
            <span v-if="book.publisher">{{ book.publisher }}</span>
            <span v-if="book.publishYear"> · {{ book.publishYear }}</span>
            <span v-if="book.pageCount"> · {{ book.pageCount }} p.</span>
            <span v-if="book.collectionName"> · {{ book.collectionName }}</span>
          </p>

          <!-- Genres cliquables avec libellé « Genre : » -->
          <div v-if="displayGenres.length > 0" class="book-genres-row">
            <span class="book-genres-label">{{ t('book.genresPrefix') }}</span>
            <div class="ds-chips">
              <button
                v-for="genre in displayGenres"
                :key="genre"
                type="button"
                class="ds-chip ds-chip--clickable"
                @click="openGenreFilter(genre)"
              >
                {{ genre }}
              </button>
            </div>
          </div>

          <!-- Actions principales en gros boutons -->
          <div class="book-actions-block">
            <BookActions :book="book" @updated="loadBook" />

            <!-- Tiroir « Autres actions » -->
            <button
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--sm book-more-toggle"
              :aria-expanded="moreActionsOpen"
              @click="moreActionsOpen = !moreActionsOpen"
            >
              <span>{{ moreActionsOpen ? t('app.lessActions') : t('app.moreActions') }}</span>
              <ChevronUp v-if="moreActionsOpen" :size="16" aria-hidden="true" />
              <ChevronDown v-else :size="16" aria-hidden="true" />
            </button>

            <div v-if="moreActionsOpen" class="book-more-panel ds-panel ds-stack--sm">
              <div class="book-more-item">
                <router-link :to="`/book/${encodeURIComponent(book.id)}/edit`" class="ds-btn ds-btn--sm book-more-item__btn">
                  <Pencil :size="15" aria-hidden="true" />
                  <span>{{ t('book.editBtn') }}</span>
                </router-link>
                <HelpTooltip :title="t('book.editBtn')" :text="t('book.editHelp')" />
              </div>

              <div class="book-more-item">
                <button type="button" class="ds-btn ds-btn--sm book-more-item__btn" @click="coverModalOpen = true">
                  <Image :size="15" aria-hidden="true" />
                  <span>{{ t('book.changeCoverBtn') }}</span>
                </button>
                <HelpTooltip :title="t('book.changeCoverBtn')" :text="t('book.changeCoverHelp')" />
              </div>

              <div class="book-more-item">
                <button type="button" class="ds-btn ds-btn--sm book-more-item__btn" @click="attachModalOpen = true">
                  <Link2 :size="15" aria-hidden="true" />
                  <span>{{ t('book.attachSeriesBtn') }}</span>
                </button>
                <HelpTooltip :title="t('book.attachSeriesBtn')" :text="t('book.attachSeriesHelp')" />
              </div>

              <div class="book-more-item">
                <button type="button" class="ds-btn ds-btn--sm book-more-item__btn" @click="openIntegralModal">
                  <Layers :size="15" aria-hidden="true" />
                  <span>{{ book.isIntegral ? t('book.editIntegralBtn') : t('book.integralBtn') }}</span>
                </button>
                <HelpTooltip :title="t('book.integralBtn')" :text="t('book.integralHelp')" />
              </div>

              <div v-if="book.seriesId" class="book-more-item">
                <button
                  type="button"
                  class="ds-btn ds-btn--sm book-more-item__btn"
                  :disabled="savingOverrides"
                  @click="excludeModalOpen = true"
                >
                  <Unlink :size="15" aria-hidden="true" />
                  <span>{{ t('book.excludeFromSeriesBtn') }}</span>
                </button>
                <HelpTooltip :title="t('book.excludeFromSeriesBtn')" :text="t('book.excludeFromSeriesHelp')" />
              </div>

              <div v-if="book.hasUserOverrides" class="book-more-item">
                <button
                  type="button"
                  class="ds-btn ds-btn--ghost ds-btn--sm book-more-item__btn"
                  @click="resetModalOpen = true"
                >
                  <RotateCcw :size="15" aria-hidden="true" />
                  <span>{{ t('book.resetOverridesBtn') }}</span>
                </button>
                <HelpTooltip :title="t('book.resetOverridesBtn')" :text="t('book.resetOverridesHelp')" />
              </div>
            </div>
          </div>
        </div>
      </article>

      <!-- Résumé & ISBN connus uniquement (jamais « ISBN inconnu ») -->
      <div v-if="book.description || validKnownIsbns.length > 0" class="ds-card ds-stack">
        <div v-if="book.description" class="ds-stack--sm">
          <h2>{{ t('book.descriptionLabel') }}</h2>
          <p class="book-desc-text">{{ book.description }}</p>
        </div>
        <div v-if="validKnownIsbns.length > 0" class="ds-text-muted">
          <strong>{{ t('book.editionsLabel') }} :</strong> {{ validKnownIsbns.join(', ') }}
        </div>
      </div>

      <!-- Bloc Lecture, Note & Notes personnelles (conservé tel quel) -->
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
                  <Star :size="16" :fill="star <= readingRating ? 'currentColor' : 'none'" aria-hidden="true" />
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

      <!-- Modale Intégrale rapide (radios proprement alignés en début de ligne) -->
      <BaseModal
        :open="integralModalOpen"
        :title="book.isIntegral ? t('book.editIntegralBtn') : t('book.integralBtn')"
        @close="integralModalOpen = false"
      >
        <div class="ds-stack">
          <div v-if="!book.isIntegral && book.seriesId" class="ds-stack--sm">
            <label class="ds-radio-option">
              <input v-model="integralModalMode" type="radio" value="create_separate" />
              <span class="ds-radio-option__body">
                <span>{{ t('book.integralCreateSeparateMode') }}</span>
              </span>
            </label>
            <label class="ds-radio-option">
              <input v-model="integralModalMode" type="radio" value="convert_self" />
              <span class="ds-radio-option__body">
                <span>{{ t('book.integralConvertSelfMode') }}</span>
              </span>
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

      <!-- Modale Confirmation « Ne fait pas partie de cette série » -->
      <BaseModal
        :open="excludeModalOpen"
        :title="t('book.excludeFromSeriesConfirmTitle')"
        size="sm"
        @close="excludeModalOpen = false"
      >
        <p>{{ t('book.excludeFromSeriesConfirmDesc', { series: book.seriesName ?? '' }) }}</p>
        <template #footer>
          <button type="button" class="ds-btn" :disabled="savingOverrides" @click="excludeModalOpen = false">
            {{ t('app.cancel') }}
          </button>
          <button type="button" class="ds-btn ds-btn--danger" :disabled="savingOverrides" @click="confirmExcludeFromSeries">
            {{ t('app.confirm') }}
          </button>
        </template>
      </BaseModal>

      <!-- Modale Confirmation Réinitialisation -->
      <BaseModal
        :open="resetModalOpen"
        :title="t('book.resetOverridesConfirmTitle')"
        size="sm"
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
      <CoverChangeModal
        :open="coverModalOpen"
        :book="book"
        @close="coverModalOpen = false"
        @saved="loadBook"
      />
    </template>
  </section>
</template>

<style scoped>
.book-hero {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

@media (min-width: 760px) {
  .book-hero {
    flex-direction: row;
    align-items: flex-start;
    gap: var(--space-5);
  }
}

.book-cover-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  width: 100%;
}

@media (min-width: 760px) {
  .book-cover-stage {
    width: auto;
    flex: 0 0 auto;
  }
}

.book-cover-stage__arrow {
  flex-shrink: 0;
  min-inline-size: 42px;
  min-block-size: 42px;
}

.book-hero__cover {
  width: clamp(148px, 44vw, 200px);
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-md);
}

.book-hero__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
  min-width: 0;
}

.book-hero__title {
  margin: 0;
}

.book-hero__meta {
  margin: 0;
}

.book-hero__series-link {
  font-weight: 700;
  color: var(--accent);
}

.book-genres-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.book-genres-label {
  font-size: 0.86rem;
  font-weight: 700;
  color: var(--text-secondary);
}

.book-actions-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.book-more-toggle {
  width: 100%;
  justify-content: center;
}

.book-more-panel {
  padding: var(--space-3);
}

.book-more-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.book-more-item__btn {
  flex: 1;
  justify-content: flex-start;
}

.book-desc-text {
  margin: 0;
  white-space: pre-line;
}

.detail-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 0.8rem;
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
  min-inline-size: 40px;
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
