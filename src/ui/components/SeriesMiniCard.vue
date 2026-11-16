<script setup lang="ts">
import { ref, watch } from 'vue';
import { TEXTS } from '../locales/fr';

const props = defineProps<{
  name: string;
  ownedCount: number;
  coverUrl?: string;
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const coverFailed = ref(false);
watch(() => props.coverUrl, () => {
  coverFailed.value = false;
});
</script>

<template>
  <div class="mini-card-row" @click="$emit('click')">
    <div class="row-cover-container">
      <img
        v-if="coverUrl && !coverFailed"
        :src="coverUrl"
        :alt="name"
        class="row-cover-image"
        @error="coverFailed = true"
      />
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