<!-- src/client/components/import/CollectionImportPanel.vue -->
<!-- Composant réutilisable d'import CSV / JSON / Excel (.xlsx) : utilisé dans Recherche (onglet Importer) et Mon Profil. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { Upload } from '@lucide/vue';
import ImportMappingView from './ImportMappingView.vue';
import { useJobsStore } from '../../stores/jobs.store';
import { useUiStore } from '../../stores/ui.store';
import { apiRequest, ApiClientError } from '../../api/client';
import { t } from '../../../shared/locales';
import type { ImportColumnMapping, ImportFilePreview } from '../../../shared/bibliographic/collection-import.util';
import type { BackgroundJobView } from '../../../shared/types/domain.types';

interface CollectionImportResultView {
  filename: string;
  totalRows: number;
  importedCount: number;
  resolvedByIsbnCount: number;
  resolvedBySearchCount: number;
  skippedCount: number;
  unmatchedCount: number;
  unmatched: Array<{
    rowNumber: number;
    isbn: string | null;
    title: string | null;
    series: string | null;
    author: string | null;
    reason: string;
  }>;
}

const props = withDefaults(
  defineProps<{
    idPrefix?: string;
  }>(),
  {
    idPrefix: 'import'
  }
);

const jobsStore = useJobsStore();
const uiStore = useUiStore();

const importFileInput = ref<HTMLInputElement | null>(null);
const importSelectedFile = ref<File | null>(null);
const importSelectedBase64 = ref<string>('');
const importDefaultStatus = ref<'owned' | 'wish'>('owned');
const importUploading = ref(false);
const importPreviewLoading = ref(false);
const importPreviewData = ref<ImportFilePreview | null>(null);
const importError = ref('');

const latestImportJob = computed(() => jobsStore.latestCollectionImportJob);
const importIsRunning = computed(
  () => latestImportJob.value?.status === 'pending' || latestImportJob.value?.status === 'running'
);
const importResult = computed<CollectionImportResultView | null>(() => {
  const res = latestImportJob.value?.result;
  return res && typeof res === 'object' ? (res as CollectionImportResultView) : null;
});

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = () => reject(new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

async function fetchImportPreview(hasHeaderRow?: boolean): Promise<void> {
  if (!importSelectedFile.value || !importSelectedBase64.value) return;
  importError.value = '';
  importPreviewLoading.value = true;
  try {
    const res = await apiRequest<{ ok: true; preview: ImportFilePreview }>('/api/me/import/preview', {
      method: 'POST',
      body: {
        filename: importSelectedFile.value.name,
        contentBase64: importSelectedBase64.value,
        ...(hasHeaderRow !== undefined ? { hasHeaderRow } : {})
      }
    });
    importPreviewData.value = res.preview;
  } catch (err) {
    importPreviewData.value = null;
    importError.value = err instanceof ApiClientError ? err.message : t('app.retry');
  } finally {
    importPreviewLoading.value = false;
  }
}

function handleCancelMapping(): void {
  importPreviewData.value = null;
  importSelectedFile.value = null;
  importSelectedBase64.value = '';
  if (importFileInput.value) importFileInput.value.value = '';
}

async function handleImportFileChange(event: Event): Promise<void> {
  importError.value = '';
  importPreviewData.value = null;
  importSelectedBase64.value = '';
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0] ?? null;
  if (!file) {
    importSelectedFile.value = null;
    return;
  }
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.csv') && !lower.endsWith('.json') && !lower.endsWith('.xlsx')) {
    importSelectedFile.value = null;
    importError.value = t('profile.importUnsupportedExt');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    importSelectedFile.value = null;
    importError.value = t('profile.importFileTooLarge');
    return;
  }
  importSelectedFile.value = file;
  try {
    importSelectedBase64.value = await readFileAsBase64(file);
    await fetchImportPreview();
  } catch {
    importError.value = t('app.retry');
  }
}

async function handleOpenImportMapping(): Promise<void> {
  if (!importSelectedFile.value || importUploading.value || importIsRunning.value || importPreviewLoading.value) return;
  if (!importSelectedBase64.value) {
    try {
      importSelectedBase64.value = await readFileAsBase64(importSelectedFile.value);
    } catch {
      importError.value = t('app.retry');
      return;
    }
  }
  if (importPreviewData.value) {
    return;
  }
  await fetchImportPreview();
}

async function handleToggleImportHeader(hasHeaderRow: boolean): Promise<void> {
  await fetchImportPreview(hasHeaderRow);
}

async function handleConfirmMappedImport(payload: {
  hasHeaderRow: boolean;
  columnMapping: ImportColumnMapping;
}): Promise<void> {
  if (!importSelectedFile.value || !importSelectedBase64.value || importUploading.value || importIsRunning.value) return;
  importError.value = '';
  importUploading.value = true;
  try {
    const res = await apiRequest<{ ok: true; job: BackgroundJobView; totalRows: number }>('/api/me/import', {
      method: 'POST',
      body: {
        filename: importSelectedFile.value.name,
        contentBase64: importSelectedBase64.value,
        defaultStatus: importDefaultStatus.value,
        hasHeaderRow: payload.hasHeaderRow,
        columnMapping: payload.columnMapping
      }
    });
    jobsStore.upsertJob(res.job);
    uiStore.pushToast(t('profile.importStartedToast', { count: res.totalRows }), 'info');
    importPreviewData.value = null;
    importSelectedFile.value = null;
    importSelectedBase64.value = '';
    if (importFileInput.value) importFileInput.value.value = '';
  } catch (err) {
    importError.value = err instanceof ApiClientError ? err.message : t('app.retry');
  } finally {
    importUploading.value = false;
  }
}

function formatUnmatchedLabel(item: CollectionImportResultView['unmatched'][number]): string {
  const parts = [item.title || item.series, item.author, item.isbn].filter(Boolean);
  return parts.length > 0 ? parts.join(' — ') : '—';
}
</script>

<template>
  <div class="ds-card ds-stack">
    <h2>{{ t('profile.importTitle') }}</h2>
    <p class="ds-text-muted">{{ t('profile.importDesc') }}</p>

    <div v-if="importError" class="ds-banner ds-banner--danger" role="alert">
      {{ importError }}
    </div>

    <ImportMappingView
      v-if="importPreviewData"
      :filename="importSelectedFile?.name ?? ''"
      :preview="importPreviewData"
      :default-status="importDefaultStatus"
      :loading-preview="importPreviewLoading"
      :submitting="importUploading"
      @cancel="handleCancelMapping"
      @toggle-header="handleToggleImportHeader"
      @update:default-status="importDefaultStatus = $event"
      @confirm="handleConfirmMappedImport"
    />

    <form v-else class="ds-stack" @submit.prevent="handleOpenImportMapping">
      <div class="ds-grid-2">
        <div class="ds-field">
          <label class="ds-label" :for="`${props.idPrefix}-file`">{{ t('profile.importFileLabel') }}</label>
          <input
            :id="`${props.idPrefix}-file`"
            ref="importFileInput"
            type="file"
            class="ds-input"
            accept=".csv,.json,.xlsx,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            :disabled="importUploading || importIsRunning || importPreviewLoading"
            @change="handleImportFileChange"
          />
        </div>

        <div class="ds-field">
          <label class="ds-label" :for="`${props.idPrefix}-status`">{{ t('profile.importDefaultStatusLabel') }}</label>
          <select
            :id="`${props.idPrefix}-status`"
            v-model="importDefaultStatus"
            class="ds-input"
            :disabled="importUploading || importIsRunning || importPreviewLoading"
          >
            <option value="owned">{{ t('profile.importStatusOwned') }}</option>
            <option value="wish">{{ t('profile.importStatusWish') }}</option>
          </select>
        </div>
      </div>

      <div class="ds-row">
        <button
          type="submit"
          class="ds-btn ds-btn--primary"
          :disabled="!importSelectedFile || importUploading || importIsRunning || importPreviewLoading"
        >
          <Upload :size="16" aria-hidden="true" />
          {{
            importPreviewLoading
              ? t('profile.importAnalyzing')
              : importUploading
                ? t('app.loading')
                : t('profile.importBtn')
          }}
        </button>
      </div>
    </form>

    <div v-if="latestImportJob && importIsRunning" class="ds-banner ds-banner--warning" role="status">
      {{
        t('profile.importRunning', {
          done: latestImportJob.progressDone,
          total: latestImportJob.progressTotal || 1
        })
      }}
    </div>

    <div v-else-if="latestImportJob?.status === 'error'" class="ds-banner ds-banner--danger" role="alert">
      {{
        t('profile.importErrorPrefix', {
          message: latestImportJob.errorMessage || t('app.retry')
        })
      }}
    </div>

    <div v-else-if="latestImportJob?.status === 'done' && importResult" class="ds-stack">
      <div class="ds-banner ds-banner--success" role="status">
        {{
          t('profile.importDoneSummary', {
            imported: importResult.importedCount,
            byIsbn: importResult.resolvedByIsbnCount,
            bySearch: importResult.resolvedBySearchCount,
            unmatched: importResult.unmatchedCount
          })
        }}
      </div>

      <details v-if="importResult.unmatched.length > 0" class="ds-accordion">
        <summary>
          {{ t('profile.importUnmatchedTitle', { count: importResult.unmatched.length }) }}
        </summary>
        <ul class="import-unmatched-list">
          <li v-for="item in importResult.unmatched" :key="`${item.rowNumber}-${item.isbn ?? item.title}`">
            {{
              t('profile.importUnmatchedRow', {
                row: item.rowNumber,
                label: formatUnmatchedLabel(item)
              })
            }}
          </li>
        </ul>
      </details>
    </div>
  </div>
</template>

<style scoped>
.import-unmatched-list {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: 0.875rem;
}
</style>
