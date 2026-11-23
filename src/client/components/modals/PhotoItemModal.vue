<!-- src/client/components/modals/PhotoItemModal.vue -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import CameraBarcodeModal from './CameraBarcodeModal.vue';
import IntegralFields from '../books/IntegralFields.vue';
import { useScanStore, type PhotoJobItem } from '../../stores/scan.store';
import { useUiStore } from '../../stores/ui.store';
import { ApiClientError } from '../../api/client';
import { t } from '../../../shared/locales';

const props = defineProps<{
  open: boolean;
  jobId: string;
  item: PhotoJobItem | null;
  previewUrl: string | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const scanStore = useScanStore();
const uiStore = useUiStore();

const zoomPercent = ref(100);
const saving = ref(false);

// Sous-modale 6 champs vides pour relance BnF serveur
const manualModalOpen = ref(false);
const pickerCameraOpen = ref(false);
const retryingBnf = ref(false);

const manualTitle = ref('');
const manualSeries = ref('');
const manualVolume = ref('');
const manualAuthor = ref('');
const manualPublisher = ref('');
const manualIsbn = ref('');

watch(
  () => [props.open, props.item?.id] as const,
  ([isOpen]) => {
    if (isOpen) {
      zoomPercent.value = 100;
    }
  }
);

function adjustZoom(delta: number): void {
  zoomPercent.value = Math.min(450, Math.max(100, zoomPercent.value + delta));
}

function handleWheelZoom(event: WheelEvent): void {
  if (!props.previewUrl) return;
  event.preventDefault();
  adjustZoom(event.deltaY < 0 ? 25 : -25);
}

async function patchItem(patch: {
  selected?: boolean;
  ignored?: boolean;
  selectedOptionIsbn13?: string | null;
  isIntegral?: boolean;
  includedVolumes?: string[];
}): Promise<void> {
  if (!props.item) return;
  saving.value = true;
  try {
    await scanStore.updatePhotoItem(props.jobId, props.item.id, patch);
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    saving.value = false;
  }
}

function openManualBnfModal(): void {
  // 6 champs volontairement vides pour repartir sur des critères propres
  manualTitle.value = '';
  manualSeries.value = '';
  manualVolume.value = '';
  manualAuthor.value = '';
  manualPublisher.value = '';
  manualIsbn.value = '';
  manualModalOpen.value = true;
}

function handlePickerDetected(isbn13: string): void {
  manualIsbn.value = isbn13;
  pickerCameraOpen.value = false;
}

async function submitManualBnf(): Promise<void> {
  if (!props.item) return;
  retryingBnf.value = true;
  try {
    const res = await scanStore.retryPhotoItemBnf(props.jobId, props.item.id, {
      title: manualTitle.value.trim() || undefined,
      series: manualSeries.value.trim() || undefined,
      volumeNumber: manualVolume.value.trim() || undefined,
      author: manualAuthor.value.trim() || undefined,
      publisher: manualPublisher.value.trim() || undefined,
      isbn: manualIsbn.value.trim() || undefined
    });
    manualModalOpen.value = false;
    uiStore.pushToast(
      res.item.options.length > 0 ? t('scan.photoRetryBnfSuccess') : t('scan.photoRetryBnfNone'),
      res.item.options.length > 0 ? 'success' : 'warning'
    );
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    retryingBnf.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open && Boolean(item)"
    :title="item?.hint.title || t('app.untitled')"
    max-width="680px"
    @close="emit('close')"
  >
    <div v-if="item" class="ds-stack">
      <!-- Aperçu zoomable (100 % à 450 %) -->
      <div v-if="previewUrl" class="ds-stack">
        <div class="ds-row ds-row--between">
          <div class="ds-row">
            <button type="button" class="ds-btn ds-btn--sm" @click="adjustZoom(-50)">−</button>
            <button type="button" class="ds-btn ds-btn--sm" @click="zoomPercent = 100">
              {{ zoomPercent }} %
            </button>
            <button type="button" class="ds-btn ds-btn--sm" @click="adjustZoom(50)">+</button>
          </div>
          <label class="ds-checkbox">
            <input
              type="checkbox"
              :checked="item.ignored"
              :disabled="saving"
              @change="patchItem({ ignored: ($event.target as HTMLInputElement).checked })"
            />
            <span>{{ t('scan.photoIgnoreToggle') }}</span>
          </label>
        </div>

        <div class="photo-zoom-box" @wheel="handleWheelZoom">
          <img
            :src="previewUrl"
            :alt="item.hint.title"
            class="photo-zoom-img"
            :style="{ width: `${zoomPercent}%` }"
          />
        </div>
      </div>

      <!-- Éditions candidates (radio) -->
      <div v-if="item.options.length > 0" class="ds-stack">
        <strong class="ds-label">{{ t('scan.photoSelectOptionLabel') }}</strong>
        <label
          v-for="opt in item.options"
          :key="opt.isbn13"
          class="ds-panel photo-option-row"
          :class="{ 'photo-option-row--active': item.selectedOptionIsbn13 === opt.isbn13 }"
        >
          <input
            type="radio"
            :name="`photo-opt-${item.id}`"
            :value="opt.isbn13"
            :checked="item.selectedOptionIsbn13 === opt.isbn13"
            :disabled="saving"
            @change="patchItem({ selectedOptionIsbn13: opt.isbn13, selected: true, ignored: false })"
          />
          <div class="photo-option-row__meta">
            <strong>{{ opt.title }}</strong>
            <p class="ds-text-muted">
              <span v-if="opt.seriesName">{{ opt.seriesName }}</span>
              <span v-if="opt.volumeNumber"> T.{{ opt.volumeNumber }}</span>
              <span v-if="opt.authors.length > 0"> · {{ opt.authors.join(', ') }}</span>
              <span v-if="opt.publisher"> · {{ opt.publisher }}</span>
              <span> · {{ opt.isbn13 }}</span>
            </p>
          </div>
        </label>
      </div>

      <!-- Intégrale optionnelle -->
      <IntegralFields
        :is-integral="item.isIntegral"
        :included-volumes="item.includedVolumes"
        @update:is-integral="(val) => patchItem({ isIntegral: val })"
        @update:included-volumes="(vols) => patchItem({ includedVolumes: vols })"
      />

      <!-- Bouton explicite de relance manuelle BnF serveur -->
      <button type="button" class="ds-btn" @click="openManualBnfModal">
        {{ t('scan.wrongReferenceBtn') }}
      </button>
    </div>

    <template #footer>
      <button type="button" class="ds-btn ds-btn--primary" @click="emit('close')">
        {{ t('app.close') }}
      </button>
    </template>
  </BaseModal>

  <!-- Sous-modale 6 champs vides + caméra ISBN (relance BnF 100 % serveur) -->
  <BaseModal
    :open="manualModalOpen"
    :title="t('scan.manualSearchTitle')"
    max-width="560px"
    @close="manualModalOpen = false"
  >
    <form id="manual-bnf-retry-form" class="ds-stack" @submit.prevent="submitManualBnf">
      <p class="ds-text-muted">{{ t('scan.photoManualHintDesc') }}</p>

      <div class="manual-field-row">
        <div class="ds-field manual-field-grow">
          <label class="ds-label" for="m-bnf-title">{{ t('scan.fieldTitle') }}</label>
          <input id="m-bnf-title" v-model="manualTitle" type="text" class="ds-input" />
        </div>
        <button
          v-if="manualTitle"
          type="button"
          class="ds-btn ds-btn--ghost ds-btn--sm manual-clear-btn"
          :aria-label="t('scan.clearField')"
          @click="manualTitle = ''"
        >
          ✕
        </button>
      </div>

      <div class="ds-grid-2">
        <div class="manual-field-row">
          <div class="ds-field manual-field-grow">
            <label class="ds-label" for="m-bnf-series">{{ t('scan.fieldSeries') }}</label>
            <input id="m-bnf-series" v-model="manualSeries" type="text" class="ds-input" />
          </div>
          <button
            v-if="manualSeries"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm manual-clear-btn"
            :aria-label="t('scan.clearField')"
            @click="manualSeries = ''"
          >
            ✕
          </button>
        </div>

        <div class="manual-field-row">
          <div class="ds-field manual-field-grow">
            <label class="ds-label" for="m-bnf-vol">{{ t('scan.fieldVolume') }}</label>
            <input id="m-bnf-vol" v-model="manualVolume" type="text" class="ds-input" />
          </div>
          <button
            v-if="manualVolume"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm manual-clear-btn"
            :aria-label="t('scan.clearField')"
            @click="manualVolume = ''"
          >
            ✕
          </button>
        </div>
      </div>

      <div class="ds-grid-2">
        <div class="manual-field-row">
          <div class="ds-field manual-field-grow">
            <label class="ds-label" for="m-bnf-author">{{ t('scan.fieldAuthor') }}</label>
            <input id="m-bnf-author" v-model="manualAuthor" type="text" class="ds-input" />
          </div>
          <button
            v-if="manualAuthor"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm manual-clear-btn"
            :aria-label="t('scan.clearField')"
            @click="manualAuthor = ''"
          >
            ✕
          </button>
        </div>

        <div class="manual-field-row">
          <div class="ds-field manual-field-grow">
            <label class="ds-label" for="m-bnf-pub">{{ t('scan.fieldPublisher') }}</label>
            <input id="m-bnf-pub" v-model="manualPublisher" type="text" class="ds-input" />
          </div>
          <button
            v-if="manualPublisher"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm manual-clear-btn"
            :aria-label="t('scan.clearField')"
            @click="manualPublisher = ''"
          >
            ✕
          </button>
        </div>
      </div>

      <div class="manual-field-row">
        <div class="ds-field manual-field-grow">
          <label class="ds-label" for="m-bnf-isbn">{{ t('scan.fieldIsbn') }}</label>
          <input id="m-bnf-isbn" v-model="manualIsbn" type="text" class="ds-input" />
        </div>
        <button
          type="button"
          class="ds-btn ds-btn--sm manual-clear-btn"
          :aria-label="t('scan.cameraTitlePicker')"
          @click="pickerCameraOpen = true"
        >
          📷
        </button>
        <button
          v-if="manualIsbn"
          type="button"
          class="ds-btn ds-btn--ghost ds-btn--sm manual-clear-btn"
          :aria-label="t('scan.clearField')"
          @click="manualIsbn = ''"
        >
          ✕
        </button>
      </div>
    </form>

    <template #footer>
      <button type="button" class="ds-btn" :disabled="retryingBnf" @click="manualModalOpen = false">
        {{ t('app.cancel') }}
      </button>
      <button
        type="submit"
        form="manual-bnf-retry-form"
        class="ds-btn ds-btn--primary"
        :disabled="retryingBnf"
      >
        {{ retryingBnf ? t('app.loading') : t('scan.launchBnfSearch') }}
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
.photo-zoom-box {
  max-height: 280px;
  overflow: auto;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
}

.photo-zoom-img {
  display: block;
  height: auto;
}

.photo-option-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  cursor: pointer;
}

.photo-option-row--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.photo-option-row__meta {
  flex: 1;
}

.manual-field-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-1);
}

.manual-field-grow {
  flex: 1;
  margin-bottom: 0;
}

.manual-clear-btn {
  margin-bottom: 2px;
}
</style>
