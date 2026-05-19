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
  <div v-if="show" class="modal-overlay">
    <div class="modal-box">
      <h2>{{ TEXTS.onboarding.title }}</h2>
      
      <p class="modal-text">{{ TEXTS.onboarding.description }}</p>
      <p class="modal-text highlight">{{ TEXTS.onboarding.requirement }}</p>
      
      <div class="modal-actions">
        <a 
          href="https://inventaire.io" 
          target="_blank" 
          rel="noopener noreferrer" 
          class="btn-link"
        >
          {{ TEXTS.onboarding.actionLink }}
        </a>
        
        <button @click="emit('close')" class="btn-close">
          {{ TEXTS.onboarding.actionClose }}
        </button>
      </div>
    </div>
  </div>
</template>