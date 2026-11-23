<!-- src/client/views/BookEditView.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseModal from '../components/base/BaseModal.vue';
import BookLookupModal from '../components/modals/BookLookupModal.vue';
import IntegralFields from '../components/books/IntegralFields.vue';
import CoverPicker from '../components/books/CoverPicker.vue';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { apiRequest, ApiClientError } from '../api/client';
import type { PhotoCandidateOption } from '../stores/scan.store';
import type { BookMainCategory, BookView } from '../../shared/types/domain.types';
import { t } from '../../shared/locales';

const CATEGORIES: BookMainCategory[] = [
  'BD',
  'Manga',
  'Comics',
  'Roman',
  'Jeunesse',
  'Essai',
  'Poésie / Théâtre',
  'Pratique',
  'Art / Beau livre',
  'Autre'
];

const route = useRoute();
const router = useRouter();
const libraryStore = useLibraryStore();
const authStore = useAuthStore();
const uiStore = useUiStore();

const loading = ref(true);
const saving = ref(false);
const replacing = ref(false);
const book = ref<BookView | null>(null);
const resetModalOpen = ref(false);
const replaceModalOpen = ref(false);

const title = ref('');
const authorsText = ref('');
const seriesName = ref('');
const oneShotForced = ref(false);
const volumeNumber = ref<string>('');
const isIntegral = ref(false);
const includedVolumes = ref<string[]>([]);
const publisher = ref('');
const publishYear = ref('');
const pageCount = ref<string>('');
const mainCategory = ref<BookMainCategory>('BD');
const genres = ref<string[]>([]);
const customGenreInput = ref('');
const propagateGenresToSeries = ref(false);
const coverKey = ref<string | null>(null);

function hydrateForm(b: BookView): void {
  title.value = b.title;
  authorsText.value = b.authors.join(', ');
  seriesName.value = b.seriesName ?? '';
  oneShotForced.value = !b.seriesId && !b.seriesName;
  volumeNumber.value = b.volumeNumber !== null ? String(b.volumeNumber) : '';
  isIntegral.value = b.isIntegral;
  includedVolumes.value = [...b.includedVolumes];
  publisher.value = b.publisher ?? '';
  publishYear.value = b.publishYear ?? '';
  pageCount.value = b.pageCount !== null ? String(b.pageCount) : '';
  mainCategory.value = b.mainCategory;
  genres.value = [...b.genres];
  coverKey.value = b.coverKey;
}

async function load(): Promise<void> {
  const id = typeof route.params.bookId === 'string' ? route.params.bookId : '';
  if (!id) return;
  loading.value = true;
  try {
    const res = await libraryStore.fetchBookDetail(id);
    book.value = res?.book ?? null;
    if (book.value) hydrateForm(book.value);
  } finally {
    loading.value = false;
  }
}

function toggleGenre(label: string): void {
  const idx = genres.value.indexOf(label);
  if (idx >= 0) genres.value.splice(idx, 1);
  else genres.value.push(label);
}

function addCustomGenre(alsoToDefaults: boolean): void {
  const clean = customGenreInput.value.trim();
  if (!clean) return;
  if (!genres.value.includes(clean)) genres.value.push(clean);
  if (alsoToDefaults) {
    void authStore.updateDefaultGenres('add', clean);
  }
  customGenreInput.value = '';
}

async function handleSave(): Promise<void> {
  if (!book.value) return;
  saving.value = true;
  try {
    const parsedAuthors = authorsText.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const parsedVol = /^\d+$/.test(volumeNumber.value.trim()) ? parseInt(volumeNumber.value.trim(), 10) : null;
    const parsedPages = /^\d+$/.test(pageCount.value.trim()) ? parseInt(pageCount.value.trim(), 10) : null;

    await libraryStore.saveBookOverrides(book.value.id, {
      title: title.value.trim(),
      authors: parsedAuthors,
      oneShotForced: oneShotForced.value,
      seriesName: oneShotForced.value ? null : (seriesName.value.trim() || null),
      volumeNumber: parsedVol,
      volumeLabel: parsedVol !== null ? String(parsedVol) : null,
      isIntegral: isIntegral.value,
      includedVolumes: isIntegral.value ? includedVolumes.value : [],
      publisher: publisher.value.trim() || null,
      publishYear: publishYear.value.trim() || null,
      pageCount: parsedPages,
      mainCategory: mainCategory.value,
      genres: genres.value,
      coverKey: coverKey.value,
      propagateGenresToSeries: propagateGenresToSeries.value
    });

    uiStore.pushToast(t('book.overridesSavedToast'), 'success');
    await router.push(`/book/${encodeURIComponent(book.value.id)}`);
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    saving.value = false;
  }
}

async function confirmReset(): Promise<void> {
  if (!book.value) return;
  saving.value = true;
  try {
    book.value = await libraryStore.resetBookOverrides(book.value.id);
    hydrateForm(book.value);
    resetModalOpen.value = false;
    uiStore.pushToast(t('book.resetOverridesDone'), 'success');
  } finally {
    saving.value = false;
  }
}

async function handleReplaceBook(option: PhotoCandidateOption): Promise<void> {
  if (!book.value) return;
  replacing.value = true;
  try {
    const res = await apiRequest<{ ok: true; oldBookId: string; book: BookView }>(
      `/api/books/${encodeURIComponent(book.value.id)}/replace`,
      {
        method: 'POST',
        body: { targetIsbn13: option.isbn13 },
        timeoutMs: 45000
      }
    );
    replaceModalOpen.value = false;
    await libraryStore.syncNow();
    uiStore.pushToast(t('book.replaceSuccessToast'), 'success');
    await router.replace(`/book/${encodeURIComponent(res.book.id)}`);
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    replacing.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="ds-stack">
    <div class="ds-row ds-row--between">
      <button type="button" class="ds-btn ds-btn--sm" @click="router.back()">
        ← {{ t('app.back') }}
      </button>
      <div class="ds-row">
        <button
          v-if="book"
          type="button"
          class="ds-btn ds-btn--sm"
          @click="replaceModalOpen = true"
        >
          {{ t('book.wrongBookBtn') }}
        </button>
        <button
          v-if="book?.hasUserOverrides"
          type="button"
          class="ds-btn ds-btn--ghost ds-btn--sm"
          @click="resetModalOpen = true"
        >
          {{ t('book.resetOverridesBtn') }}
        </button>
      </div>
    </div>

    <h1>{{ t('book.editViewTitle') }}</h1>
    <p class="ds-banner ds-banner--warning">{{ t('book.editLayer3Hint') }}</p>

    <div v-if="loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</div>
    <div v-else-if="!book" class="ds-card ds-text-muted">{{ t('book.notFound') }}</div>

    <form v-else class="ds-card ds-stack" @submit.prevent="handleSave">
      <CoverPicker v-model="coverKey" :book-id="book.id" />

      <div class="ds-field">
        <label class="ds-label" for="edit-title">{{ t('scan.fieldTitle') }}</label>
        <input id="edit-title" v-model="title" type="text" class="ds-input" required />
      </div>

      <div class="ds-field">
        <label class="ds-label" for="edit-authors">{{ t('book.authorsLabel') }}</label>
        <input id="edit-authors" v-model="authorsText" type="text" class="ds-input" />
      </div>

      <div class="ds-grid-2">
        <div class="ds-field">
          <label class="ds-label" for="edit-series">{{ t('scan.fieldSeries') }}</label>
          <input id="edit-series" v-model="seriesName" type="text" class="ds-input" :disabled="oneShotForced" />
        </div>
        <div class="ds-field">
          <label class="ds-label" for="edit-volume">{{ t('scan.fieldVolume') }}</label>
          <input id="edit-volume" v-model="volumeNumber" type="text" class="ds-input" :disabled="oneShotForced" />
        </div>
      </div>

      <label class="ds-checkbox">
        <input v-model="oneShotForced" type="checkbox" />
        <span>{{ t('book.noSeriesCheckbox') }}</span>
      </label>

      <IntegralFields v-model:is-integral="isIntegral" v-model:included-volumes="includedVolumes" />

      <div class="ds-grid-3">
        <div class="ds-field">
          <label class="ds-label" for="edit-publisher">{{ t('book.publisherLabel') }}</label>
          <input id="edit-publisher" v-model="publisher" type="text" class="ds-input" />
        </div>
        <div class="ds-field">
          <label class="ds-label" for="edit-year">{{ t('book.publishYearLabel') }}</label>
          <input id="edit-year" v-model="publishYear" type="text" class="ds-input" />
        </div>
        <div class="ds-field">
          <label class="ds-label" for="edit-pages">{{ t('book.pageCountLabel') }}</label>
          <input id="edit-pages" v-model="pageCount" type="number" min="1" class="ds-input" />
        </div>
      </div>

      <div class="ds-field">
        <label class="ds-label" for="edit-category">{{ t('book.categoryLabel') }}</label>
        <select id="edit-category" v-model="mainCategory" class="ds-input">
          <option v-for="cat in CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
        </select>
      </div>

      <div class="ds-panel ds-stack">
        <span class="ds-label">{{ t('book.genresLabel') }}</span>
        <div class="ds-chips">
          <button
            v-for="g in authStore.profile?.defaultGenres ?? []"
            :key="g"
            type="button"
            class="ds-chip edit-genre-chip"
            :class="{ 'edit-genre-chip--active': genres.includes(g) }"
            @click="toggleGenre(g)"
          >
            {{ g }}
          </button>
        </div>

        <div class="ds-row">
          <input
            v-model="customGenreInput"
            type="text"
            class="ds-input edit-genre-input"
            :placeholder="t('batch.genresCustomPlaceholder')"
            @keydown.enter.prevent="addCustomGenre(false)"
          />
          <button type="button" class="ds-btn ds-btn--sm" :disabled="!customGenreInput.trim()" @click="addCustomGenre(false)">
            {{ t('book.addGenreToBook') }}
          </button>
          <button type="button" class="ds-btn ds-btn--sm" :disabled="!customGenreInput.trim()" @click="addCustomGenre(true)">
            {{ t('book.addGenreToDefaults') }}
          </button>
        </div>

        <label v-if="!oneShotForced && (book.seriesId || seriesName)" class="ds-checkbox">
          <input v-model="propagateGenresToSeries" type="checkbox" />
          <span>{{ t('book.propagateGenresCheckbox') }}</span>
        </label>
      </div>

      <div class="ds-row edit-actions-end">
        <button type="button" class="ds-btn" @click="router.back()">{{ t('app.cancel') }}</button>
        <button type="submit" class="ds-btn ds-btn--primary" :disabled="saving || !title.trim()">
          {{ saving ? t('app.loading') : t('app.save') }}
        </button>
      </div>
    </form>

    <BaseModal :open="resetModalOpen" :title="t('book.resetOverridesConfirmTitle')" @close="resetModalOpen = false">
      <p>{{ t('book.resetOverridesConfirmDesc') }}</p>
      <template #footer>
        <button type="button" class="ds-btn" @click="resetModalOpen = false">{{ t('app.cancel') }}</button>
        <button type="button" class="ds-btn ds-btn--danger" :disabled="saving" @click="confirmReset">
          {{ t('app.confirm') }}
        </button>
      </template>
    </BaseModal>
    <BookLookupModal
      :open="replaceModalOpen"
      mode="pick"
      :title="t('book.replaceModalTitle')"
      :description="t('book.replaceModalDesc')"
      :busy="replacing"
      @close="replaceModalOpen = false"
      @select-option="handleReplaceBook"
    />
  </section>
</template>

<style scoped>
.edit-genre-chip {
  cursor: pointer;
}

.edit-genre-chip--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.edit-genre-input {
  flex: 1;
  min-width: 180px;
}

.edit-actions-end {
  justify-content: flex-end;
}
</style>
