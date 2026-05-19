<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const props = defineProps<{
  items: HumanizedBook[];
  focusIdentifier?: string;
}>();

const emit = defineEmits<{
  (e: 'update:selection', selectedIds: string[]): void;
}>();

const selectedIds = ref<string[]>([]);

watch(selectedIds, (newVal) => {
  emit('update:selection', newVal);
}, { deep: true });

onMounted(async () => {
  await nextTick();
  if (props.focusIdentifier) {
    const targetElement = document.getElementById(`book-item-${props.focusIdentifier}`);
    if (targetElement) {
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // La classe highlight-focus ajoutera un flash visuel noir (via CSS)
      targetElement.classList.add('highlight-focus');
    }
  }
});

const toggleSelectAll = (selectAll: boolean) => {
  if (selectAll) {
    selectedIds.value = props.items.map(item => item.isbn13 || item.uri);
  } else {
    selectedIds.value = [];
  }
};

defineExpose({
  toggleSelectAll,
  selectedIds
});
</script>

<template>
  <div class="selectable-list-container">
    <div 
      v-for="item in items" 
      :key="item.isbn13 || item.uri"
      :id="`book-item-${item.isbn13 || item.uri}`"
      class="list-item-card"
    >
      <div class="list-item-checkbox">
        <input 
          type="checkbox" 
          class="wireframe-checkbox"
          :value="item.isbn13 || item.uri" 
          v-model="selectedIds"
        />
      </div>

      <div class="list-item-thumbnail-wrapper">
        <img v-if="item.coverUrl" :src="item.coverUrl" :alt="item.title" class="list-item-thumbnail" />
        <div v-else class="list-item-thumbnail-placeholder">X</div>
      </div>

      <div class="list-item-info">
        <p class="list-item-title">
          <span v-if="item.seriesNumber">Tome {{ item.seriesNumber }} - </span>
          {{ item.title }}
        </p>
        <p class="list-item-subtitle" v-if="item.subtitle">{{ item.subtitle }}</p>
      </div>

      <div class="list-item-badge">
        <span class="badge" :class="item.ownershipStatus === 'owned' ? 'owned' : 'missing'">
          {{ item.ownershipStatus === 'owned' ? TEXTS.bookCard.owned : TEXTS.bookCard.missing }}
        </span>
      </div>
    </div>
  </div>
</template>