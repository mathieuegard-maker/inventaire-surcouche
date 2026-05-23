<script setup lang="ts">
import { useRouter } from 'vue-router';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const props = defineProps<{
  book: HumanizedBook;
  modelValue?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const router = useRouter();

const navigateToDetail = () => {
  if (props.book.uri) {
    router.push(`/book/${encodeURIComponent(props.book.uri)}`);
  }
};

// Gestionnaire interne pour capter le clic sur toute la zone de droite
const handleZoneClick = () => {
  emit('update:modelValue', !props.modelValue);
};
</script>

<template>
  <div class="mini-card-row" @click="navigateToDetail">
    
    <div class="row-cover-container">
      <img 
        v-if="book.coverUrl" 
        :src="book.coverUrl" 
        :alt="book.title"
        class="row-cover-image"
      />
      <div v-else class="row-cover-fallback">
        <span class="fallback-title">{{ book.title }}</span>
      </div>
      
      <div v-if="book.seriesNumber" class="volume-number">
        T.{{ book.seriesNumber }}
      </div>
    </div>

    <div class="row-info-content">
      <p class="row-title">{{ book.title }}</p>
      
      <p v-if="book.series" class="row-series-meta">
        {{ book.series }}
        <span v-if="book.seriesNumber"> — Tome {{ book.seriesNumber }}</span>
      </p>
      
      <p v-if="book.authors?.length" class="row-authors">
        {{ book.authors.join(', ') }}
      </p>
    </div>

    <div class="row-status-text-column">
      <span :class="['status-text-label', book.ownershipStatus]">
        {{ 
          book.ownershipStatus === 'owned' ? TEXTS.bookStatus.owned : 
          book.ownershipStatus === 'wish' ? TEXTS.bookStatus.wish : 
          TEXTS.bookStatus.none 
        }}
      </span>
    </div>

    <div class="row-selection-area" @click.stop="handleZoneClick">
      <input 
        type="checkbox" 
        class="wireframe-checkbox item-checkbox"
        :checked="modelValue"
        @change.stop="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
    </div>

  </div>
</template>