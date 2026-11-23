<!-- src/client/components/modals/SeriesAttachModal.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import { apiRequest } from '../../api/client';
import { useLibraryStore } from '../../stores/library.store';
import { useUiStore } from '../../stores/ui.store';
import { ApiClientError } from '../../api/client';
import { normalizeTextKey } from '../../../shared/bibliographic/text-normalize.util';
import { t } from '../../../shared/locales';

const props = defineProps<{
  open: boolean;
  bookIds: string[];
  sourceSeriesId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'attached', targetSeriesId: string): void;
}>();

const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const filterText = ref('');
const selectedSeriesId = ref('');
const newSeriesName = ref('');
const mergeEntireSource = ref(false);
const volumeType = ref<'standard' | 'hors_serie' | 'integrale' | 'unnumbered'>('standard');
const volumeLabel = ref('');
const sortOrder = ref('');
const submitting = ref(false);

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      filterText.value = '';
      selectedSeriesId.value = '';
      newSeriesName.value = '';
      mergeEntireSource.value = false;
      volumeType.value = 'standard';
      volumeLabel.value = '';
      sortOrder.value = '';
    }
  }
);

const filteredSeries = computed(() => {
  const needle = normalizeTextKey(filterText.value);
  return libraryStore.series
    .filter((s) => s.id !== props.sourceSeriesId)
    .filter((s) => !needle || normalizeTextKey(s.canonicalName).includes(needle))
    .slice(0, 40);
});

const canSubmit = computed(
  () => props.bookIds.length > 0 && Boolean(selectedSeriesId.value || newSeriesName.value.trim())
);

async function handleSubmit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  try {
    const parsedSort = sortOrder.value.trim() ? Number(sortOrder.value.replace(',', '.')) : undefined;
    const res = await apiRequest<{ ok: true; targetSeriesId: string; updatedCount: number }>('/api/series/attach', {
      method: 'POST',
      body: {
        bookIds: props.bookIds,
        targetSeriesId: selectedSeriesId.value || undefined,
        newSeriesName: !selectedSeriesId.value ? newSeriesName.value.trim() : undefined,
        mergeEntireSourceSeriesId: mergeEntireSource.value && props.sourceSeriesId ? props.sourceSeriesId : undefined,
        volumeType: props.bookIds.length === 1 ? volumeType.value : undefined,
        volumeLabel: props.bookIds.length === 1 && volumeLabel.value.trim() ? volumeLabel.value.trim() : undefined,
        sortOrder: props.bookIds.length === 1 && parsedSort !== undefined && Number.isFinite(parsedSort) ? parsedSort : undefined
      }
    });
    await libraryStore.syncNow();
    uiStore.pushToast(t('series.attachSuccessToast', { count: res.updatedCount }), 'success');
    emit('attached', res.targetSeriesId);
    emit('close');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('series.attachModalTitle', { count: bookIds.length })"
    max-width="560px"
    @close="emit('close')"
  >
    <form id="series-attach-form" class="ds-stack" @submit.prevent="handleSubmit">
      <div class="ds-field">
        <label class="ds-label" for="attach-filter">{{ t('series.attachSelectExistingLabel') }}</label>
        <input
          id="attach-filter"
          v-model="filterText"
          type="search"
          class="ds-input"
          :placeholder="t('series.attachSearchPlaceholder')"
        />
      </div>

      <div v-if="filteredSeries.length > 0" class="attach-series-list">
        <button
          v-for="s in filteredSeries"
          :key="s.id"
          type="button"
          class="ds-panel attach-series-row"
          :class="{ 'attach-series-row--active': selectedSeriesId === s.id }"
          @click="selectedSeriesId = selectedSeriesId === s.id ? '' : s.id"
        >
          <strong>{{ s.canonicalName }}</strong>
          <span class="ds-text-muted">{{ t('collection.tomesCount', { count: s.knownVolumesCount }) }}</span>
        </button>
      </div>

      <div class="ds-field">
        <label class="ds-label" for="attach-new-name">{{ t('series.attachCreateNewLabel') }}</label>
        <input
          id="attach-new-name"
          v-model="newSeriesName"
          type="text"
          class="ds-input"
          :placeholder="t('series.attachCreateNewPlaceholder')"
          @input="selectedSeriesId = ''"
        />
      </div>

      <label v-if="sourceSeriesId" class="ds-checkbox">
        <input v-model="mergeEntireSource" type="checkbox" />
        <span>{{ t('series.attachMergeWholeCheckbox') }}</span>
      </label>

      <template v-if="bookIds.length === 1 && !mergeEntireSource">
        <div class="ds-grid-3">
          <div class="ds-field">
            <label class="ds-label" for="attach-vol-type">{{ t('series.attachVolumeTypeLabel') }}</label>
            <select id="attach-vol-type" v-model="volumeType" class="ds-input">
              <option value="standard">{{ t('series.attachTypeStandard') }}</option>
              <option value="hors_serie">{{ t('series.attachTypeHs') }}</option>
              <option value="integrale">{{ t('series.attachTypeIntegral') }}</option>
              <option value="unnumbered">{{ t('series.attachTypeUnnumbered') }}</option>
            </select>
          </div>
          <div class="ds-field">
            <label class="ds-label" for="attach-vol-label">{{ t('scan.fieldVolume') }}</label>
            <input id="attach-vol-label" v-model="volumeLabel" type="text" class="ds-input" />
          </div>
          <div class="ds-field">
            <label class="ds-label" for="attach-sort-order">{{ t('series.attachSortOrderLabel') }}</label>
            <input id="attach-sort-order" v-model="sortOrder" type="text" class="ds-input" />
          </div>
        </div>
      </template>
    </form>

    <template #footer>
      <button type="button" class="ds-btn" :disabled="submitting" @click="emit('close')">
        {{ t('app.cancel') }}
      </button>
      <button
        type="submit"
        form="series-attach-form"
        class="ds-btn ds-btn--primary"
        :disabled="submitting || !canSubmit"
      >
        {{ submitting ? t('app.loading') : t('app.confirm') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.attach-series-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 200px;
  overflow-y: auto;
}

.attach-series-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  text-align: left;
  cursor: pointer;
}

.attach-series-row--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
</style>
