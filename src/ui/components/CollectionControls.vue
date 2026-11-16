<script setup lang="ts">
import { computed, ref } from 'vue';
import { TEXTS } from '../locales/fr';

const props = defineProps<{
  filterSuggestions: string[];
  currentMode: 'books' | 'series' | 'oneshots';
  filterValue: string;
  sortValue: string;
}>();

const emit = defineEmits<{
  (e: 'update:filterValue', value: string): void;
  (e: 'update:sortValue', value: string): void;
}>();

const isFocused = ref(false);

const matchingSuggestions = computed(() => {
  const q = props.filterValue.trim().toLowerCase();
  const base = props.filterSuggestions || [];
  if (!q) return base.slice(0, 12);
  return base
    .filter((s) => s.toLowerCase().includes(q) && s.toLowerCase() !== q)
    .slice(0, 12);
});

const onFilterInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  emit('update:filterValue', target.value);
};

const selectSuggestion = (sug: string) => {
  emit('update:filterValue', sug);
  isFocused.value = false;
};

const handleBlur = () => {
  setTimeout(() => {
    isFocused.value = false;
  }, 150);
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
  <search class="collection-controls-bar">
    <div class="control-group filter-free-group">
      <label class="control-label" for="collection-filter-input">Filtrer</label>
      <div class="filter-input-wrap">
        <input
          id="collection-filter-input"
          type="text"
          role="combobox"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
          :aria-expanded="isFocused && matchingSuggestions.length > 0"
          aria-controls="collection-filter-listbox"
          aria-autocomplete="list"
          :value="filterValue"
          placeholder="Genre, série, auteur..."
          class="wireframe-input control-input-compact"
          @focus="isFocused = true"
          @blur="handleBlur"
          @input="onFilterInput"
        />
        <button
          v-if="filterValue"
          type="button"
          class="clear-filter-x"
          aria-label="Effacer le filtre"
          @click="clearFilter"
        >
          ✕
        </button>

        <ul
          v-if="isFocused && matchingSuggestions.length > 0"
          id="collection-filter-listbox"
          role="listbox"
          class="filter-autocomplete-menu"
        >
          <li
            v-for="sug in matchingSuggestions"
            :key="sug"
            role="option"
            class="filter-autocomplete-item"
            @mousedown.prevent="selectSuggestion(sug)"
          >
            {{ sug }}
          </li>
        </ul>
      </div>
    </div>

    <div class="control-group" v-if="currentMode !== 'series'">
      <label class="control-label" for="collection-sort-select">{{ TEXTS.collectionView?.sortLabel || 'Trier par' }}</label>
      <select id="collection-sort-select" :value="sortValue" class="wireframe-input control-select" @change="onSortChange">
        <option value="title">{{ TEXTS.collectionView?.sortByTitle || 'Titres' }}</option>
        <option value="author">{{ TEXTS.collectionView?.sortByAuthor || 'Auteurs' }}</option>
        <option value="date">{{ TEXTS.collectionView?.sortByDate || 'Récents' }}</option>
      </select>
    </div>
  </search>
</template>

<style scoped>
.filter-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  inline-size: 100%;
}

.filter-input-wrap .control-input-compact {
  inline-size: 100%;
  padding-inline-end: 1.75rem !important;
  appearance: none;
  -webkit-appearance: none;
}

.clear-filter-x {
  position: absolute;
  inset-inline-end: 0.35rem;
  background: none;
  border: none;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  color: var(--color-text-muted, #64748b);
  padding: 0.2rem 0.35rem;
  line-height: 1;
}

.clear-filter-x:hover {
  color: var(--color-text-main, #0f172a);
}

.filter-autocomplete-menu {
  position: absolute;
  inset-block-start: calc(100% + 4px);
  inset-inline: 0;
  z-index: 300;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background: var(--color-bg-main, #ffffff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  box-shadow: var(--shadow-md, 0 4px 6px -1px rgba(15, 23, 42, 0.1));
  max-block-size: 210px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.filter-autocomplete-item {
  padding: 0.45rem 0.6rem;
  font-size: 0.8125rem;
  line-height: 1.3;
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-text-main, #0f172a);
}

.filter-autocomplete-item:hover {
  background: var(--color-primary-light, #eef2ff);
  color: var(--color-primary, #4f46e5);
}
</style>
