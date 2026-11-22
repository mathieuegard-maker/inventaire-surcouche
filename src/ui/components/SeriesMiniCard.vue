<script setup lang="ts">
import { ref, watch } from 'vue';
import { TEXTS } from '../locales/fr';
import { imageUtil } from '../../core/utils/image.util';

const props = defineProps<{
  name: string;
  ownedCount: number;
  coverUrl?: string;
  isbn?: string;
  fallbackUrls?: string[];
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const coverFailed = ref(false);
watch(() => `${props.coverUrl || ''}|${props.isbn || ''}`, () => {
  coverFailed.value = false;
});

const onCoverError = (event: Event) => {
  if (!props.isbn && (!props.fallbackUrls || props.fallbackUrls.length === 0)) {
    coverFailed.value = true;
    return;
  }
  imageUtil.handleImageError(event, {
    isbn: props.isbn,
    fallbackUrls: props.fallbackUrls,
    onExhausted: () => {
      coverFailed.value = true;
    }
  });
};

const onCoverLoad = (event: Event) => {
  const img = event.target as HTMLImageElement | null;
  if (img && img.naturalWidth > 0 && (img.naturalWidth < 15 || img.naturalHeight < 15)) {
    onCoverError(event);
  }
};
</script>

<template>
  <div class="mini-card-row" @click="$emit('click')">
    <div class="row-cover-container">
      <img
        v-if="coverUrl && !coverFailed"
        :src="coverUrl"
        :data-cover-isbn="isbn"
        :alt="name"
        class="row-cover-image"
        @load="onCoverLoad"
        @error="onCoverError"
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