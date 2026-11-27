<!-- src/client/components/modals/PhotoItemModal.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Ban, Expand, Search } from '@lucide/vue';
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

const lightboxOpen = ref(false);
const saving = ref(false);
const loadingCovers = ref(false);
const loadedCoverSignature = ref<string | null>(null);

const manualModalOpen = ref(false);
const retryingBnf = ref(false);

const confidenceLabel = computed(() => {
  const conf = props.item?.hint.confidence;
  if (conf === 'high') return t('scan.photoConfidenceHigh');
  if (conf === 'low') return t('scan.photoConfidenceLow');
  return t('scan.photoConfidenceMedium');
});

const compactReadSummary = computed(() => {
  if (!props.item) return '';
  const h = props.item.hint;
  const parts: string[] = [];
  if (h.series && h.series.toLowerCase() !== h.title.toLowerCase()) parts.push(h.series);
  if (h.volumeNumber) parts.push(`T.${h.volumeNumber}`);
  if (h.author) parts.push(h.author);
  if (h.publisher) parts.push(h.publisher);
  if (h.isbn) parts.push(h.isbn);
  return parts.join(' · ');
});

function isOptionSelected(opt: PhotoCandidateOption): boolean {
  if (!props.item || props.item.ignored) return false;
  const sel = props.item.selectedOptionIsbn13;
  if (!sel) return false;
  return opt.isbn13 === sel || (opt.siblingIsbns ?? []).includes(sel);
}

const activeOption = computed<PhotoCandidateOption | null>(() => {
  if (!props.item || props.item.ignored || props.item.options.length === 0) return null;
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
    // non bloquant
  } finally {
    loadingCovers.value = false;
  }
}

watch(
  () => [props.open, props.item?.id, activeOption.value?.isbn13] as const,
  ([isOpen, itemId, optIsbn], [, prevItemId]) => {
    if (isOpen) {
      if (itemId !== prevItemId) {
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

async function patchItem(
  patch: {
    selected?: boolean;
    ignored?: boolean;
    selectedOptionIsbn13?: string | null;
    selectedCoverKey?: string | null;
    selectedCoverUrl?: string | null;
    isIntegral?: boolean;
    integralMode?: 'create_separate' | 'convert_self';
    includedVolumes?: string[];
  }
): Promise<void> {
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

function toggleIgnored(): void {
  if (!props.item) return;
  const nextIgnored = !props.item.ignored;
  void patchItem({
    ignored: nextIgnored,
    selected: nextIgnored ? false : Boolean(props.item.selectedOptionIsbn13)
  });
}

function selectCover(cov: PhotoCoverOption): void {
  void patchItem({
    selectedCoverKey: cov.coverKey,
    selectedCoverUrl: cov.coverUrl,
    selected: true,
    ignored: false
  });
}

async function submitManualBnf(hints: BookLookupHints): Promise<void> {
  if (!props.item) return;
  retryingBnf.value = true;
  try {
    const res = await scanStore.retryPhotoItemBnf(props.jobId, props.item.id, hints);
    manualModalOpen.value = false;
    loadedCoverSignature.value = null;
    if (res.item.options.length === 0) {
      uiStore.pushToast(t('scan.photoRetryBnfNone'), 'warning');
    }
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
    max-width="640px"
    @close="emit('close')"
  >
    <div v-if="item" class="ds-stack">
      <!-- Bloc « Ce que l'IA a lu » condensé avec miniature photo cliquable intégrée -->
      <div class="ds-panel ai-read-compact">
        <div class="ai-read-compact__body">
          <div class="ds-row ds-row--between">
            <strong class="ai-read-compact__heading">{{ t('scan.photoAiReadTitle') }}</strong>
            <div class="ds-row">
              <span v-if="item.alreadyStatus === 'owned'" class="ds-badge ds-badge--success">
                {{ t('book.statusOwned') }}
              </span>
              <span v-else-if="item.alreadyStatus === 'wish'" class="ds-badge ds-badge--accent">
                {{ t('book.statusWished') }}
              </span>
              <span class="ds-badge ds-badge--accent">
                {{ t('scan.photoConfidenceLabel') }} : {{ confidenceLabel }}
              </span>
            </div>
          </div>

          <p v-if="item.hint.rawText" class="ai-read-compact__raw">
            « {{ item.hint.rawText }} »
          </p>
          <p v-if="compactReadSummary" class="ds-text-muted ai-read-compact__meta">
            {{ compactReadSummary }}
          </p>
        </div>

        <button
          v-if="previewUrl"
          type="button"
          class="ai-read-compact__thumb"
          :aria-label="t('scan.photoOpenFullscreenBtn')"
          @click="lightboxOpen = true"
        >
          <img :src="previewUrl" :alt="item.hint.title" />
          <span class="ai-read-compact__thumb-badge" aria-hidden="true">
            <Expand :size="13" />
          </span>
        </button>
      </div>

      <!-- Œuvres candidates : 1re ligne = « Ignorer cette œuvre » -->
      <div class="ds-stack--sm">
        <strong class="ds-label">
          {{ item.options.length <= 1 ? t('scan.photoWorkRecognizedLabel') : t('scan.photoSelectWorkLabel') }}
        </strong>

        <label
          class="ds-radio-option photo-ignore-option"
          :class="{ 'photo-ignore-option--active': item.ignored }"
        >
          <input
            type="checkbox"
            :checked="item.ignored"
            :disabled="saving"
            @change="toggleIgnored"
          />
          <span class="ds-radio-option__body">
            <span class="ds-row">
              <Ban :size="15" aria-hidden="true" />
              <strong>{{ t('scan.photoIgnoreToggle') }}</strong>
            </span>
          </span>
        </label>

        <label
          v-for="opt in item.options"
          :key="opt.isbn13"
          class="ds-radio-option photo-option-row"
          :class="{ 'photo-option-row--active': isOptionSelected(opt) }"
        >
          <input
            type="radio"
            :name="`photo-opt-${item.id}`"
            :value="opt.isbn13"
            :checked="isOptionSelected(opt)"
            :disabled="saving"
            @change="patchItem({ selectedOptionIsbn13: opt.isbn13, selected: true, ignored: false })"
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
            <p class="ds-text-muted photo-option-row__sub">
              <span v-if="opt.seriesName">{{ opt.seriesName }}</span>
              <span v-if="opt.volumeNumber"> T.{{ opt.volumeNumber }}</span>
              <span v-if="opt.authors.length > 0"> · {{ opt.authors.join(', ') }}</span>
              <span v-if="opt.publisher"> · {{ opt.publisher }}</span>
              <span v-if="opt.publishYear"> ({{ opt.publishYear }})</span>
            </p>
          </div>
        </label>
      </div>

      <!-- Choisir la couverture (sans jargon foyer) -->
      <div v-if="activeOption" class="ds-panel ds-stack--sm photo-cover-picker">
        <div class="ds-row ds-row--between">
          <strong>{{ t('scan.photoCoverPickerTitle') }}</strong>
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

      <!-- Format de l'ouvrage (Tome / Intégrale + mode non destructif par défaut) -->
      <div v-if="!item.ignored" class="ds-stack--sm">
        <IntegralFields
          :is-integral="item.isIntegral"
          :included-volumes="item.includedVolumes"
          @update:is-integral="
            (val) =>
              patchItem({
                isIntegral: val,
                ...(val && !activeOption?.isIntegral
                  ? { integralMode: item.integralMode ?? 'create_separate' }
                  : {})
              })
          "
          @update:included-volumes="(vols) => patchItem({ includedVolumes: vols })"
        />

        <div v-if="item.isIntegral && !activeOption?.isIntegral" class="ds-panel ds-stack--sm">
          <label class="ds-radio-option">
            <input
              type="radio"
              :name="`photo-int-mode-${item.id}`"
              value="create_separate"
              :checked="(item.integralMode ?? 'create_separate') === 'create_separate'"
              :disabled="saving"
              @change="patchItem({ integralMode: 'create_separate' })"
            />
            <span class="ds-radio-option__body">
              <span>{{ t('book.integralCreateSeparateMode') }}</span>
            </span>
          </label>
          <label class="ds-radio-option">
            <input
              type="radio"
              :name="`photo-int-mode-${item.id}`"
              value="convert_self"
              :checked="item.integralMode === 'convert_self'"
              :disabled="saving"
              @change="patchItem({ integralMode: 'convert_self' })"
            />
            <span class="ds-radio-option__body">
              <span>{{ t('book.integralConvertSelfMode') }}</span>
            </span>
          </label>
          <p
            v-if="(item.integralMode ?? 'create_separate') === 'create_separate'"
            class="ds-text-muted photo-integral-hint"
          >
            {{ t('book.integralSeparateHint') }}
          </p>
        </div>
      </div>

      <!-- Ce n'est pas le bon livre -->
      <button type="button" class="ds-btn" @click="manualModalOpen = true">
        <Search :size="16" aria-hidden="true" />
        <span>{{ t('scan.wrongReferenceBtn') }}</span>
      </button>
    </div>

    <template #footer>
      <button type="button" class="ds-btn ds-btn--primary" :disabled="saving" @click="emit('close')">
        {{ saving ? t('app.loading') : t('app.close') }}
      </button>
    </template>
  </BaseModal>

  <!-- Visionneuse photo plein écran dédiée (zoom, pourcentage et consignes ici uniquement) -->
  <PhotoLightboxModal
    :open="lightboxOpen"
    :src="previewUrl"
    :alt="item?.hint.title"
    @close="lightboxOpen = false"
  />

  <!-- Sous-modale recherche manuelle -->
  <BookLookupModal
    :open="manualModalOpen"
    mode="retry"
    :busy="retryingBnf"
    @close="manualModalOpen = false"
    @submit-hints="submitManualBnf"
  />
</template>

<style scoped>
.ai-read-compact {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.ai-read-compact__body {
  flex: 1;
  min-inline-size: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ai-read-compact__heading {
  font-size: 0.88rem;
}

.ai-read-compact__raw {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-primary);
}

.ai-read-compact__meta {
  margin: 0;
  font-size: 0.8rem;
}

.ai-read-compact__thumb {
  position: relative;
  width: 68px;
  height: 88px;
  flex-shrink: 0;
  padding: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  cursor: zoom-in;
}

.ai-read-compact__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.ai-read-compact__thumb-badge {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  background: var(--bg-backdrop);
  color: var(--accent-contrast);
}

.photo-ignore-option--active {
  border-color: var(--danger);
  background: var(--danger-soft);
  color: var(--danger);
}

.photo-option-row {
  align-items: center;
}

.photo-option-cover {
  width: 44px;
  min-width: 44px;
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
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-muted);
}

.photo-option-row__meta {
  flex: 1;
  min-width: 0;
}

.photo-option-row__sub {
  margin: 2px 0 0;
  font-size: 0.82rem;
}

.photo-option-badges {
  flex-wrap: wrap;
  gap: var(--space-1);
}

.photo-cover-picker__hint {
  font-size: 0.8rem;
  margin: 0;
}

.photo-cover-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
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
  background: var(--bg-surface);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease;
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

.photo-integral-hint {
  margin: 0;
  font-size: 0.8rem;
}
</style>
