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

const translateFriendName = (name?: string): string => {
  if (!name) return TEXTS.loansView?.unknownFriend || 'Inconnu';
  if (name === 'Inconnu') return TEXTS.loansView?.unknownFriend || 'Inconnu';
  if (name === 'Inconnu (Ajout web)') return TEXTS.loansView?.unknownFriendWeb || 'Inconnu (Ajout web)';
  if (name === 'Inconnu (Restauration)') return TEXTS.loansView?.unknownFriendRestored || 'Inconnu (Restauration)';
  return name;
};

const navigateToDetail = () => {
  if (props.book.uri) {
    router.push(`/book/${encodeURIComponent(props.book.uri)}`);
  }
};

const handleZoneClick = () => {
  emit('update:modelValue', !props.modelValue);
};
</script>

<template>
  <div class="mini-card-row" @click="navigateToDetail">
    
    <div class="row-cover-container">
      <img 
        v-if="book.localCover || book.coverUrl" 
        :src="book.localCover || book.coverUrl" 
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
      
      <p v-if="book.loan?.friendName" class="row-authors">
        👉 {{ translateFriendName(book.loan.friendName) }}
      </p>
      <p v-else-if="book.series" class="row-series-meta">
        {{ book.series }}
        <span v-if="book.seriesNumber"> — Tome {{ book.seriesNumber }}</span>
      </p>
      
      <p v-if="book.authors?.length && !book.loan" class="row-authors">
        {{ book.authors.join(', ') }}
      </p>
    </div>

    <div class="row-status-text-column">
      <span :class="['status-text-label', book.loan ? 'lent' : book.ownershipStatus]">
        {{ 
          book.loan ? TEXTS.bookStatus?.lent || 'Prêté' :
          book.ownershipStatus === 'owned' ? TEXTS.bookStatus?.owned : 
          book.ownershipStatus === 'wish' ? TEXTS.bookStatus?.wish : 
          TEXTS.bookStatus?.none 
        }}
      </span>
    </div>

    <div class="row-selection-area" @click.stop="handleZoneClick">
      <input 
        type="checkbox" 
        class="wireframe-checkbox item-checkbox"
        :checked="modelValue"
        @click.stop
        @change.stop="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
    </div>

  </div>
</template>