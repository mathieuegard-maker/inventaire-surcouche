<script setup lang="ts">
import { computed } from 'vue';
import BaseButton from './BaseButton.vue';
import { TEXTS } from '../locales/fr';

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
</script>

<template>
  <div class="book-actions-flex">
    <template v-if="!isOwned">
      <BaseButton @click="emit('add-inventory')">
        {{ TEXTS.bookCard?.btnAddInventory }}
      </BaseButton>
      <BaseButton @click="emit('add-wishlist')">
        {{ TEXTS.bookCard?.btnAddWishlist }}
      </BaseButton>
    </template>
    <template v-else>
      <BaseButton v-if="isLent" @click="emit('return')">
        {{ TEXTS.bookCard?.btnReturn || 'Livre rendu' }}
      </BaseButton>
      <BaseButton v-else @click="emit('lend')">
        {{ TEXTS.bookCard?.btnLend }}
      </BaseButton>
    </template>
  </div>
</template>