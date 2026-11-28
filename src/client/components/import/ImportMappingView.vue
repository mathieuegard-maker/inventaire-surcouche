<!-- src/client/components/import/ImportMappingView.vue -->
<!-- Vue pleine page (responsive mobile-first) de vérification et bijection des colonnes CSV / JSON / Excel (.xlsx) avant import. -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ArrowLeft, RotateCcw, Upload } from '@lucide/vue';
import {
  MULTI_COLUMN_IMPORT_FIELDS,
  PIVOT_IMPORT_FIELDS,
  type ImportColumnMapping,
  type ImportColumnPreview,
  type ImportFieldKey,
  type ImportFilePreview
} from '../../../shared/bibliographic/collection-import.util';
import { t } from '../../../shared/locales';

const props = defineProps<{
  filename: string;
  preview: ImportFilePreview;
  defaultStatus: 'owned' | 'wish';
  loadingPreview: boolean;
  submitting: boolean;
}>();

const emit = defineEmits<{
  (e: 'cancel'): void;
  (e: 'toggle-header', hasHeaderRow: boolean): void;
  (e: 'update:defaultStatus', value: 'owned' | 'wish'): void;
  (e: 'confirm', payload: { hasHeaderRow: boolean; columnMapping: ImportColumnMapping }): void;
}>();

const mapping = reactive<Record<string, ImportFieldKey | null>>({});
const touchedKeys = ref<Set<string>>(new Set());
const swapNotice = ref('');

function resetMappingFromPreview(prev: ImportFilePreview): void {
  for (const key of Object.keys(mapping)) {
    delete mapping[key];
  }
  touchedKeys.value = new Set();
  swapNotice.value = '';
  for (const col of prev.columns) {
    mapping[col.columnKey] = col.suggestedField;
  }
}

watch(
  () => props.preview,
  (next) => {
    resetMappingFromPreview(next);
  },
  { immediate: true }
);

function fieldLabel(field: ImportFieldKey): string {
  switch (field) {
    case 'isbn':
      return t('profile.importMapField_isbn');
    case 'title':
      return t('profile.importMapField_title');
    case 'series':
      return t('profile.importMapField_series');
    case 'volumeNumber':
      return t('profile.importMapField_volumeNumber');
    case 'author':
      return t('profile.importMapField_author');
    case 'scriptwriter':
      return t('profile.importMapField_scriptwriter');
    case 'illustrator':
      return t('profile.importMapField_illustrator');
    case 'colorist':
      return t('profile.importMapField_colorist');
    case 'publisher':
      return t('profile.importMapField_publisher');
    case 'mainCategory':
      return t('profile.importMapField_mainCategory');
    case 'genres':
      return t('profile.importMapField_genres');
    case 'ownershipStatus':
      return t('profile.importMapField_ownershipStatus');
    case 'isIntegral':
      return t('profile.importMapField_isIntegral');
    case 'includedVolumes':
      return t('profile.importMapField_includedVolumes');
    case 'readingStatus':
      return t('profile.importMapField_readingStatus');
    case 'rating':
      return t('profile.importMapField_rating');
    case 'notes':
      return t('profile.importMapField_notes');
    default:
      return field;
  }
}

function handleFieldChange(col: ImportColumnPreview, event: Event): void {
  const select = event.target as HTMLSelectElement;
  const rawVal = select.value.trim();
  const nextField = (rawVal || null) as ImportFieldKey | null;
  swapNotice.value = '';

  // Bijection stricte sauf pour les champs multi-colonnes autorisés (Auteur, Notes personnelles)
  if (nextField && !MULTI_COLUMN_IMPORT_FIELDS.has(nextField)) {
    for (const otherKey of Object.keys(mapping)) {
      if (otherKey !== col.columnKey && mapping[otherKey] === nextField) {
        mapping[otherKey] = null;
        touchedKeys.value.add(otherKey);
        swapNotice.value = t('profile.importMapSwappedNotice', {
          field: fieldLabel(nextField),
          col: col.columnIndex
        });
      }
    }
  }

  mapping[col.columnKey] = nextField;
  touchedKeys.value.add(col.columnKey);
}

function handleHeaderToggle(event: Event): void {
  const input = event.target as HTMLInputElement;
  emit('toggle-header', input.checked);
}

function handleDefaultStatusChange(event: Event): void {
  const select = event.target as HTMLSelectElement;
  emit('update:defaultStatus', select.value === 'wish' ? 'wish' : 'owned');
}

function columnStatusKind(col: ImportColumnPreview): 'custom' | 'auto' | 'review' | 'ignored' {
  const current = mapping[col.columnKey] ?? null;
  if (touchedKeys.value.has(col.columnKey)) {
    return current ? 'custom' : 'ignored';
  }
  if (!current) return 'ignored';
  return col.confidence === 'high' ? 'auto' : 'review';
}

function columnStatusLabel(col: ImportColumnPreview): string {
  const kind = columnStatusKind(col);
  if (kind === 'custom') return t('profile.importMapStatusCustom');
  if (kind === 'auto') return t('profile.importMapStatusAuto');
  if (kind === 'review') return t('profile.importMapStatusReview');
  return t('profile.importMapStatusIgnored');
}

const mappedCount = computed(() =>
  props.preview.columns.filter((c) => Boolean(mapping[c.columnKey])).length
);

const authorMappedCount = computed(() =>
  props.preview.columns.filter((c) => mapping[c.columnKey] === 'author').length
);

const notesMappedCount = computed(() =>
  props.preview.columns.filter((c) => mapping[c.columnKey] === 'notes').length
);

const reviewCount = computed(() =>
  props.preview.columns.filter((c) => columnStatusKind(c) === 'review').length
);

const hasPivotField = computed(() =>
  props.preview.columns.some((c) => {
    const f = mapping[c.columnKey];
    return Boolean(f && PIVOT_IMPORT_FIELDS.has(f));
  })
);

const canConfirm = computed(
  () =>
    !props.loadingPreview &&
    !props.submitting &&
    hasPivotField.value &&
    props.preview.totalDataRows > 0
);

function handleConfirm(): void {
  if (!canConfirm.value) return;
  const cleanMapping: ImportColumnMapping = {};
  for (const col of props.preview.columns) {
    cleanMapping[col.columnKey] = mapping[col.columnKey] ?? null;
  }
  emit('confirm', {
    hasHeaderRow: props.preview.hasHeaderRow,
    columnMapping: cleanMapping
  });
}
</script>

<template>
  <div class="import-map-view ds-stack">
    <!-- En-tête pleine largeur -->
    <div class="ds-row ds-row--between import-map-head">
      <div class="ds-stack--xs">
        <h3 class="import-map-title">{{ t('profile.importMapModalTitle') }}</h3>
        <p class="ds-text-muted import-map-intro">{{ t('profile.importMapModalIntro') }}</p>
      </div>

      <button
        type="button"
        class="ds-btn ds-btn--sm"
        :disabled="submitting"
        @click="emit('cancel')"
      >
        <ArrowLeft :size="15" aria-hidden="true" />
        {{ t('profile.importMapBackBtn') }}
      </button>
    </div>

    <!-- Résumé fichier + réglages rapides -->
    <div class="ds-panel ds-stack import-map-summary">
      <div class="ds-row ds-row--between import-map-meta">
        <div class="ds-row import-map-file-info">
          <strong class="import-map-filename">{{ filename }}</strong>
          <span class="ds-badge ds-badge--accent">{{ preview.format.toUpperCase() }}</span>
          <span class="ds-badge">{{ t('profile.importMapRowsBadge', { count: preview.totalDataRows }) }}</span>
        </div>

        <button
          type="button"
          class="ds-btn ds-btn--ghost ds-btn--sm"
          :disabled="loadingPreview || submitting"
          @click="resetMappingFromPreview(preview)"
        >
          <RotateCcw :size="14" aria-hidden="true" />
          {{ t('profile.importMapResetBtn') }}
        </button>
      </div>

      <div class="ds-grid-2 import-map-controls">
        <label v-if="preview.canToggleHeaderRow" class="ds-checkbox import-map-header-toggle">
          <input
            type="checkbox"
            :checked="preview.hasHeaderRow"
            :disabled="loadingPreview || submitting"
            @change="handleHeaderToggle"
          />
          <span>{{ t('profile.importMapHasHeaderLabel') }}</span>
        </label>

        <div class="ds-field import-map-status-field">
          <label class="ds-label" for="import-map-default-status">
            {{ t('profile.importDefaultStatusLabel') }}
          </label>
          <select
            id="import-map-default-status"
            class="ds-input"
            :value="defaultStatus"
            :disabled="submitting"
            @change="handleDefaultStatusChange"
          >
            <option value="owned">{{ t('profile.importStatusOwned') }}</option>
            <option value="wish">{{ t('profile.importStatusWish') }}</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Bannières de contrôle -->
    <div v-if="!hasPivotField" class="ds-banner ds-banner--danger import-map-banner" role="alert">
      {{ t('profile.importMapPivotMissing') }}
    </div>
    <div v-else-if="reviewCount > 0" class="ds-banner ds-banner--warning import-map-banner" role="status">
      {{ t('profile.importMapReviewNotice', { count: reviewCount }) }}
    </div>
    <div v-else class="ds-banner ds-banner--success import-map-banner" role="status">
      {{ t('profile.importMapReadyNotice', { mapped: mappedCount }) }}
    </div>

    <div v-if="authorMappedCount > 1" class="ds-text-muted import-map-subnote">
      {{ t('profile.importMapAuthorMergedHint', { count: authorMappedCount }) }}
    </div>
    <div v-if="notesMappedCount > 1" class="ds-text-muted import-map-subnote">
      {{ t('profile.importMapNotesMergedHint', { count: notesMappedCount }) }}
    </div>
    <div v-if="swapNotice" class="ds-text-muted import-map-subnote" role="status">
      {{ swapNotice }}
    </div>

    <!-- Cartes lisibles par colonne (1 col sur mobile, 2 cols sur grand écran) -->
    <div class="import-map-cards" :class="{ 'import-map-cards--loading': loadingPreview }">
      <article
        v-for="col in preview.columns"
        :key="col.columnKey"
        class="import-col-card"
        :class="{ 'import-col-card--review': columnStatusKind(col) === 'review' }"
      >
        <div class="import-col-card__top">
          <div class="import-col-card__source">
            <span class="import-col-card__kicker">
              {{ t('profile.importMapColumnCardSource') }} · {{ t('profile.importMapColumnNumber', { index: col.columnIndex }) }}
            </span>
            <strong class="import-col-card__name">
              {{ col.sourceLabel || t('profile.importMapHeaderlessLabel') }}
            </strong>
          </div>

          <span
            class="ds-badge import-map-status-badge"
            :class="`import-map-status-badge--${columnStatusKind(col)}`"
          >
            {{ columnStatusLabel(col) }}
          </span>
        </div>

        <div class="import-col-card__samples">
          <span class="import-col-card__kicker">{{ t('profile.importMapColumnValuesLabel') }}</span>
          <div v-if="col.sampleValues.length > 0" class="import-col-card__chips">
            <span
              v-for="(val, idx) in col.sampleValues"
              :key="idx"
              class="import-map-sample-chip"
              :title="val"
            >
              {{ val }}
            </span>
          </div>
          <span v-else class="ds-text-muted import-col-card__empty">
            {{ t('profile.importMapEmptySamples') }}
          </span>
        </div>

        <div class="import-col-card__target ds-field">
          <label class="ds-label" :for="`import-col-select-${col.columnKey}`">
            {{ t('profile.importMapColumnCardTarget') }}
          </label>
          <select
            :id="`import-col-select-${col.columnKey}`"
            class="ds-input import-map-select"
            :value="mapping[col.columnKey] ?? ''"
            :disabled="loadingPreview || submitting"
            @change="handleFieldChange(col, $event)"
          >
            <option value="">{{ t('profile.importMapIgnoreOption') }}</option>
            <option v-for="field in preview.availableFields" :key="field" :value="field">
              {{ fieldLabel(field) }}
            </option>
          </select>
        </div>
      </article>
    </div>

    <!-- Actions de validation en bas de page -->
    <div class="import-map-footer">
      <button type="button" class="ds-btn" :disabled="submitting" @click="emit('cancel')">
        {{ t('app.cancel') }}
      </button>
      <button
        type="button"
        class="ds-btn ds-btn--primary"
        :disabled="!canConfirm"
        @click="handleConfirm"
      >
        <Upload :size="16" aria-hidden="true" />
        {{
          submitting
            ? t('app.loading')
            : t('profile.importMapConfirmBtn', { count: preview.totalDataRows })
        }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.import-map-head {
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-3);
}

.import-map-title {
  margin: 0;
}

.import-map-intro {
  margin: 0;
  font-size: 0.9rem;
}

.import-map-summary {
  gap: var(--space-3);
}

.import-map-meta {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.import-map-file-info {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.import-map-filename {
  word-break: break-word;
}

.import-map-controls {
  align-items: center;
}

.import-map-header-toggle {
  padding-top: var(--space-1);
}

.import-map-status-field {
  margin-bottom: 0;
}

.import-map-banner {
  margin-bottom: 0;
}

.import-map-subnote {
  font-size: 0.85rem;
}

.import-map-cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3);
}

@media (min-width: 780px) {
  .import-map-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.import-map-cards--loading {
  opacity: 0.65;
}

.import-col-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.import-col-card--review {
  border-color: var(--warning-text);
  background: var(--warning-bg);
}

.import-col-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}

.import-col-card__source {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
}

.import-col-card__kicker {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
}

.import-col-card__name {
  font-size: 0.98rem;
  color: var(--text-primary);
  word-break: break-word;
}

.import-col-card__samples {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.import-col-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.import-map-sample-chip {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82rem;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
}

.import-col-card__empty {
  font-size: 0.82rem;
}

.import-col-card__target {
  margin-bottom: 0;
  margin-top: auto;
}

.import-map-select {
  width: 100%;
}

.import-map-status-badge {
  flex-shrink: 0;
  white-space: nowrap;
}

.import-map-status-badge--auto {
  background: var(--success-bg);
  color: var(--success-text);
  border-color: transparent;
}

.import-map-status-badge--review {
  background: var(--warning-bg);
  color: var(--warning-text);
  border-color: var(--warning-text);
}

.import-map-status-badge--custom {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: transparent;
}

.import-map-status-badge--ignored {
  background: var(--bg-elevated);
  color: var(--text-muted);
}

.import-map-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}
</style>
