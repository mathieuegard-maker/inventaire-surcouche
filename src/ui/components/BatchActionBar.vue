<script setup lang="ts">
import { computed } from 'vue';
import BaseButton from './BaseButton.vue';
import { TEXTS } from '../locales/fr';

const props = defineProps<{
  modelValue: boolean; // État de la checkbox maîtresse (isAllSelected)
  selectedCount: number;
  isMixed: boolean;
  context: 'unowned' | 'owned' | 'lent' | 'wishlist'; // AJOUT : Type sémantique spécifique
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'execute', action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN'): void;
}>();

const checkboxState = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});
</script>

<template>
  <div class="sticky-action-bar">
    <div class="selection-status">
      <input 
        type="checkbox" 
        class="wireframe-checkbox"
        v-model="checkboxState"
      />
      <span>
        {{ selectedCount > 0 
          ? `${selectedCount} ${TEXTS.batchActionBar?.selectedCount}` 
          : TEXTS.batchActionBar?.emptySelection 
        }}
      </span>
    </div>

    <div class="group-actions" v-if="selectedCount > 0">
      
      <div v-if="isMixed" class="mixed-error-container">
        <p class="error-text-line">⚠️ {{ TEXTS.batchActionBar?.mixedSelectionError }}</p>
        <p class="error-advice-line">{{ TEXTS.batchActionBar?.mixedSelectionAdvice }}</p>
      </div>

      <template v-else>
        <template v-if="context === 'unowned'">
          <BaseButton @click="emit('execute', 'ADD_INVENTORY')">
            {{ TEXTS.bookCard?.btnAddInventory }}
          </BaseButton>
          <BaseButton @click="emit('execute', 'ADD_WISHLIST')">
            {{ TEXTS.bookCard?.btnAddWishlist }}
          </BaseButton>
        </template>

        <template v-else-if="context === 'wishlist'">
          <BaseButton @click="emit('execute', 'ADD_INVENTORY')">
            {{ TEXTS.bookCard?.btnAddInventory }}
          </BaseButton>
        </template>

        <template v-else-if="context === 'owned'">
          <BaseButton @click="emit('execute', 'LEND')">
            {{ TEXTS.bookCard?.btnLend }}
          </BaseButton>
        </template>

        <template v-else-if="context === 'lent'">
          <BaseButton @click="emit('execute', 'RETURN')">
            {{ TEXTS.seriesView?.btnReturnGroup || TEXTS.bookCard?.btnReturn || 'Livre rendu' }}
          </BaseButton>
        </template>
      </template>
      
    </div>
  </div>
</template>