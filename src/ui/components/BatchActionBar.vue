<script setup lang="ts">
import { computed } from 'vue';
import { TEXTS } from '../locales/fr';
import { connectionState } from '../../state/connection';

defineProps<{
  selectedCount: number;
  isMixed: boolean;
  context: 'owned' | 'lent' | 'wishlist' | 'unowned';
}>();

const emit = defineEmits<{
  (e: 'execute', action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN'): void;
}>();

const isOffline = computed(() => connectionState.isOffline.value);
</script>

<template>
  <div class="sticky-actions-wrapper" v-if="selectedCount > 0" style="margin-bottom: var(--spacing-md); width: 100%;">
    <div class="group-actions-grid" style="margin-top: 0; display: flex; flex-direction: column; gap: var(--spacing-sm);">
      
      <div v-if="isOffline" class="error-banner offline-group-warning-container">
        <p class="error-text-line">⚠️ {{ TEXTS.batchActionBar?.offlineActionsBlocked || 'Les actions groupées sont désactivées en mode hors-ligne.' }}</p>
      </div>

      <div v-else-if="isMixed" class="error-banner" style="margin-bottom: var(--spacing-sm);">
        <p class="error-text-line">{{ TEXTS.batchActionBar.mixedSelectionError }}</p>
        <p class="error-advice-line">{{ TEXTS.batchActionBar.mixedSelectionAdvice }}</p>
      </div>

      <template v-else>
        <template v-if="context === 'lent'">
          <button :disabled="isOffline" class="wireframe-btn btn-primary" @click="!isOffline && emit('execute', 'RETURN')">
            {{ TEXTS.batchActionBar.btnReturnGroup }}
          </button>
        </template>

        <template v-else-if="context === 'wishlist'">
          <button :disabled="isOffline" class="wireframe-btn btn-primary" @click="!isOffline && emit('execute', 'ADD_INVENTORY')">
            {{ TEXTS.batchActionBar.btnAddInventoryGroup }}
          </button>
        </template>

        <template v-else-if="context === 'unowned'">
          <button :disabled="isOffline" class="wireframe-btn btn-primary" @click="!isOffline && emit('execute', 'ADD_INVENTORY')">
            {{ TEXTS.batchActionBar.btnAddInventoryGroup }}
          </button>
          <button :disabled="isOffline" class="wireframe-btn btn-danger" @click="!isOffline && emit('execute', 'ADD_WISHLIST')">
            {{ TEXTS.batchActionBar.btnAddWishlistGroup }}
          </button>
        </template>

        <template v-else>
          <button :disabled="isOffline" class="wireframe-btn btn-primary" @click="!isOffline && emit('execute', 'LEND')">
            {{ TEXTS.batchActionBar.btnLendGroup }}
          </button>
          <button :disabled="isOffline" class="wireframe-btn btn-danger" @click="!isOffline && emit('execute', 'ADD_WISHLIST')">
            {{ TEXTS.batchActionBar.btnToggleWishlistGroup }}
          </button>
        </template>
      </template>

    </div>
  </div>
</template>