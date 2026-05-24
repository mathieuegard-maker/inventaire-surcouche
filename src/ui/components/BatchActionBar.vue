<script setup lang="ts">
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
    <div class="group-actions-grid" style="margin-top: 0;">
      <template v-if="isMixed">
        <div class="error-banner">
          <p class="error-text-line">Sélection mixte invalide</p>
          <p class="error-advice-line">Veuillez homogénéiser votre sélection pour appliquer une action groupée.</p>
        </div>
      </template>

      <template v-else-if="context === 'lent'">
        <button class="wireframe-btn btn-primary" @click="emit('execute', 'RETURN')">
          Confirmer le Retour de Lot
        </button>
      </template>

      <template v-else-if="context === 'wishlist' || context === 'unowned'">
        <button class="wireframe-btn btn-primary" @click="emit('execute', 'ADD_INVENTORY')">
          Ajouter le Lot à ma Collection
        </button>
      </template>

      <template v-else>
        <button class="wireframe-btn btn-primary" @click="emit('execute', 'LEND')">
          Prêter le Lot Sélectionné
        </button>
        <button class="wireframe-btn btn-danger" @click="emit('execute', 'ADD_WISHLIST')">
          Basculer vers la Wishlist
        </button>
      </template>
    </div>
  </div>
</template>