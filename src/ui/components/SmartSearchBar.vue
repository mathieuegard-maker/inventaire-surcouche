<script setup lang="ts">
//import { ref } from 'vue';
import BaseButton from './BaseButton.vue';

const props = defineProps<{
  modelValue: string;
  isScanningActive: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'search', value: string): void;
  (e: 'toggle-scan'): void;
}>();

const handleInputChange = (event: Event) => {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
};

const submitSearch = () => {
  if (props.modelValue.trim()) {
    emit('search', props.modelValue.trim());
  }
};
</script>

<template>
  <div class="smart-search-row">
    <BaseButton @click="emit('toggle-scan')" class="btn-scan-side">
      {{ isScanningActive ? 'FERMER' : 'SCANNER' }}
    </BaseButton>
    
    <input
      type="text"
      :value="modelValue"
      @input="handleInputChange"
      @keydown.enter.prevent="submitSearch"
      placeholder="ENTREZ UN ISBN"
      class="elastic-search-input"
    />
    
    <BaseButton @click="submitSearch" class="btn-search-side">
      RECHERCHER
    </BaseButton>
  </div>
</template>