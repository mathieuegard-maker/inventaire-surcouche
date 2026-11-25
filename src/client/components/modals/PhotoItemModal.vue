<!-- src/client/components/modals/PhotoItemModal.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import PhotoLightboxModal from '../base/PhotoLightboxModal.vue';
import BookLookupModal, { type BookLookupHints } from './BookLookupModal.vue';
import IntegralFields from '../books/IntegralFields.vue';
import {
  useScanStore,
  type PhotoCandidateOption,
  type PhotoCoverOption,
  type PhotoJobItem
} from '../../stores/scan.store';
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
const lightboxOpen = ref(false);
const saving = ref(false);
const loadingCovers = ref(false);
const loadedCoverSignature = ref<string | null>(null);

// Sous-modale partagée 6 champs vides pour relance BnF serveur
const manualModalOpen = ref(false);
const retryingBnf = ref(false);

const confidenceLabel = computed(() => {
  const conf = props.item?.hint.confidence;
  if (conf === 'high') return t('scan.photoConfidenceHigh');
  if (conf === 'low') return t('scan.photoConfidenceLow');
  return t('scan.photoConfidenceMedium');
});

const positionLabel = computed(() => {
  const idx = props.item?.spineIndex ?? props.item?.hint.spineIndex;
  const total = props.item?.totalSpines;
  if (!idx || !total || total <= 1) return '';
  const fromRight = Math.max(1, total - idx + 1);
  return t('scan.photoPositionLabel', { left: idx, right: fromRight, total });
});

function isOptionSelected(opt: PhotoCandidateOption): boolean {
  const sel = props.item?.selectedOptionIsbn13;
  if (!sel) return false;
  return opt.isbn13 === sel || (opt.siblingIsbns ?? []).includes(sel);
}

const activeOption = computed<PhotoCandidateOption | null>(() => {
  if (!props.item || props.item.options.length === 0) return null;
  return props.item.options.find((o) => isOptionSelected(o)) ?? props.item.options[0];
});

const coverGallery = computed<PhotoCoverOption[]>(() => {
  const opt = activeOption.value;
  if (!opt) return [];
  const out: PhotoCoverOption[] = [];
  const seen = new Set<string>();
  const push = (cov: PhotoCoverOption) => {
    if (!cov.coverUrl || seen.has(cov.coverUrl)) return;
    seen.add(cov.coverUrl);
    out.push(cov);
  };
  for (const cov of opt.coverOptions ?? []) {
    push(cov);
  }
  if (opt.coverUrl) {
    push({
      coverKey: opt.coverUrl.startsWith('/api/covers/') ? opt.coverUrl.slice('/api/covers/'.length) : null,
      coverUrl: opt.coverUrl,
      label: opt.publisher || opt.title,
      isbn13: opt.isbn13
    });
  }
  if (props.item?.selectedCoverUrl) {
    push({
      coverKey: props.item.selectedCoverKey ?? null,
      coverUrl: props.item.selectedCoverUrl,
      label: t('scan.photoCoverSelectedBadge'),
      isbn13: opt.isbn13
    });
  }
  return out;
});

function isCoverSelected(cov: PhotoCoverOption, idx: number): boolean {
  if (!props.item) return false;
  if (props.item.selectedCoverKey && cov.coverKey) {
    return props.item.selectedCoverKey === cov.coverKey;
  }
  if (props.item.selectedCoverUrl) {
    return props.item.selectedCoverUrl === cov.coverUrl;
  }
  return idx === 0;
}

async function loadItemCovers(refresh = false): Promise<void> {
  if (!props.item || !activeOption.value) return;
  const sig = `${props.item.id}:${activeOption.value.isbn13}`;
  if (!refresh && loadedCoverSignature.value === sig) return;
  if (!refresh && (activeOption.value.coverOptions?.length ?? 0) >= 2 && activeOption.value.source === 'local') {
    loadedCoverSignature.value = sig;
    return;
  }
  loadedCoverSignature.value = sig;
  loadingCovers.value = true;
  try {
    await scanStore.fetchPhotoItemCovers(props.jobId, props.item.id, {
      isbn13: activeOption.value.isbn13,
      refresh
    });
  } catch {
    // non bloquant : la couverture principale reste affichée
  } finally {
    loadingCovers.value = false;
  }
}

watch(
  () => [props.open, props.item?.id, activeOption.value?.isbn13] as const,
  ([isOpen, itemId, optIsbn], [, prevItemId]) => {
    if (isOpen) {
      if (itemId !== prevItemId) {
        zoomPercent.value = 100;
        lightboxOpen.value = false;
        loadedCoverSignature.value = null;
      }
      if (itemId && optIsbn) {
        void loadItemCovers(false);
      }
    }
  },
  { immediate: true }
);

function adjustZoom(delta: number): void {
  zoomPercent.value = Math.min(450, Math.max(100, zoomPercent.value + delta));
}

function handleWheelZoom(event: WheelEvent): void {
  if (!props.previewUrl) return;
  event.preventDefault();
  adjustZoom(event.deltaY < 0 ? 25 : -25);
}

async function patchItem(
  patch: {
    selected?: boolean;
    ignored?: boolean;
    selectedOptionIsbn13?: string | null;
    selectedCoverKey?: string | null;
    selectedCoverUrl?: string | null;
    isIntegral?: boolean;
    includedVolumes?: string[];
  },
  toastKind: 'none' | 'option' | 'cover' = 'none'
): Promise<void> {
  if (!props.item) return;
  saving.value = true;
  try {
    await scanStore.updatePhotoItem(props.jobId, props.item.id, patch);
    if (toastKind === 'option') {
      uiStore.pushToast(t('scan.photoOptionSavedToast'), 'success', 1800);
    } else if (toastKind === 'cover') {
      uiStore.pushToast(t('scan.photoCoverSavedToast'), 'success', 1800);
    }
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    saving.value = false;
  }
}

function selectCover(cov: PhotoCoverOption): void {
  void patchItem(
    {
      selectedCoverKey: cov.coverKey,
      selectedCoverUrl: cov.coverUrl,
      selected: true,
      ignored: false
    },
    'cover'
  );
}

function openManualBnfModal(): void {
  manualModalOpen.value = true;
}

async function submitManualBnf(hints: BookLookupHints): Promise<void> {
  if (!props.item) return;
  retryingBnf.value = true;
  try {
    const res = await scanStore.retryPhotoItemBnf(props.jobId, props.item.id, hints);
    manualModalOpen.value = false;
    loadedCoverSignature.value = null;
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
      <!-- Retour brut de l'analyse IA (pour comparer avec la photo et les éditions proposées) -->
      <div class="ds-panel ds-stack ai-hint-panel">
        <div class="ds-row ds-row--between">
          <strong>{{ t('scan.photoAiReadTitle') }}</strong>
          <span class="ds-badge ds-badge--accent">
            {{ t('scan.photoConfidenceLabel') }} : {{ confidenceLabel }}
          </span>
        </div>

        <div v-if="positionLabel" class="ds-badge">
          {{ positionLabel }}
        </div>

        <dl class="ai-hint-grid">
          <div v-if="item.hint.rawText" class="ai-hint-field ai-hint-field--full">
            <dt class="ds-text-muted">{{ t('scan.photoRawTextLabel') }}</dt>
            <dd>{{ item.hint.rawText }}</dd>
          </div>
          <div v-if="item.hint.title" class="ai-hint-field">
            <dt class="ds-text-muted">{{ t('scan.fieldTitle') }}</dt>
            <dd>{{ item.hint.title }}</dd>
          </div>
          <div v-if="item.hint.series" class="ai-hint-field">
            <dt class="ds-text-muted">{{ t('scan.fieldSeries') }}</dt>
            <dd>{{ item.hint.series }}</dd>
          </div>
          <div v-if="item.hint.volumeNumber" class="ai-hint-field">
            <dt class="ds-text-muted">{{ t('scan.fieldVolume') }}</dt>
            <dd>{{ item.hint.volumeNumber }}</dd>
          </div>
          <div v-if="item.hint.author" class="ai-hint-field">
            <dt class="ds-text-muted">{{ t('scan.fieldAuthor') }}</dt>
            <dd>{{ item.hint.author }}</dd>
          </div>
          <div v-if="item.hint.publisher" class="ai-hint-field">
            <dt class="ds-text-muted">{{ t('scan.fieldPublisher') }}</dt>
            <dd>{{ item.hint.publisher }}</dd>
          </div>
          <div v-if="item.hint.isbn" class="ai-hint-field">
            <dt class="ds-text-muted">{{ t('scan.fieldIsbn') }}</dt>
            <dd>{{ item.hint.isbn }}</dd>
          </div>
        </dl>
      </div>

      <!-- Aperçu photo cliquable -> plein écran tactile (zoom 2 doigts + déplacement) -->
      <div v-if="previewUrl" class="ds-stack">
        <div class="ds-row ds-row--between photo-controls-bar">
          <div class="ds-row">
            <button type="button" class="ds-btn ds-btn--sm" @click="adjustZoom(-50)">−</button>
            <button type="button" class="ds-btn ds-btn--sm" @click="zoomPercent = 100">
              {{ zoomPercent }} %
            </button>
            <button type="button" class="ds-btn ds-btn--sm" @click="adjustZoom(50)">+</button>
            <button type="button" class="ds-btn ds-btn--primary ds-btn--sm" @click="lightboxOpen = true">
              {{ t('scan.photoOpenFullscreenBtn') }}
            </button>
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

        <button
          type="button"
          class="photo-zoom-box"
          :aria-label="t('scan.photoOpenFullscreenBtn')"
          @click="lightboxOpen = true"
          @wheel="handleWheelZoom"
        >
          <img
            :src="previewUrl"
            :alt="item.hint.title"
            class="photo-zoom-img"
            :style="{ width: `${zoomPercent}%` }"
          />
        </button>
        <p class="ds-text-muted photo-tap-hint">{{ t('scan.photoTapToExpandHint') }}</p>
      </div>

      <!-- Œuvre abstraite reconnue (ou choix entre plusieurs œuvres distinctes) -->
      <div v-if="item.options.length > 0" class="ds-stack">
        <strong class="ds-label">
          {{ item.options.length === 1 ? t('scan.photoWorkRecognizedLabel') : t('scan.photoSelectWorkLabel') }}
        </strong>
        <label
          v-for="opt in item.options"
          :key="opt.isbn13"
          class="ds-panel photo-option-row"
          :class="{ 'photo-option-row--active': isOptionSelected(opt) }"
        >
          <input
            v-if="item.options.length > 1"
            type="radio"
            :name="`photo-opt-${item.id}`"
            :value="opt.isbn13"
            :checked="isOptionSelected(opt)"
            :disabled="saving"
            @change="patchItem({ selectedOptionIsbn13: opt.isbn13, selected: true, ignored: false }, 'option')"
          />

          <div class="photo-option-cover">
            <img
              v-if="isOptionSelected(opt) ? (item.selectedCoverUrl || opt.coverUrl) : opt.coverUrl"
              :src="(isOptionSelected(opt) ? (item.selectedCoverUrl || opt.coverUrl) : opt.coverUrl) || ''"
              :alt="opt.title"
              loading="lazy"
            />
            <span v-else class="photo-option-cover__empty">{{ opt.title.slice(0, 2).toUpperCase() }}</span>
          </div>

          <div class="photo-option-row__meta">
            <div class="ds-row photo-option-badges">
              <strong>{{ opt.title }}</strong>
              <span v-if="opt.source === 'local'" class="ds-badge ds-badge--success">
                {{ t('scan.photoLocalCatalogBadge') }}
              </span>
              <span v-if="opt.isIntegral" class="ds-badge ds-badge--accent">
                {{ t('book.integralLabel') }}
              </span>
              <span v-if="(opt.editionCount ?? 1) > 1" class="ds-badge">
                {{ t('scan.photoEditionsGroupedBadge', { count: opt.editionCount! }) }}
              </span>
            </div>
            <p class="ds-text-muted">
              <span v-if="opt.seriesName">{{ opt.seriesName }}</span>
              <span v-if="opt.volumeNumber"> T.{{ opt.volumeNumber }}</span>
              <span v-if="opt.authors.length > 0"> · {{ opt.authors.join(', ') }}</span>
              <span v-if="opt.publisher"> · {{ opt.publisher }}</span>
              <span v-if="opt.publishYear"> ({{ opt.publishYear }})</span>
            </p>
          </div>
        </label>
      </div>

      <!-- Sélecteur visuel de couvertures multi-éditions (Couche 3 Foyer) -->
      <div v-if="activeOption" class="ds-panel ds-stack photo-cover-picker">
        <div class="ds-row ds-row--between photo-cover-picker__header">
          <div class="ds-stack photo-cover-picker__title">
            <strong>{{ t('scan.photoCoverPickerTitle') }}</strong>
            <span class="ds-text-muted photo-cover-picker__hint">{{ t('scan.photoCoverPickerHint') }}</span>
          </div>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="loadingCovers || saving"
            @click="loadItemCovers(true)"
          >
            {{ loadingCovers ? t('app.loading') : t('scan.photoCoverPickerMoreBtn') }}
          </button>
        </div>

        <p v-if="loadingCovers && coverGallery.length <= 1" class="ds-text-muted photo-cover-picker__hint">
          {{ t('scan.photoCoverPickerLoading') }}
        </p>

        <div v-if="coverGallery.length > 0" class="photo-cover-grid">
          <button
            v-for="(cov, idx) in coverGallery"
            :key="cov.coverUrl"
            type="button"
            class="photo-cover-tile"
            :class="{ 'photo-cover-tile--active': isCoverSelected(cov, idx) }"
            :disabled="saving"
            :title="cov.label"
            @click="selectCover(cov)"
          >
            <img :src="cov.coverUrl" :alt="cov.label" loading="lazy" />
            <span v-if="isCoverSelected(cov, idx)" class="photo-cover-tile__badge">
              {{ t('scan.photoCoverSelectedBadge') }}
            </span>
            <span class="photo-cover-tile__label">{{ cov.label }}</span>
          </button>
        </div>
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
      <button type="button" class="ds-btn ds-btn--primary" :disabled="saving" @click="emit('close')">
        {{ saving ? t('app.loading') : t('app.close') }}
      </button>
    </template>
  </BaseModal>

  <!-- Visionneuse photo plein écran tactile (pinch-to-zoom 2 doigts + pan) -->
  <PhotoLightboxModal
    :open="lightboxOpen"
    :src="previewUrl"
    :alt="item?.hint.title"
    @close="lightboxOpen = false"
  />

  <!-- Sous-modale partagée 6 champs + caméra ISBN -->
  <BookLookupModal
    :open="manualModalOpen"
    mode="retry"
    :busy="retryingBnf"
    @close="manualModalOpen = false"
    @submit-hints="submitManualBnf"
  />
</template>

<style scoped>
.ai-hint-panel {
  gap: var(--space-2);
}

.ai-hint-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-2);
  margin: 0;
}

.ai-hint-field dt {
  font-size: 0.75rem;
}

.ai-hint-field dd {
  margin: 0;
  font-weight: 600;
}

.ai-hint-field--full {
  grid-column: 1 / -1;
}

.photo-controls-bar {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.photo-zoom-box {
  display: block;
  width: 100%;
  padding: 0;
  max-height: 260px;
  overflow: auto;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  cursor: zoom-in;
}

.photo-zoom-img {
  display: block;
  height: auto;
}

.photo-tap-hint {
  font-size: 0.8rem;
  margin: 0;
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

.photo-option-cover {
  width: 48px;
  min-width: 48px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
}

.photo-option-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.photo-option-cover__empty {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--text-muted);
}

.photo-option-row__meta {
  flex: 1;
  min-width: 0;
}

.photo-option-badges {
  flex-wrap: wrap;
  gap: var(--space-1);
}

.photo-cover-picker {
  gap: var(--space-2);
}

.photo-cover-picker__header {
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: flex-start;
}

.photo-cover-picker__title {
  gap: 2px;
  flex: 1;
  min-width: 180px;
}

.photo-cover-picker__hint {
  font-size: 0.8rem;
  margin: 0;
}

.photo-cover-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: var(--space-2);
}

.photo-cover-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-md);
  border: 2px solid var(--border-subtle);
  background: var(--bg-elevated);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.photo-cover-tile:hover {
  border-color: var(--accent);
}

.photo-cover-tile--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.photo-cover-tile img {
  width: 100%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border-radius: var(--radius-sm);
  display: block;
}

.photo-cover-tile__badge {
  position: absolute;
  top: 6px;
  left: 6px;
  right: 6px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 0.68rem;
  font-weight: 700;
  text-align: center;
}

.photo-cover-tile__label {
  font-size: 0.72rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
