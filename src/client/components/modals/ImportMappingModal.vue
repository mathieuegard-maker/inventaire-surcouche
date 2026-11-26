<!-- src/client/components/modals/ImportMappingModal.vue -->
<!-- Modale systématique de vérification et bijection des colonnes CSV / JSON / Excel (.xlsx) avant import. -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
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
  open: boolean;
  filename: string;
  preview: ImportFilePreview | null;
  defaultStatus: 'owned' | 'wish';
  loadingPreview: boolean;
  submitting: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'toggle-header', hasHeaderRow: boolean): void;
  (e: 'update:defaultStatus', value: 'owned' | 'wish'): void;
  (e: 'confirm', payload: { hasHeaderRow: boolean; columnMapping: ImportColumnMapping }): void;
}>();

const mapping = reactive<Record<string, ImportFieldKey | null>>({});
const touchedKeys = ref<Set<string>>(new Set());
const swapNotice = ref('');
const captionId = 'import-mapping-table-caption';

function resetMappingFromPreview(prev: ImportFilePreview | null): void {
  for (const key of Object.keys(mapping)) {
    delete mapping[key];
  }
  touchedKeys.value = new Set();
  swapNotice.value = '';
  if (!prev) return;
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
    case 'publisher':
      return t('profile.importMapField_publisher');
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

  // Bijection stricte pour tous les champs hors Auteur (qui autorise la fusion multi-colonnes ex. Scénariste + Dessinateur)
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
  (props.preview?.columns ?? []).filter((c) => Boolean(mapping[c.columnKey])).length
);

const authorMappedCount = computed(() =>
  (props.preview?.columns ?? []).filter((c) => mapping[c.columnKey] === 'author').length
);

const reviewCount = computed(() =>
  (props.preview?.columns ?? []).filter((c) => columnStatusKind(c) === 'review').length
);

const hasPivotField = computed(() =>
  (props.preview?.columns ?? []).some((c) => {
    const f = mapping[c.columnKey];
    return Boolean(f && PIVOT_IMPORT_FIELDS.has(f));
  })
);

const canConfirm = computed(
  () =>
    Boolean(props.preview) &&
    !props.loadingPreview &&
    !props.submitting &&
    hasPivotField.value &&
    (props.preview?.totalDataRows ?? 0) > 0
);

const tableLabelVars = computed(() => ({
  '--label-sample': JSON.stringify(t('profile.importMapColSample')),
  '--label-target': JSON.stringify(t('profile.importMapColTarget')),
  '--label-status': JSON.stringify(t('profile.importMapColStatus'))
}));

function handleConfirm(): void {
  if (!props.preview || !canConfirm.value) return;
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
  <BaseModal
    :open="open"
    :title="t('profile.importMapModalTitle')"
    max-width="860px"
    :closable="!submitting"
    @close="emit('close')"
  >
    <div v-if="loadingPreview && !preview" class="ds-text-muted">
      {{ t('profile.importAnalyzing') }}
    </div>

    <div v-else-if="preview" class="ds-stack">
      <p class="ds-text-muted import-map-intro">{{ t('profile.importMapModalIntro') }}</p>

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
      <div v-if="swapNotice" class="ds-text-muted import-map-subnote" role="status">
        {{ swapNotice }}
      </div>

      <!-- Tableau responsive accessible (container queries + sticky thead) -->
      <div
        tabindex="0"
        role="region"
        :aria-labelledby="captionId"
        class="import-map-table-wrap"
        :class="{ 'import-map-table-wrap--loading': loadingPreview }"
      >
        <table class="import-map-table" :style="tableLabelVars">
          <caption :id="captionId" class="sr-only">
            {{ t('profile.importMapTableCaption') }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ t('profile.importMapColSource') }}</th>
              <th scope="col">{{ t('profile.importMapColSample') }}</th>
              <th scope="col">{{ t('profile.importMapColTarget') }}</th>
              <th scope="col">{{ t('profile.importMapColStatus') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="col in preview.columns"
              :key="col.columnKey"
              :class="{ 'import-map-row--review': columnStatusKind(col) === 'review' }"
            >
              <th scope="row" class="import-map-cell-source">
                <span class="import-map-col-idx">{{ t('profile.importMapColumnNumber', { index: col.columnIndex }) }}</span>
                <strong class="import-map-col-name">
                  {{ col.sourceLabel || t('profile.importMapHeaderlessLabel') }}
                </strong>
              </th>

              <td class="import-map-cell-samples">
                <div v-if="col.sampleValues.length > 0" class="import-map-samples">
                  <span
                    v-for="(val, idx) in col.sampleValues"
                    :key="idx"
                    class="import-map-sample-chip"
                    :title="val"
                  >
                    {{ val }}
                  </span>
                </div>
                <span v-else class="ds-text-muted">{{ t('profile.importMapEmptySamples') }}</span>
              </td>

              <td class="import-map-cell-target">
                <select
                  class="ds-input import-map-select"
                  :aria-label="`${t('profile.importMapColumnNumber', { index: col.columnIndex })} ${col.sourceLabel}`"
                  :value="mapping[col.columnKey] ?? ''"
                  :disabled="loadingPreview || submitting"
                  @change="handleFieldChange(col, $event)"
                >
                  <option value="">{{ t('profile.importMapIgnoreOption') }}</option>
                  <option v-for="field in preview.availableFields" :key="field" :value="field">
                    {{ fieldLabel(field) }}
                  </option>
                </select>
              </td>

              <td class="import-map-cell-status">
                <span
                  class="ds-badge import-map-status-badge"
                  :class="`import-map-status-badge--${columnStatusKind(col)}`"
                >
                  {{ columnStatusLabel(col) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <template #footer>
      <button type="button" class="ds-btn" :disabled="submitting" @click="emit('close')">
        {{ t('app.cancel') }}
      </button>
      <button
        type="button"
        class="ds-btn ds-btn--primary"
        :disabled="!canConfirm"
        @click="handleConfirm"
      >
        {{
          submitting
            ? t('app.loading')
            : t('profile.importMapConfirmBtn', { count: preview?.totalDataRows ?? 0 })
        }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.import-map-intro {
  margin: 0;
  font-size: 0.92rem;
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

.import-map-table-wrap {
  overflow: auto;
  max-inline-size: 100%;
  max-block-size: min(440px, 52dvh);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  container-type: inline-size;
  background: var(--bg-surface);
}

.import-map-table-wrap--loading {
  opacity: 0.65;
}

.import-map-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.88rem;
}

.import-map-table thead {
  position: sticky;
  inset-block-start: 0;
  z-index: 2;
}

.import-map-table thead th {
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-weight: 600;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  white-space: nowrap;
}

.import-map-table tbody th,
.import-map-table tbody td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: top;
}

.import-map-table tbody tr:last-child th,
.import-map-table tbody tr:last-child td {
  border-bottom: none;
}

.import-map-row--review {
  background: var(--warning-bg);
}

.import-map-cell-source {
  text-align: left;
  font-weight: 500;
  min-width: 135px;
}

.import-map-col-idx {
  display: block;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.import-map-col-name {
  display: block;
  color: var(--text-primary);
  word-break: break-word;
}

.import-map-samples {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.import-map-sample-chip {
  display: inline-block;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82rem;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
}

.import-map-select {
  min-width: 210px;
  padding: 0.45rem 0.65rem;
  font-size: 0.86rem;
}

.import-map-cell-status {
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
  border-color: var(--border-strong);
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

@container (width < 600px) {
  .import-map-table,
  .import-map-table thead,
  .import-map-table tbody,
  .import-map-table tr,
  .import-map-table th,
  .import-map-table td {
    display: block;
  }

  .import-map-table thead {
    display: none;
  }

  .import-map-table tbody tr {
    margin: var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .import-map-table tbody th {
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border-subtle);
  }

  .import-map-table tbody td {
    border-bottom: 1px solid var(--border-subtle);
  }

  .import-map-table tbody td::before {
    display: block;
    font-size: 0.76rem;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: var(--space-1);
  }

  .import-map-table tbody td:nth-child(2)::before {
    content: var(--label-sample);
  }

  .import-map-table tbody td:nth-child(3)::before {
    content: var(--label-target);
  }

  .import-map-table tbody td:nth-child(4)::before {
    content: var(--label-status);
  }

  .import-map-sample-chip {
    max-width: 100%;
  }

  .import-map-select {
    min-width: 0;
    width: 100%;
  }
}
</style>
