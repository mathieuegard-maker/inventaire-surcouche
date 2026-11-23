<!-- src/client/views/BookCreateView.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import IntegralFields from '../components/books/IntegralFields.vue';
import CoverPicker from '../components/books/CoverPicker.vue';
import { useLibraryStore } from '../stores/library.store';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { ApiClientError } from '../api/client';
import type { BookMainCategory, OwnershipStatus } from '../../shared/types/domain.types';
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

const isbn13 = ref(typeof route.query.isbn === 'string' ? route.query.isbn : '');
const title = ref('');
const authorsText = ref('');
const seriesName = ref('');
const oneShot = ref(false);
const expandSeries = ref(true);
const volumeNumber = ref('');
const isIntegral = ref(false);
const includedVolumes = ref<string[]>([]);
const publisher = ref('');
const publishYear = ref('');
const pageCount = ref('');
const mainCategory = ref<BookMainCategory>('BD');
const genres = ref<string[]>([]);
const coverKey = ref<string | null>(null);
const ownershipStatus = ref<OwnershipStatus>('owned');

const prefilling = ref(false);
const submitting = ref(false);

async function handlePrefill(): Promise<void> {
  const clean = isbn13.value.trim();
  if (!clean) return;
  prefilling.value = true;
  try {
    const preview = await libraryStore.resolveIsbnPreview(clean);
    if (!preview) {
      uiStore.pushToast(t('book.prefillNotFound'), 'info');
      return;
    }
    title.value = preview.title;
    authorsText.value = preview.authors.join(', ');
    seriesName.value = preview.seriesName ?? '';
    oneShot.value = !preview.seriesName;
    volumeNumber.value = preview.volumeNumber !== null ? String(preview.volumeNumber) : '';
    isIntegral.value = preview.isIntegral;
    includedVolumes.value = [...preview.includedVolumes];
    publisher.value = preview.publisher ?? '';
    publishYear.value = preview.publishYear ?? '';
    pageCount.value = preview.pageCount !== null ? String(preview.pageCount) : '';
    mainCategory.value = preview.mainCategory;
    genres.value = [...preview.genres];
    coverKey.value = preview.coverKey;
    uiStore.pushToast(t('book.prefillSuccess'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('book.prefillNotFound'), 'warning');
  } finally {
    prefilling.value = false;
  }
}

function toggleGenre(label: string): void {
  const idx = genres.value.indexOf(label);
  if (idx >= 0) genres.value.splice(idx, 1);
  else genres.value.push(label);
}

async function handleCreate(): Promise<void> {
  if (!title.value.trim()) return;
  submitting.value = true;
  try {
    const parsedAuthors = authorsText.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const parsedVol = /^\d+$/.test(volumeNumber.value.trim()) ? parseInt(volumeNumber.value.trim(), 10) : null;
    const parsedPages = /^\d+$/.test(pageCount.value.trim()) ? parseInt(pageCount.value.trim(), 10) : null;

    const { book } = await libraryStore.createManualBook({
      isbn13: isbn13.value.trim() || undefined,
      title: title.value.trim(),
      authors: parsedAuthors,
      seriesName: oneShot.value ? null : (seriesName.value.trim() || null),
      volumeNumber: oneShot.value ? null : parsedVol,
      volumeLabel: !oneShot.value && parsedVol !== null ? String(parsedVol) : null,
      oneShot: oneShot.value,
      expandSeries: !oneShot.value && expandSeries.value,
      isIntegral: isIntegral.value,
      includedVolumes: isIntegral.value ? includedVolumes.value : [],
      publisher: publisher.value.trim() || null,
      publishYear: publishYear.value.trim() || null,
      pageCount: parsedPages,
      mainCategory: mainCategory.value,
      genres: genres.value,
      coverKey: coverKey.value,
      ownershipStatus: ownershipStatus.value
    });

    uiStore.pushToast(t('book.manualCreatedToast'), 'success');
    await router.replace(`/book/${encodeURIComponent(book.id)}`);
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  if (isbn13.value.trim()) {
    void handlePrefill();
  }
});
</script>

<template>
  <section class="ds-stack">
    <div class="ds-row ds-row--between">
      <button type="button" class="ds-btn ds-btn--sm" @click="router.back()">
        ← {{ t('app.back') }}
      </button>
    </div>

    <h1>{{ t('book.createUnknownTitle') }}</h1>

    <form class="ds-card ds-stack" @submit.prevent="handleCreate">
      <div class="ds-field">
        <label class="ds-label" for="create-isbn">{{ t('book.isbnLabel') }}</label>
        <div class="ds-row">
          <input id="create-isbn" v-model="isbn13" type="text" class="ds-input create-isbn-input" />
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="prefilling || !isbn13.trim()"
            @click="handlePrefill"
          >
            {{ prefilling ? t('app.loading') : t('book.prefillIsbnBtn') }}
          </button>
        </div>
      </div>

      <CoverPicker v-model="coverKey" />

      <div class="ds-field">
        <label class="ds-label" for="create-title">{{ t('scan.fieldTitle') }}</label>
        <input id="create-title" v-model="title" type="text" class="ds-input" required />
      </div>

      <div class="ds-field">
        <label class="ds-label" for="create-authors">{{ t('book.authorsLabel') }}</label>
        <input id="create-authors" v-model="authorsText" type="text" class="ds-input" />
      </div>

      <div class="ds-grid-2">
        <div class="ds-field">
          <label class="ds-label" for="create-series">{{ t('scan.fieldSeries') }}</label>
          <input id="create-series" v-model="seriesName" type="text" class="ds-input" :disabled="oneShot" />
        </div>
        <div class="ds-field">
          <label class="ds-label" for="create-volume">{{ t('scan.fieldVolume') }}</label>
          <input id="create-volume" v-model="volumeNumber" type="text" class="ds-input" :disabled="oneShot" />
        </div>
      </div>

      <label class="ds-checkbox">
        <input v-model="oneShot" type="checkbox" />
        <span>{{ t('book.noSeriesCheckbox') }}</span>
      </label>

      <label v-if="!oneShot && seriesName.trim()" class="ds-checkbox">
        <input v-model="expandSeries" type="checkbox" />
        <span>{{ t('book.expandSeriesCheckbox') }}</span>
      </label>

      <IntegralFields v-model:is-integral="isIntegral" v-model:included-volumes="includedVolumes" />

      <div class="ds-grid-3">
        <div class="ds-field">
          <label class="ds-label" for="create-publisher">{{ t('book.publisherLabel') }}</label>
          <input id="create-publisher" v-model="publisher" type="text" class="ds-input" />
        </div>
        <div class="ds-field">
          <label class="ds-label" for="create-year">{{ t('book.publishYearLabel') }}</label>
          <input id="create-year" v-model="publishYear" type="text" class="ds-input" />
        </div>
        <div class="ds-field">
          <label class="ds-label" for="create-pages">{{ t('book.pageCountLabel') }}</label>
          <input id="create-pages" v-model="pageCount" type="number" min="1" class="ds-input" />
        </div>
      </div>

      <div class="ds-grid-2">
        <div class="ds-field">
          <label class="ds-label" for="create-category">{{ t('book.categoryLabel') }}</label>
          <select id="create-category" v-model="mainCategory" class="ds-input">
            <option v-for="cat in CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
          </select>
        </div>

        <div class="ds-field">
          <label class="ds-label" for="create-target">{{ t('book.ownershipTargetLabel') }}</label>
          <select id="create-target" v-model="ownershipStatus" class="ds-input">
            <option value="owned">{{ t('book.statusOwned') }}</option>
            <option value="wish">{{ t('book.statusWished') }}</option>
            <option value="none">{{ t('book.statusUnowned') }}</option>
          </select>
        </div>
      </div>

      <div class="ds-panel ds-stack">
        <span class="ds-label">{{ t('book.genresLabel') }}</span>
        <div class="ds-chips">
          <button
            v-for="g in authStore.profile?.defaultGenres ?? []"
            :key="g"
            type="button"
            class="ds-chip create-genre-chip"
            :class="{ 'create-genre-chip--active': genres.includes(g) }"
            @click="toggleGenre(g)"
          >
            {{ g }}
          </button>
        </div>
      </div>

      <div class="ds-row create-actions-end">
        <button type="button" class="ds-btn" @click="router.back()">{{ t('app.cancel') }}</button>
        <button type="submit" class="ds-btn ds-btn--primary" :disabled="submitting || !title.trim()">
          {{ submitting ? t('app.loading') : t('app.save') }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.create-isbn-input {
  flex: 1;
  min-width: 180px;
}

.create-genre-chip {
  cursor: pointer;
}

.create-genre-chip--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.create-actions-end {
  justify-content: flex-end;
}
</style>
