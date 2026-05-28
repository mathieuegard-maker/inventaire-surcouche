<script setup lang="ts">
import { computed } from 'vue';
import BaseButton from './BaseButton.vue';
import { TEXTS } from '../locales/fr';
import { connectionState } from '../../state/connection';

const props = defineProps<{
  ownershipStatus: 'owned' | 'wish' | 'none';
  isLent: boolean;
}>();

const emit = defineEmits<{
  (e: 'add-inventory'): void;
  (e: 'add-wishlist'): void;
  (e: 'lend'): void;
  (e: 'return'): void;
}>();

const isOwned = computed(() => props.ownershipStatus === 'owned');
const isOffline = computed(() => connectionState.isOffline.value);
</script>

<template>
  <div class="book-actions-flex" style="flex-direction: column; align-items: center; width: 100%;">
    <div style="display: flex; gap: var(--spacing-sm); width: 100%; justify-content: center;">
      <template v-if="!isOwned">
        <BaseButton 
          :disabled="isOffline" 
          @click="!isOffline && emit('add-inventory')"
        >
          {{ TEXTS.bookCard?.btnAddInventory }}
        </BaseButton>
        <BaseButton 
          :disabled="isOffline" 
          @click="!isOffline && emit('add-wishlist')"
        >
          {{ TEXTS.bookCard?.btnAddWishlist }}
        </BaseButton>
      </template>
      <template v-else>
        <BaseButton 
          v-if="isLent" 
          :disabled="isOffline" 
          @click="!isOffline && emit('return')"
        >
          {{ TEXTS.bookCard?.btnReturn || 'Livre rendu' }}
        </BaseButton>
        <BaseButton 
          v-else 
          :disabled="isOffline" 
          @click="!isOffline && emit('lend')"
        >
          {{ TEXTS.bookCard?.btnLend }}
        </BaseButton>
      </template>
    </div>
    
    <div 
      v-if="isOffline" 
      class="offline-action-warning" 
      style="margin-top: var(--spacing-sm); color: var(--color-error); font-size: var(--font-size-sm); font-weight: 500;"
    >
      ⚠️ {{ TEXTS.bookCard?.offlineActionsBlocked || 'Actions de modification désactivées hors-ligne.' }}
    </div>
  </div>
</template>