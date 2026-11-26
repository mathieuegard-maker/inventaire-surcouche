<!-- src/client/components/books/CoverPicker.vue -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useLibraryStore, type CoverCandidateItem } from '../../stores/library.store';
import { useUiStore } from '../../stores/ui.store';
import { ApiClientError } from '../../api/client';
import type {
  CoverCandidateEditionMeta,
  SeriesCoverPropagationScope,
  SeriesEditionCoverPreviewResponse
} from '../../../shared/types/domain.types';
import { t } from '../../../shared/locales';

export interface CoverPropagationPlan {
  scope: SeriesCoverPropagationScope;
  selectedBookIds: string[];
  targetEdition: CoverCandidateEditionMeta | null;
  searchMissingInBackground: boolean;
  readySelectedCount: number;
  missingSelectedCount: number;
}

const props = defineProps<{
  bookId?: string;
  seriesId?: string | null;
  modelValue: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', coverKey: string | null): void;
  (e: 'update:propagationPlan', plan: CoverPropagationPlan): void;
}>();

const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const fileInputRef = ref<HTMLInputElement | null>(null);
const urlInput = ref('');
const candidates = ref<CoverCandidateItem[]>([]);
const busy = ref(false);
const searchingExternal = ref(false);

// État de propagation d'édition dans la série
const selectedEdition = ref<CoverCandidateEditionMeta | null>(null);
const scope = ref<SeriesCoverPropagationScope>('single');
const selectedVolumeIds = ref<Set<string>>(new Set());
const searchMissingInBackground = ref(true);
const previewLoading = ref(false);
const previewData = ref<SeriesEditionCoverPreviewResponse | null>(null);
const previewCache = new Map<string, SeriesEditionCoverPreviewResponse>();

const canPropagateToSeries = computed(() =>
  Boolean(props.bookId && props.seriesId && selectedEdition.value)
);

const targetedItems = computed(() => {
  const items = previewData.value?.items ?? [];
  if (scope.value === 'all') return items;
  if (scope.value === 'selected') return items.filter((item) => selectedVolumeIds.value.has(item.bookId));
  return [];
});

const readySelectedCount = computed(
  () => targetedItems.value.filter((item) => item.matchStatus === 'ready' || item.matchStatus === 'same').length
);

const missingSelectedCount = computed(
  () => targetedItems.value.filter((item) => item.matchStatus === 'missing').length
);

function emitPlan(): void {
  emit('update:propagationPlan', {
    scope: canPropagateToSeries.value ? scope.value : 'single',
    selectedBookIds: Array.from(selectedVolumeIds.value),
    targetEdition: selectedEdition.value,
    searchMissingInBackground: searchMissingInBackground.value,
    readySelectedCount: readySelectedCount.value,
    missingSelectedCount: missingSelectedCount.value
  });
}

watch([scope, selectedVolumeIds, selectedEdition, searchMissingInBackground, previewData], emitPlan, {
  deep: true
});

async function loadSeriesPreview(edition: CoverCandidateEditionMeta): Promise<void> {
  if (!props.seriesId || !props.bookId) {
    previewData.value = null;
    return;
  }

  const cacheKey = `${props.seriesId}|${props.bookId}|${edition.lineageKey}`;
  const cached = previewCache.get(cacheKey);
  if (cached) {
    previewData.value = cached;
    initDefaultSelectedVolumes(cached);
    return;
  }

  previewLoading.value = true;
  try {
    const res = await libraryStore.previewSeriesEditionCovers(props.seriesId, props.bookId, {
      isbn13: edition.isbn13 ?? null,
      publisher: edition.publisher ?? null,
      collectionName: edition.collectionName ?? null,
      isbnPrefix: edition.isbnPrefix ?? null,
      lineageKey: edition.lineageKey,
      label: edition.lineageLabel
    });
    previewCache.set(cacheKey, res);
    previewData.value = res;
    initDefaultSelectedVolumes(res);
  } catch {
    previewData.value = null;
  } finally {
    previewLoading.value = false;
  }
}

function initDefaultSelectedVolumes(preview: SeriesEditionCoverPreviewResponse): void {
  // Pré-sélectionne par défaut les tomes disponibles (ou tous si aucun n'est encore en cache local)
  const readyIds = preview.items
    .filter((i) => i.matchStatus === 'ready' || i.matchStatus === 'same')
    .map((i) => i.bookId);
  selectedVolumeIds.value = new Set(readyIds.length > 0 ? readyIds : preview.items.map((i) => i.bookId));
}

function toggleVolumeSelection(bookId: string): void {
  const next = new Set(selectedVolumeIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedVolumeIds.value = next;
}

function selectAllVolumes(): void {
  const items = previewData.value?.items ?? [];
  selectedVolumeIds.value = new Set(items.map((i) => i.bookId));
}

function selectReadyVolumesOnly(): void {
  const items = previewData.value?.items ?? [];
  selectedVolumeIds.value = new Set(
    items.filter((i) => i.matchStatus === 'ready' || i.matchStatus === 'same').map((i) => i.bookId)
  );
}

function clearVolumeSelection(): void {
  selectedVolumeIds.value = new Set();
}

function clearEditionPropagation(): void {
  selectedEdition.value = null;
  previewData.value = null;
  scope.value = 'single';
  selectedVolumeIds.value = new Set();
}

async function loadCandidates(includeExternal = false): Promise<void> {
  if (!props.bookId) return;
  if (includeExternal) searchingExternal.value = true;
  try {
    candidates.value = await libraryStore.fetchCoverCandidates(props.bookId, includeExternal);
    // Synchronise l'édition si la couverture courante correspond déjà à une édition identifiable
    if (!selectedEdition.value && props.modelValue) {
      const currentMatch = candidates.value.find((c) => c.coverKey === props.modelValue && c.edition);
      if (currentMatch?.edition && props.seriesId) {
        selectedEdition.value = currentMatch.edition;
        void loadSeriesPreview(currentMatch.edition);
      }
    }
    if (includeExternal && candidates.value.length === 0) {
      uiStore.pushToast(t('book.noCoversFound'), 'info');
    }
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    searchingExternal.value = false;
  }
}

function triggerFileInput(): void {
  fileInputRef.value?.click();
}

async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  busy.value = true;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('FileReader error'));
      reader.readAsDataURL(file);
    });
    const stored = await libraryStore.uploadCoverDataUrl(dataUrl);
    // Photo personnelle : propre à ce tome uniquement (zéro propagation multi-tomes trompeuse)
    clearEditionPropagation();
    emit('update:modelValue', stored.coverKey);
    if (!candidates.value.some((c) => c.coverKey === stored.coverKey)) {
      candidates.value.unshift({
        id: stored.coverKey,
        kind: 'local',
        coverKey: stored.coverKey,
        url: stored.coverUrl,
        label: t('book.coverSectionTitle'),
        edition: null
      });
    }
    uiStore.pushToast(t('book.coverImportedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    busy.value = false;
    input.value = '';
  }
}

async function handleImportUrl(): Promise<void> {
  const cleanUrl = urlInput.value.trim();
  if (!cleanUrl) return;
  busy.value = true;
  try {
    const stored = await libraryStore.importCoverUrl(cleanUrl);
    // URL libre : propre à ce tome uniquement
    clearEditionPropagation();
    emit('update:modelValue', stored.coverKey);
    urlInput.value = '';
    if (!candidates.value.some((c) => c.coverKey === stored.coverKey)) {
      candidates.value.unshift({
        id: stored.coverKey,
        kind: 'local',
        coverKey: stored.coverKey,
        url: stored.coverUrl,
        label: t('book.coverSectionTitle'),
        edition: null
      });
    }
    uiStore.pushToast(t('book.coverImportedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    busy.value = false;
  }
}

async function selectCandidate(item: CoverCandidateItem): Promise<void> {
  if (item.kind === 'local' && item.coverKey) {
    emit('update:modelValue', item.coverKey);
    if (props.seriesId && item.edition) {
      const changedLineage = selectedEdition.value?.lineageKey !== item.edition.lineageKey;
      selectedEdition.value = item.edition;
      if (changedLineage) {
        scope.value = 'single';
      }
      void loadSeriesPreview(item.edition);
    } else {
      clearEditionPropagation();
    }
    return;
  }

  // Source externe -> téléchargement & compression WebP côté serveur
  busy.value = true;
  try {
    const stored = await libraryStore.importCoverUrl(item.url);
    item.kind = 'local';
    item.coverKey = stored.coverKey;
    item.url = stored.coverUrl;
    emit('update:modelValue', stored.coverKey);
    if (props.seriesId && item.edition) {
      selectedEdition.value = item.edition;
      scope.value = 'single';
      void loadSeriesPreview(item.edition);
    } else {
      clearEditionPropagation();
    }
    uiStore.pushToast(t('book.coverImportedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.seriesId,
  (nextSid) => {
    if (!nextSid) {
      clearEditionPropagation();
    } else if (selectedEdition.value) {
      void loadSeriesPreview(selectedEdition.value);
    }
  }
);

onMounted(() => {
  void loadCandidates(false);
});
</script>

<template>
  <div class="ds-panel ds-stack">
    <div class="ds-row ds-row--between">
      <strong class="ds-label">{{ t('book.coverSectionTitle') }}</strong>
      <div class="ds-row">
        <input
          ref="fileInputRef"
          type="file"
          accept="image/*"
          class="cover-file-hidden"
          @change="handleFileChange"
        />
        <button type="button" class="ds-btn ds-btn--sm" :disabled="busy" @click="triggerFileInput">
          {{ t('book.uploadCoverBtn') }}
        </button>
        <button
          v-if="bookId"
          type="button"
          class="ds-btn ds-btn--sm"
          :disabled="busy || searchingExternal"
          @click="loadCandidates(true)"
        >
          {{ searchingExternal ? t('app.loading') : t('book.findMoreCoversBtn') }}
        </button>
      </div>
    </div>

    <div class="ds-row">
      <div v-if="modelValue" class="cover-preview">
        <img :src="`/api/covers/${modelValue}`" :alt="t('book.coverSectionTitle')" />
      </div>

      <div class="cover-url-box ds-row">
        <input
          v-model="urlInput"
          type="url"
          class="ds-input cover-url-input"
          :placeholder="t('book.coverUrlPlaceholder')"
        />
        <button
          type="button"
          class="ds-btn ds-btn--sm"
          :disabled="busy || !urlInput.trim()"
          @click="handleImportUrl"
        >
          {{ t('book.importCoverUrlBtn') }}
        </button>
      </div>
    </div>

    <div v-if="candidates.length > 0" class="ds-stack">
      <span class="ds-text-muted">{{ t('book.coverGalleryTitle') }}</span>
      <div class="cover-gallery">
        <button
          v-for="item in candidates"
          :key="item.id"
          type="button"
          class="cover-thumb"
          :class="{ 'cover-thumb--active': item.coverKey && item.coverKey === modelValue }"
          :disabled="busy"
          :title="item.label"
          @click="selectCandidate(item)"
        >
          <span class="cover-thumb__img-wrap">
            <img :src="item.url" :alt="item.label" loading="lazy" referrerpolicy="no-referrer" />
          </span>
          <span class="cover-thumb__caption">{{ item.edition?.lineageLabel || item.label }}</span>
        </button>
      </div>
    </div>

    <!-- Portée de l'édition choisie dans la série (uniquement si couverture liée à une édition identifiable) -->
    <div v-if="canPropagateToSeries && selectedEdition" class="cover-scope ds-stack">
      <strong class="ds-label">
        {{ t('book.coverScopeTitle', { edition: selectedEdition.lineageLabel }) }}
      </strong>

      <p v-if="previewLoading" class="ds-text-muted">
        {{ t('book.coverScopeLoading') }}
      </p>

      <p v-else-if="previewData && previewData.totalCount === 0" class="ds-text-muted">
        {{ t('book.coverScopeNoOtherVolumes') }}
      </p>

      <template v-else-if="previewData">
        <div class="cover-scope__radios ds-stack">
          <label class="cover-scope__option">
            <input v-model="scope" type="radio" value="single" />
            <span>{{ t('book.coverScopeSingle') }}</span>
          </label>

          <label class="cover-scope__option">
            <input v-model="scope" type="radio" value="all" />
            <span class="cover-scope__option-body">
              <span>{{ t('book.coverScopeAll', { count: previewData.totalCount }) }}</span>
              <span class="ds-text-muted cover-scope__meta">
                {{
                  t('book.coverScopeAllSummary', {
                    ready: previewData.readyCount,
                    same: previewData.sameCount,
                    missing: previewData.missingCount
                  })
                }}
              </span>
            </span>
          </label>

          <label class="cover-scope__option">
            <input v-model="scope" type="radio" value="selected" />
            <span class="cover-scope__option-body">
              <span>{{ t('book.coverScopeSelected') }}</span>
              <span v-if="scope === 'selected'" class="ds-text-muted cover-scope__meta">
                {{ t('book.coverScopeSelectedCount', { count: selectedVolumeIds.size }) }}
              </span>
            </span>
          </label>
        </div>

        <!-- Sélecteur individuel de tomes avec aperçu visuel avant -> après -->
        <div v-if="scope === 'selected'" class="cover-scope__picker ds-stack">
          <div class="ds-row">
            <button type="button" class="ds-btn ds-btn--sm" @click="selectAllVolumes">
              {{ t('book.coverScopeSelectAll') }}
            </button>
            <button
              v-if="previewData.readyCount + previewData.sameCount > 0"
              type="button"
              class="ds-btn ds-btn--sm"
              @click="selectReadyVolumesOnly"
            >
              {{ t('book.coverScopeSelectReady', { count: previewData.readyCount + previewData.sameCount }) }}
            </button>
            <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="clearVolumeSelection">
              {{ t('book.coverScopeSelectNone') }}
            </button>
          </div>

          <div class="cover-scope__list">
            <label
              v-for="vol in previewData.items"
              :key="vol.bookId"
              class="cover-scope__vol-row"
              :class="{ 'cover-scope__vol-row--checked': selectedVolumeIds.has(vol.bookId) }"
            >
              <input
                type="checkbox"
                :checked="selectedVolumeIds.has(vol.bookId)"
                @change="toggleVolumeSelection(vol.bookId)"
              />

              <div class="cover-scope__thumbs">
                <span class="cover-scope__mini">
                  <img v-if="vol.currentCoverUrl" :src="vol.currentCoverUrl" :alt="vol.title" loading="lazy" />
                  <span v-else class="cover-scope__mini-empty">—</span>
                </span>
                <span class="cover-scope__arrow" aria-hidden="true">→</span>
                <span class="cover-scope__mini">
                  <img
                    v-if="vol.matchedCoverUrl"
                    :src="vol.matchedCoverUrl"
                    :alt="vol.matchedPublisher || vol.title"
                    loading="lazy"
                  />
                  <span v-else class="cover-scope__mini-empty">?</span>
                </span>
              </div>

              <div class="cover-scope__vol-info">
                <span class="cover-scope__vol-title">
                  <strong v-if="vol.volumeLabel">T.{{ vol.volumeLabel }} · </strong>{{ vol.title }}
                </span>
                <span
                  class="cover-scope__badge"
                  :class="{
                    'cover-scope__badge--ready': vol.matchStatus === 'ready',
                    'cover-scope__badge--same': vol.matchStatus === 'same',
                    'cover-scope__badge--missing': vol.matchStatus === 'missing'
                  }"
                >
                  {{
                    vol.matchStatus === 'ready'
                      ? t('book.coverScopeStatusReady')
                      : vol.matchStatus === 'same'
                        ? t('book.coverScopeStatusSame')
                        : t('book.coverScopeStatusMissing')
                  }}
                </span>
              </div>
            </label>
          </div>
        </div>

        <!-- Option B : recherche active en arrière-plan pour les tomes manquants -->
        <label
          v-if="scope !== 'single' && missingSelectedCount > 0"
          class="ds-checkbox cover-scope__bg-option"
        >
          <input v-model="searchMissingInBackground" type="checkbox" />
          <span>
            {{
              t('book.coverScopeSearchMissingCheckbox', {
                edition: selectedEdition.lineageLabel,
                count: missingSelectedCount
              })
            }}
          </span>
        </label>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cover-file-hidden {
  display: none;
}

.cover-preview {
  width: 72px;
  height: 104px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 2px solid var(--accent);
  background: var(--bg-surface);
  flex-shrink: 0;
}

.cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-url-box {
  flex: 1;
  min-width: 200px;
}

.cover-url-input {
  flex: 1;
  min-width: 160px;
}

.cover-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: var(--space-2);
}

.cover-thumb {
  display: flex;
  flex-direction: column;
  padding: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 2px solid var(--border-subtle);
  background: var(--bg-surface);
  cursor: pointer;
  text-align: left;
}

.cover-thumb--active {
  border-color: var(--accent);
}

.cover-thumb__img-wrap {
  display: block;
  width: 100%;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  background: var(--bg-elevated);
}

.cover-thumb__img-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-thumb__caption {
  display: block;
  width: 100%;
  padding: 3px 4px;
  font-size: 0.72rem;
  line-height: 1.2;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-top: 1px solid var(--border-subtle);
}

.cover-scope {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.cover-scope__option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  cursor: pointer;
}

.cover-scope__option input[type='radio'] {
  margin-top: 3px;
  accent-color: var(--accent);
}

.cover-scope__option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cover-scope__meta {
  font-size: 0.82rem;
}

.cover-scope__list {
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}

.cover-scope__vol-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  cursor: pointer;
}

.cover-scope__vol-row--checked {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.cover-scope__vol-row input[type='checkbox'] {
  accent-color: var(--accent);
  flex-shrink: 0;
}

.cover-scope__thumbs {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

.cover-scope__mini {
  width: 28px;
  height: 40px;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.cover-scope__mini img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-scope__mini-empty {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.cover-scope__arrow {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.cover-scope__vol-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.cover-scope__vol-title {
  font-size: 0.85rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cover-scope__badge {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: var(--radius-pill);
  font-size: 0.72rem;
  font-weight: 600;
}

.cover-scope__badge--ready {
  background: var(--success-bg);
  color: var(--success-text);
}

.cover-scope__badge--same {
  background: var(--bg-surface);
  color: var(--text-muted);
  border: 1px solid var(--border-subtle);
}

.cover-scope__badge--missing {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.cover-scope__bg-option {
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
}
</style>
