<script setup lang="ts">
import { useRouter } from 'vue-router';
import BaseTitle from './BaseTitle.vue';
import { TEXTS } from '../locales/fr';

export type CollectionMode = 'books' | 'series' | 'oneshots';

const props = defineProps<{
  activeMode?: CollectionMode | null;
  /** Si true, émet uniquement `select-mode` sans naviguer (utilisé dans CollectionView). */
  inline?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select-mode', mode: CollectionMode): void;
}>();

const router = useRouter();

const handleSelect = (mode: CollectionMode) => {
  if (props.inline) {
    emit('select-mode', mode);
    return;
  }
  router.push({ name: 'CollectionView', query: { mode } });
};
</script>

<template>
  <div class="collection-subnav">
    <BaseTitle :text="TEXTS.collectionView?.title || 'Ma Collection'" level="h2" />
    <div class="collection-modes-tabs">
      <button
        type="button"
        :class="['tab-button', { active: activeMode === 'books' }]"
        @click="handleSelect('books')"
      >
        {{ TEXTS.collectionView?.modeBooks || 'Tous mes livres' }}
      </button>
      <button
        type="button"
        :class="['tab-button', { active: activeMode === 'series' }]"
        @click="handleSelect('series')"
      >
        {{ TEXTS.collectionView?.modeSeries || 'Mes séries' }}
      </button>
      <button
        type="button"
        :class="['tab-button', { active: activeMode === 'oneshots' }]"
        @click="handleSelect('oneshots')"
      >
        {{ TEXTS.collectionView?.modeOneShots || 'One-shots' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.collection-subnav {
  margin-bottom: 0.5rem;
}
</style>
