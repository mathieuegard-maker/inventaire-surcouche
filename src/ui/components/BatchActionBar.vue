<script setup lang="ts">
import { TEXTS } from '../locales/fr';

defineProps<{
  selectedCount: number;
  isMixed: boolean;
  context: 'owned' | 'lent' | 'wishlist' | 'unowned';
}>();

const emit = defineEmits<{
  (e: 'execute', action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN'): void;
}>();
</script>

<template>
  <div class="sticky-actions-wrapper" v-if="selectedCount > 0" style="margin-bottom: var(--spacing-md); width: 100%;">
    <div class="group-actions-grid" style="margin-top: 0; display: flex; flex-direction: column; gap: var(--spacing-sm);">
      
      <div v-if="isMixed" class="error-banner" style="margin-bottom: var(--spacing-sm);">
        <p class="error-text-line">{{ TEXTS.batchActionBar.mixedSelectionError }}</p>
        <p class="error-advice-line">{{ TEXTS.batchActionBar.mixedSelectionAdvice }}</p>
      </div>

      <template v-else>
        <template v-if="context === 'lent'">
          <button class="wireframe-btn btn-primary" @click="emit('execute', 'RETURN')">
            {{ TEXTS.batchActionBar.btnReturnGroup }}
          </button>
        </template>

        <template v-else-if="context === 'wishlist'">
          <button class="wireframe-btn btn-primary" @click="emit('execute', 'ADD_INVENTORY')">
            {{ TEXTS.batchActionBar.btnAddInventoryGroup }}
          </button>
        </template>

        <template v-else-if="context === 'unowned'">
          <button class="wireframe-btn btn-primary" @click="emit('execute', 'ADD_INVENTORY')">
            {{ TEXTS.batchActionBar.btnAddInventoryGroup }}
          </button>
          <button class="wireframe-btn btn-danger" @click="emit('execute', 'ADD_WISHLIST')">
            {{ TEXTS.batchActionBar.btnAddWishlistGroup }}
          </button>
        </template>

        <template v-else>
          <button class="wireframe-btn btn-primary" @click="emit('execute', 'LEND')">
            {{ TEXTS.batchActionBar.btnLendGroup }}
          </button>
          <button class="wireframe-btn btn-danger" @click="emit('execute', 'ADD_WISHLIST')">
            {{ TEXTS.batchActionBar.btnToggleWishlistGroup }}
          </button>
        </template>
      </template>

    </div>
  </div>
</template>