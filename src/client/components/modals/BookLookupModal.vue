<!-- src/client/components/modals/BookLookupModal.vue -->
<!-- Modale réutilisable (DRY) de recherche manuelle 6 champs + caméra ISBN + choix d'édition avec couvertures.
     Partagée entre PhotoItemModal.vue ("Ce n'est pas la bonne référence") et BookEditView.vue ("Ce n'est pas le bon livre"). -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import CameraBarcodeModal from './CameraBarcodeModal.vue';
import { apiRequest, ApiClientError } from '../../api/client';
import { useUiStore } from '../../stores/ui.store';
import type { PhotoCandidateOption } from '../../stores/scan.store';
import { t } from '../../../shared/locales';

export interface BookLookupHints {
  title?: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  publisher?: string;
  isbn?: string;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    mode: 'retry' | 'pick';
    title?: string;
    description?: string;
    busy?: boolean;
  }>(),
  {
    title: undefined,
    description: undefined,
    busy: false
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submit-hints', hints: BookLookupHints): void;
  (e: 'select-option', option: PhotoCandidateOption): void;
}>();

const uiStore = useUiStore();

const manualTitle = ref('');
const manualSeries = ref('');
const manualVolume = ref('');
const manualAuthor = ref('');
const manualPublisher = ref('');
const manualIsbn = ref('');

const pickerCameraOpen = ref(false);
const searching = ref(false);
const hasSearched = ref(false);
const options = ref<PhotoCandidateOption[]>([]);

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      // 6 champs volontairement vides pour repartir sur des critères propres
      manualTitle.value = '';
      manualSeries.value = '';
      manualVolume.value = '';
      manualAuthor.value = '';
      manualPublisher.value = '';
      manualIsbn.value = '';
      options.value = [];
      hasSearched.value = false;
      pickerCameraOpen.value = false;
    }
  }
);

function buildHints(): BookLookupHints {
  return {
    title: manualTitle.value.trim() || undefined,
    series: manualSeries.value.trim() || undefined,
    volumeNumber: manualVolume.value.trim() || undefined,
    author: manualAuthor.value.trim() || undefined,
    publisher: manualPublisher.value.trim() || undefined,
    isbn: manualIsbn.value.trim() || undefined
  };
}

function handlePickerDetected(isbn13: string): void {
  manualIsbn.value = isbn13;
  pickerCameraOpen.value = false;
  if (props.mode === 'pick') {
    void handleSubmit();
  }
}

async function handleSubmit(): Promise<void> {
  const hints = buildHints();
  if (props.mode === 'retry') {
    emit('submit-hints', hints);
    return;
  }

  searching.value = true;
  hasSearched.value = false;
  try {
    const res = await apiRequest<{ ok: true; options: PhotoCandidateOption[] }>('/api/books/lookup', {
      method: 'POST',
      body: hints,
      timeoutMs: 45000
    });
    options.value = res.options;
    hasSearched.value = true;
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    searching.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="title || t('scan.manualSearchTitle')"
    max-width="600px"
    @close="emit('close')"
  >
    <div class="ds-stack">
      <form id="book-lookup-modal-form" class="ds-stack" @submit.prevent="handleSubmit">
        <p class="ds-text-muted">{{ description || t('scan.photoManualHintDesc') }}</p>

        <div class="lookup-field-row">
          <div class="ds-field lookup-field-grow">
            <label class="ds-label" for="lookup-title">{{ t('scan.fieldTitle') }}</label>
            <input id="lookup-title" v-model="manualTitle" type="text" class="ds-input" />
          </div>
          <button
            v-if="manualTitle"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm lookup-clear-btn"
            :aria-label="t('scan.clearField')"
            @click="manualTitle = ''"
          >
            ✕
          </button>
        </div>

        <div class="ds-grid-2">
          <div class="lookup-field-row">
            <div class="ds-field lookup-field-grow">
              <label class="ds-label" for="lookup-series">{{ t('scan.fieldSeries') }}</label>
              <input id="lookup-series" v-model="manualSeries" type="text" class="ds-input" />
            </div>
            <button
              v-if="manualSeries"
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--sm lookup-clear-btn"
              :aria-label="t('scan.clearField')"
              @click="manualSeries = ''"
            >
              ✕
            </button>
          </div>

          <div class="lookup-field-row">
            <div class="ds-field lookup-field-grow">
              <label class="ds-label" for="lookup-vol">{{ t('scan.fieldVolume') }}</label>
              <input id="lookup-vol" v-model="manualVolume" type="text" class="ds-input" />
            </div>
            <button
              v-if="manualVolume"
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--sm lookup-clear-btn"
              :aria-label="t('scan.clearField')"
              @click="manualVolume = ''"
            >
              ✕
            </button>
          </div>
        </div>

        <div class="ds-grid-2">
          <div class="lookup-field-row">
            <div class="ds-field lookup-field-grow">
              <label class="ds-label" for="lookup-author">{{ t('scan.fieldAuthor') }}</label>
              <input id="lookup-author" v-model="manualAuthor" type="text" class="ds-input" />
            </div>
            <button
              v-if="manualAuthor"
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--sm lookup-clear-btn"
              :aria-label="t('scan.clearField')"
              @click="manualAuthor = ''"
            >
              ✕
            </button>
          </div>

          <div class="lookup-field-row">
            <div class="ds-field lookup-field-grow">
              <label class="ds-label" for="lookup-pub">{{ t('scan.fieldPublisher') }}</label>
              <input id="lookup-pub" v-model="manualPublisher" type="text" class="ds-input" />
            </div>
            <button
              v-if="manualPublisher"
              type="button"
              class="ds-btn ds-btn--ghost ds-btn--sm lookup-clear-btn"
              :aria-label="t('scan.clearField')"
              @click="manualPublisher = ''"
            >
              ✕
            </button>
          </div>
        </div>

        <div class="lookup-field-row">
          <div class="ds-field lookup-field-grow">
            <label class="ds-label" for="lookup-isbn">{{ t('scan.fieldIsbn') }}</label>
            <input id="lookup-isbn" v-model="manualIsbn" type="text" class="ds-input" />
          </div>
          <button
            type="button"
            class="ds-btn ds-btn--sm lookup-clear-btn"
            :aria-label="t('scan.cameraTitlePicker')"
            @click="pickerCameraOpen = true"
          >
            📷
          </button>
          <button
            v-if="manualIsbn"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm lookup-clear-btn"
            :aria-label="t('scan.clearField')"
            @click="manualIsbn = ''"
          >
            ✕
          </button>
        </div>
      </form>

      <!-- Liste des propositions trouvées avec couvertures (mode 'pick') -->
      <div v-if="mode === 'pick' && hasSearched" class="ds-stack">
        <div v-if="options.length === 0" class="ds-panel ds-text-muted">
          {{ t('scan.photoRetryBnfNone') }}
        </div>
        <div v-else class="ds-stack">
          <strong class="ds-label">{{ t('scan.photoSelectOptionLabel') }}</strong>
          <div v-for="opt in options" :key="opt.isbn13" class="ds-panel lookup-option-row">
            <span class="lookup-option-cover">
              <img v-if="opt.coverUrl" :src="opt.coverUrl" :alt="opt.title" loading="lazy" />
              <span v-else class="lookup-option-cover__placeholder">
                {{ opt.title.slice(0, 2).toUpperCase() }}
              </span>
            </span>
            <div class="lookup-option-body">
              <strong>
                {{ opt.title }}
                <template v-if="opt.volumeNumber"> · T.{{ opt.volumeNumber }}</template>
              </strong>
              <span v-if="opt.seriesName" class="ds-text-muted">{{ opt.seriesName }}</span>
              <span v-if="(opt.editionCount ?? 1) > 1" class="ds-badge">
                {{ t('scan.photoEditionsGroupedBadge', { count: opt.editionCount! }) }}
              </span>
              <span class="ds-text-muted">
                {{ [opt.authors.join(', '), opt.publisher, opt.publishYear, opt.isbn13].filter(Boolean).join(' · ') }}
              </span>
            </div>
            <button
              type="button"
              class="ds-btn ds-btn--sm ds-btn--primary"
              :disabled="busy"
              @click="emit('select-option', opt)"
            >
              {{ busy ? t('app.loading') : t('book.replaceConfirmBtn') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <button type="button" class="ds-btn" :disabled="searching || busy" @click="emit('close')">
        {{ t('app.cancel') }}
      </button>
      <button
        type="submit"
        form="book-lookup-modal-form"
        class="ds-btn ds-btn--primary"
        :disabled="searching || busy"
      >
        {{ searching || busy ? t('app.loading') : t('scan.launchBnfSearch') }}
      </button>
    </template>
  </BaseModal>

  <CameraBarcodeModal
    :open="pickerCameraOpen"
    mode="picker"
    @close="pickerCameraOpen = false"
    @detected="handlePickerDetected"
  />
</template>

<style scoped>
.lookup-field-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}

.lookup-field-grow {
  flex: 1;
}

.lookup-clear-btn {
  flex-shrink: 0;
  height: 40px;
}

.lookup-option-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.lookup-option-cover {
  width: 44px;
  height: 64px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lookup-option-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.lookup-option-cover__placeholder {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--text-muted);
}

.lookup-option-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
}
</style>
