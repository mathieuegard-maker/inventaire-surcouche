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
  (e: 'delete'): void;
}>();

const isOffline = computed(() => connectionState.isOffline.value);
</script>

<template>
  <div class="book-actions-flex" style="flex-direction: column; align-items: center; width: 100%;">
    <div style="display: flex; gap: var(--spacing-sm); width: 100%; justify-content: center; flex-wrap: wrap;">
      <!-- State 1: none -->
      <template v-if="ownershipStatus === 'none'">
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

      <!-- State 2: wish -->
      <template v-else-if="ownershipStatus === 'wish'">
        <BaseButton 
          :disabled="isOffline" 
          @click="!isOffline && emit('add-inventory')"
        >
          {{ TEXTS.bookCard?.btnAddInventory }}
        </BaseButton>
        <BaseButton 
          :disabled="isOffline" 
          class="btn-danger"
          @click="!isOffline && emit('delete')"
        >
          {{ TEXTS.bookDetail?.btnDeleteWish || 'Retirer de la liste d\'envies' }}
        </BaseButton>
      </template>

      <!-- State 3: owned -->
      <template v-else-if="ownershipStatus === 'owned'">
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
        <BaseButton 
          :disabled="isOffline" 
          class="btn-danger"
          @click="!isOffline && emit('delete')"
        >
          {{ TEXTS.bookDetail?.btnDelete || 'Supprimer de la collection' }}
        </BaseButton>
      </template>
    </div>
    
    <div 
      v-if="isOffline" 
      class="offline-action-warning"
    >
      ⚠️ {{ TEXTS.bookCard?.offlineActionsBlocked || 'Actions de modification désactivées hors-ligne.' }}
    </div>
  </div>
</template>