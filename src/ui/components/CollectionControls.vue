<script setup lang="ts">
import { TEXTS } from '../locales/fr';

defineProps<{
  genres: string[];
  currentMode: 'books' | 'series' | 'oneshots';
  genreValue: string;
  sortValue: string;
}>();

const emit = defineEmits<{
  (e: 'update:genreValue', value: string): void;
  (e: 'update:sortValue', value: string): void;
}>();

const onGenreChange = (event: Event) => {
  const target = event.target as HTMLSelectElement;
  emit('update:genreValue', target.value);
};

const onSortChange = (event: Event) => {
  const target = event.target as HTMLSelectElement;
  emit('update:sortValue', target.value);
};
</script>

<template>
  <div class="collection-controls-bar">
    <div class="control-group">
      <label class="control-label">{{ TEXTS.collectionView?.filterGenreLabel }}</label>
      <select :value="genreValue" class="wireframe-input control-select" @change="onGenreChange">
        <option value="all">{{ TEXTS.collectionView?.filterGenreAll }}</option>
        <option v-for="genre in genres" :key="genre" :value="genre">{{ genre }}</option>
      </select>
    </div>

    <div class="control-group" v-if="currentMode !== 'series'">
      <label class="control-label">{{ TEXTS.collectionView?.sortLabel }}</label>
      <select :value="sortValue" class="wireframe-input control-select" @change="onSortChange">
        <option value="title">{{ TEXTS.collectionView?.sortByTitle }}</option>
        <option value="author">{{ TEXTS.collectionView?.sortByAuthor }}</option>
        <option value="date">{{ TEXTS.collectionView?.sortByDate }}</option>
      </select>
    </div>
  </div>
</template>