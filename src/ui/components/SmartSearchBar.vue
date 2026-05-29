<script setup lang="ts">
import BaseButton from './BaseButton.vue';
import { TEXTS } from '../locales/fr';

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'search', value: string): void;
  (e: 'isbn-detected', value: string): void;
  (e: 'keywords-detected', value: string): void;
}>();

const handleInputChange = (event: Event) => {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
};

const submitSearch = () => {
  const query = props.modelValue.trim();
  if (query) {
    // Nettoyage syntaxique des espaces et tirets pour l'analyse d'aiguillage
    const cleaned = query.replace(/[\s-]/g, '');
    const isIsbn = /^\d{10,13}$/.test(cleaned);
    
    if (isIsbn) {
      // Détection ISBN ──► Tunnel physique direct
      emit('isbn-detected', cleaned);
    } else {
      // Détection Mots-clés ──► Tunnel sémantique intermédiaire
      emit('keywords-detected', query);
    }
    
    // Préservation de l'événement générique pour compatibilité ascendante
    emit('search', query);
  }
};
</script>

<template>
  <div class="smart-search-row">
    <input
      type="text"
      :value="modelValue"
      @input="handleInputChange"
      @keydown.enter.prevent="submitSearch"
      :placeholder="TEXTS.searchBar.placeholder"
      class="elastic-search-input"
    />
    
    <BaseButton @click="submitSearch" class="btn-search-side">
      {{ TEXTS.searchBar.btnSearch }}
    </BaseButton>
  </div>
</template>