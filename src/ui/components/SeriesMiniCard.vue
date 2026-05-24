<script setup lang="ts">
import { TEXTS } from '../locales/fr';

defineProps<{
  name: string;
  ownedCount: number;
  coverUrl?: string;
}>();

defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <div class="mini-card-row" @click="$emit('click')">
    <div class="row-cover-container">
      <img v-if="coverUrl" :src="coverUrl" class="row-cover-image" />
      <div v-else class="row-cover-fallback">
        <span class="fallback-title">{{ name }}</span>
      </div>
    </div>
    <div class="row-info-content">
      <p class="row-title">{{ name }}</p>
      <p class="row-series-meta">
        {{ ownedCount }} {{ TEXTS.collectionView?.tomesOwned || 'TOMES' }}
      </p>
    </div>
  </div>
</template>