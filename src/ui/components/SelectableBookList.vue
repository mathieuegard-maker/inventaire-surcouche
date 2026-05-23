<script setup lang="ts">
import BookMiniCard from './BookMiniCard.vue';
import type { HumanizedBook } from '../../core/types';

const props = defineProps<{
  items: HumanizedBook[];
  modelValue: string[]; // Reçoit le tableau des URIs sélectionnées
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', selectedIds: string[]): void;
}>();

// Gestion de la sélection individuelle d'une ligne
const handleItemSelection = (uri: string, isSelected: boolean) => {
  const currentSelection = [...props.modelValue];
  if (isSelected) {
    if (!currentSelection.includes(uri)) {
      currentSelection.push(uri);
    }
  } else {
    const index = currentSelection.indexOf(uri);
    if (index > -1) {
      currentSelection.splice(index, 1);
    }
  }
  // CRITICAL : On émet la nouvelle sélection pour mettre à jour le v-model du parent
  emit('update:modelValue', currentSelection);
};
</script>

<template>
  <div class="series-list-container">
    <BookMiniCard 
      v-for="item in items" 
      :key="item.uri"
      :book="item"
      :modelValue="modelValue.includes(item.uri)"
      @update:modelValue="(val) => handleItemSelection(item.uri, val)"
    />
  </div>
</template>