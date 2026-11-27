<!-- src/client/components/base/ListControlBar.vue -->
<!-- Barre de contrôle standardisée pour TOUTES les listes : recherche libre, bouton « Filtrer » (modale composite),
     sélecteur de tri, bouton « Tout sélectionner » et pastilles cliquables des filtres actifs. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { CheckSquare, Search, SlidersHorizontal, X } from '@lucide/vue';
import ListFilterModal, { type FilterFacetKey } from './ListFilterModal.vue';
import {
  countActiveAdvancedFilters,
  createEmptyListFilters,
  type CompositeListFilters,
  type ExtractedFilterFacets
} from '../../../shared/bibliographic/list-filter.util';
import { t } from '../../../shared/locales';

export interface ListSortOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    filters: CompositeListFilters;
    facets?: ExtractedFilterFacets;
    enabledFacets?: readonly FilterFacetKey[];
    showFilterButton?: boolean;
    placeholder?: string;
    sortValue?: string;
    sortOptions?: readonly ListSortOption[];
    showSelectAll?: boolean;
    selectAllDisabled?: boolean;
  }>(),
  {
    facets: () => ({ genres: [], authors: [], publishers: [], seriesNames: [] }),
    showFilterButton: true,
    showSelectAll: false,
    selectAllDisabled: false
  }
);

const emit = defineEmits<{
  (e: 'update:filters', next: CompositeListFilters): void;
  (e: 'update:sortValue', next: string): void;
  (e: 'select-all'): void;
}>();

const filterModalOpen = ref(false);

const activeFilterCount = computed(() => countActiveAdvancedFilters(props.filters));

interface ActiveChip {
  key: keyof CompositeListFilters;
  label: string;
}

const activeChips = computed<ActiveChip[]>(() => {
  const chips: ActiveChip[] = [];
  const f = props.filters;
  if (f.genre.trim()) chips.push({ key: 'genre', label: `${t('collection.filterGenreLabel')} : ${f.genre}` });
  if (f.author.trim()) chips.push({ key: 'author', label: `${t('collection.filterAuthorLabel')} : ${f.author}` });
  if (f.publisher.trim()) chips.push({ key: 'publisher', label: `${t('collection.filterPublisherLabel')} : ${f.publisher}` });
  if (f.series.trim()) chips.push({ key: 'series', label: `${t('collection.filterSeriesLabel')} : ${f.series}` });
  if (f.volumeNumber.trim()) chips.push({ key: 'volumeNumber', label: `T.${f.volumeNumber}` });
  if (f.readingStatus !== 'all') {
    const map: Record<string, string> = {
      none: t('book.readingNone'),
      to_read: t('book.readingToRead'),
      reading: t('book.readingInProgress'),
      read: t('book.readingRead'),
      abandoned: t('book.readingAbandoned')
    };
    chips.push({ key: 'readingStatus', label: map[f.readingStatus] ?? f.readingStatus });
  }
  if (f.loanState === 'lent') chips.push({ key: 'loanState', label: t('collection.filterLoanLent') });
  if (f.loanState === 'available') chips.push({ key: 'loanState', label: t('collection.filterLoanAvailable') });
  if (f.integralOnly) chips.push({ key: 'integralOnly', label: t('book.integralLabel') });
  if (f.seriesCompletion === 'complete') chips.push({ key: 'seriesCompletion', label: t('collection.filterSeriesCompletionComplete') });
  if (f.seriesCompletion === 'incomplete') chips.push({ key: 'seriesCompletion', label: t('collection.filterSeriesCompletionIncomplete') });
  return chips;
});

function updateQuery(event: Event): void {
  const nextQuery = (event.target as HTMLInputElement).value;
  emit('update:filters', { ...props.filters, query: nextQuery });
}

function clearQuery(): void {
  emit('update:filters', { ...props.filters, query: '' });
}

function removeChip(key: keyof CompositeListFilters): void {
  const empty = createEmptyListFilters();
  emit('update:filters', { ...props.filters, [key]: empty[key] });
}

function clearAllAdvanced(): void {
  const empty = createEmptyListFilters();
  emit('update:filters', { ...empty, query: props.filters.query });
}

function onSortChange(event: Event): void {
  emit('update:sortValue', (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="list-control">
    <div class="list-control__search-row">
      <div class="list-control__search-wrap">
        <Search :size="16" class="list-control__search-icon" aria-hidden="true" />
        <input
          type="search"
          class="ds-input list-control__search-input"
          :value="filters.query"
          :placeholder="placeholder || t('collection.filterPlaceholder')"
          @input="updateQuery"
        />
        <button
          v-if="filters.query"
          type="button"
          class="list-control__clear-btn"
          :aria-label="t('app.clear')"
          @click="clearQuery"
        >
          <X :size="15" aria-hidden="true" />
        </button>
      </div>

      <button
        v-if="showFilterButton"
        type="button"
        class="ds-btn ds-btn--sm list-control__filter-btn"
        :class="{ 'ds-btn--soft': activeFilterCount > 0 }"
        @click="filterModalOpen = true"
      >
        <SlidersHorizontal :size="15" aria-hidden="true" />
        <span>{{ t('collection.filterBtn') }}</span>
        <span v-if="activeFilterCount > 0" class="list-control__badge">{{ activeFilterCount }}</span>
      </button>
    </div>

    <div v-if="(sortOptions && sortOptions.length > 0) || showSelectAll || $slots.extra" class="list-control__sub-row">
      <select
        v-if="sortOptions && sortOptions.length > 0"
        class="ds-input list-control__sort"
        :value="sortValue"
        @change="onSortChange"
      >
        <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>

      <slot name="extra" />

      <button
        v-if="showSelectAll"
        type="button"
        class="ds-btn ds-btn--sm"
        :disabled="selectAllDisabled"
        @click="emit('select-all')"
      >
        <CheckSquare :size="15" aria-hidden="true" />
        <span>{{ t('collection.selectAll') }}</span>
      </button>
    </div>

    <div v-if="activeChips.length > 0" class="list-control__chips">
      <span v-for="chip in activeChips" :key="chip.key" class="ds-chip ds-chip--clickable">
        <span>{{ chip.label }}</span>
        <button
          type="button"
          class="ds-chip__remove"
          :aria-label="t('app.clear')"
          @click="removeChip(chip.key)"
        >
          <X :size="13" aria-hidden="true" />
        </button>
      </span>
      <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="clearAllAdvanced">
        {{ t('collection.filterClearAll') }}
      </button>
    </div>

    <ListFilterModal
      :open="filterModalOpen"
      :model-value="filters"
      :facets="facets"
      :enabled-facets="enabledFacets"
      @close="filterModalOpen = false"
      @update:model-value="emit('update:filters', $event)"
    />
  </div>
</template>

<style scoped>
.list-control {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.list-control__search-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.list-control__search-wrap {
  position: relative;
  flex: 1 1 auto;
  min-inline-size: 0;
  display: flex;
  align-items: center;
}

.list-control__search-icon {
  position: absolute;
  left: 11px;
  color: var(--text-muted);
  pointer-events: none;
}

.list-control__search-input {
  padding-left: 34px;
  padding-right: 34px;
}

.list-control__clear-btn {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.list-control__filter-btn {
  flex-shrink: 0;
  min-block-size: var(--target-size);
}

.list-control__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 19px;
  height: 19px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 0.72rem;
  font-weight: 700;
}

.list-control__sub-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.list-control__sort {
  flex: 1 1 160px;
  min-block-size: 38px;
  padding: 0.35rem 0.7rem;
  font-size: 0.86rem;
}

.list-control__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
</style>
