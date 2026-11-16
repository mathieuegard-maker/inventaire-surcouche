<script setup lang="ts">
import { TEXTS } from '../locales/fr';

// Définition des propriétés d'entrée (props)
defineProps<{
  show: boolean;
}>();

// Définition des événements de sortie (emits)
const emit = defineEmits<{
  (e: 'close'): void;
}>();
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="emit('close')">
      <div class="modal-box" role="dialog" aria-modal="true" :aria-label="TEXTS.onboarding.title">
        <div class="modal-header-row">
          <h2>{{ TEXTS.onboarding.title }}</h2>
          <button type="button" class="modal-close-icon" aria-label="Fermer" @click="emit('close')">✕</button>
        </div>
        
        <p class="modal-text">{{ TEXTS.onboarding.description }}</p>
        <p class="modal-text highlight">{{ TEXTS.onboarding.requirement }}</p>
        
        <div class="modal-actions">
          <button type="button" @click="emit('close')" class="btn-close">
            {{ TEXTS.onboarding.actionClose }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>