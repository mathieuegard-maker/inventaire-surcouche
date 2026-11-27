<!-- src/client/components/base/ListFilterModal.vue -->
<!-- Modale standardisée de filtres composites multi-facettes réutilisée par TOUTES les vues listes. -->
<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import BaseModal from './BaseModal.vue';
import {
  createEmptyListFilters,
  type CompositeListFilters,
  type ExtractedFilterFacets
} from '../../../shared/bibliographic/list-filter.util';
import { t } from '../../../shared/locales';

export type FilterFacetKey =
  | 'genre'
  | 'author'
  | 'publisher'
  | 'series'
  | 'volumeNumber'
  | 'readingStatus'
  | 'loanState'
  | 'integralOnly'
  | 'seriesCompletion';

const props = withDefaults(
  defineProps<{
    open: boolean;
    modelValue: CompositeListFilters;
    facets: ExtractedFilterFacets;
    enabledFacets?: readonly FilterFacetKey[];
  }>(),
  {
    enabledFacets: () => [
      'genre',
      'author',
      'publisher',
      'series',
      'volumeNumber',
      'readingStatus',
      'loanState',
      'integralOnly'
    ]
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'update:modelValue', next: CompositeListFilters): void;
}>();

const uid = useId();
const draft = ref<CompositeListFilters>({ ...props.modelValue });

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      draft.value = { ...props.modelValue };
    }
  }
);

function hasFacet(key: FilterFacetKey): boolean {
  return props.enabledFacets.includes(key);
}

function resetDraft(): void {
  const empty = createEmptyListFilters();
  draft.value = { ...empty, query: props.modelValue.query };
}

function apply(): void {
  emit('update:modelValue', { ...draft.value, query: props.modelValue.query });
  emit('close');
}
</script>

<template>
  <BaseModal :open="open" :title="t('collection.filterModalTitle')" size="md" @close="emit('close')">
    <div class="filter-modal-grid">
      <div v-if="hasFacet('genre')" class="ds-field">
        <label class="ds-label" :for="`${uid}-genre`">{{ t('collection.filterGenreLabel') }}</label>
        <select :id="`${uid}-genre`" v-model="draft.genre" class="ds-input">
          <option value="">{{ t('collection.filterGenreAll') }}</option>
          <option v-for="g in facets.genres" :key="g" :value="g">{{ g }}</option>
        </select>
      </div>

      <div v-if="hasFacet('author')" class="ds-field">
        <label class="ds-label" :for="`${uid}-author`">{{ t('collection.filterAuthorLabel') }}</label>
        <input
          :id="`${uid}-author`"
          v-model="draft.author"
          type="search"
          class="ds-input"
          :list="`${uid}-authors-dl`"
          :placeholder="t('collection.filterAuthorPlaceholder')"
        />
        <datalist :id="`${uid}-authors-dl`">
          <option v-for="a in facets.authors" :key="a" :value="a" />
        </datalist>
      </div>

      <div v-if="hasFacet('publisher')" class="ds-field">
        <label class="ds-label" :for="`${uid}-pub`">{{ t('collection.filterPublisherLabel') }}</label>
        <input
          :id="`${uid}-pub`"
          v-model="draft.publisher"
          type="search"
          class="ds-input"
          :list="`${uid}-pubs-dl`"
          :placeholder="t('collection.filterPublisherPlaceholder')"
        />
        <datalist :id="`${uid}-pubs-dl`">
          <option v-for="p in facets.publishers" :key="p" :value="p" />
        </datalist>
      </div>

      <div v-if="hasFacet('series')" class="ds-field">
        <label class="ds-label" :for="`${uid}-series`">{{ t('collection.filterSeriesLabel') }}</label>
        <input
          :id="`${uid}-series`"
          v-model="draft.series"
          type="search"
          class="ds-input"
          :list="`${uid}-series-dl`"
          :placeholder="t('collection.filterSeriesPlaceholder')"
        />
        <datalist :id="`${uid}-series-dl`">
          <option v-for="s in facets.seriesNames" :key="s" :value="s" />
        </datalist>
      </div>

      <div v-if="hasFacet('volumeNumber')" class="ds-field">
        <label class="ds-label" :for="`${uid}-vol`">{{ t('collection.filterVolumeLabel') }}</label>
        <input
          :id="`${uid}-vol`"
          v-model="draft.volumeNumber"
          type="text"
          inputmode="numeric"
          class="ds-input"
          :placeholder="t('collection.filterVolumePlaceholder')"
        />
      </div>

      <div v-if="hasFacet('readingStatus')" class="ds-field">
        <label class="ds-label" :for="`${uid}-reading`">{{ t('collection.filterReadingLabel') }}</label>
        <select :id="`${uid}-reading`" v-model="draft.readingStatus" class="ds-input">
          <option value="all">{{ t('collection.filterReadingAll') }}</option>
          <option value="none">{{ t('book.readingNone') }}</option>
          <option value="to_read">{{ t('book.readingToRead') }}</option>
          <option value="reading">{{ t('book.readingInProgress') }}</option>
          <option value="read">{{ t('book.readingRead') }}</option>
          <option value="abandoned">{{ t('book.readingAbandoned') }}</option>
        </select>
      </div>

      <div v-if="hasFacet('loanState')" class="ds-field">
        <label class="ds-label" :for="`${uid}-loan`">{{ t('collection.filterLoanLabel') }}</label>
        <select :id="`${uid}-loan`" v-model="draft.loanState" class="ds-input">
          <option value="all">{{ t('collection.filterLoanAll') }}</option>
          <option value="lent">{{ t('collection.filterLoanLent') }}</option>
          <option value="available">{{ t('collection.filterLoanAvailable') }}</option>
        </select>
      </div>

      <div v-if="hasFacet('seriesCompletion')" class="ds-field">
        <label class="ds-label" :for="`${uid}-comp`">{{ t('collection.filterSeriesCompletionLabel') }}</label>
        <select :id="`${uid}-comp`" v-model="draft.seriesCompletion" class="ds-input">
          <option value="all">{{ t('collection.filterSeriesCompletionAll') }}</option>
          <option value="complete">{{ t('collection.filterSeriesCompletionComplete') }}</option>
          <option value="incomplete">{{ t('collection.filterSeriesCompletionIncomplete') }}</option>
        </select>
      </div>
    </div>

    <label v-if="hasFacet('integralOnly')" class="ds-checkbox">
      <input v-model="draft.integralOnly" type="checkbox" />
      <span>{{ t('collection.filterIntegralOnly') }}</span>
    </label>

    <template #footer>
      <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="resetDraft">
        {{ t('collection.filterResetBtn') }}
      </button>
      <button type="button" class="ds-btn ds-btn--primary ds-btn--sm" @click="apply">
        {{ t('collection.filterApplyBtn') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.filter-modal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr));
  gap: var(--space-3);
}

.filter-modal-grid .ds-field {
  margin-bottom: var(--space-1);
}
</style>
