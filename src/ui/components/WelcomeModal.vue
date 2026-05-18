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

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background-color: var(--color-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
  box-sizing: border-box;
}

.modal-box {
  background-color: var(--color-surface);
  padding: 30px;
  border-radius: var(--radius-lg);
  max-width: 450px;
  width: 100%;
  box-shadow: var(--shadow-lg);
  text-align: center;
  font-family: var(--font-main);
}

h2 {
  color: var(--color-primary);
  margin-top: 0;
  font-size: 24px;
}

.modal-text {
  font-size: 15px;
  line-height: 1.5;
  color: var(--color-text-muted);
  margin: 15px 0;
}

.modal-text.highlight {
  font-weight: 600;
  color: var(--color-text-main);
  background-color: var(--color-primary-light);
  padding: 10px;
  border-radius: var(--radius-md);
  border-left: 4px solid var(--color-primary);
}

.modal-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 25px;
}

.btn-link {
  display: block;
  padding: 12px;
  background-color: transparent;
  color: var(--color-primary);
  border: 2px solid var(--color-primary);
  border-radius: var(--radius-md);
  text-decoration: none;
  font-weight: bold;
  font-size: 15px;
  transition: background-color 0.2s;
}

.btn-link:hover {
  background-color: var(--color-primary-light);
}

.btn-close {
  padding: 12px;
  background-color: var(--color-primary);
  color: var(--color-surface);
  border: none;
  border-radius: var(--radius-md);
  font-weight: bold;
  font-size: 15px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-close:hover {
  background-color: var(--color-primary-hover);
}
</style>