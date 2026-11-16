<script setup lang="ts">
import { TEXTS } from '../locales/fr';

defineProps<{
  filterSuggestions: string[];
  currentMode: 'books' | 'series' | 'oneshots';
  filterValue: string;
  sortValue: string;
}>();

const emit = defineEmits<{
  (e: 'update:filterValue', value: string): void;
  (e: 'update:sortValue', value: string): void;
}>();

const onFilterInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  emit('update:filterValue', target.value);
};

const clearFilter = () => {
  emit('update:filterValue', '');
};

const onSortChange = (event: Event) => {
  const target = event.target as HTMLSelectElement;
  emit('update:sortValue', target.value);
};
</script>

<template>
  <div class="collection-controls-bar">
    <div class="control-group filter-free-group">
      <label class="control-label">Filtrer</label>
      <div class="filter-input-wrap">
        <input
          type="text"
          :value="filterValue"
          list="collection-filter-suggestions"
          placeholder="Genre, série, auteur..."
          class="wireframe-input control-input-compact"
          @input="onFilterInput"
        />
        <button
          v-if="filterValue"
          type="button"
          class="clear-filter-x"
          aria-label="Effacer le filtre"
          @click="clearFilter"
        >
          ×
        </button>
      </div>
      <datalist id="collection-filter-suggestions">
        <option v-for="sug in filterSuggestions" :key="sug" :value="sug" />
      </datalist>
    </div>

    <div class="control-group" v-if="currentMode !== 'series'">
      <label class="control-label">{{ TEXTS.collectionView?.sortLabel || 'Trier par' }}</label>
      <select :value="sortValue" class="wireframe-input control-select" @change="onSortChange">
        <option value="title">{{ TEXTS.collectionView?.sortByTitle || 'Titres' }}</option>
        <option value="author">{{ TEXTS.collectionView?.sortByAuthor || 'Auteurs' }}</option>
        <option value="date">{{ TEXTS.collectionView?.sortByDate || 'Récents' }}</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
.filter-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.filter-input-wrap .control-input-compact {
  width: 100%;
  padding-right: 22px !important;
}

.clear-filter-x {
  position: absolute;
  right: 4px;
  background: none;
  border: none;
  font-size: 14px;
  font-weight: 900;
  cursor: pointer;
  color: var(--color-text-main, #000);
  padding: 0 4px;
  line-height: 1;
}
</style>
