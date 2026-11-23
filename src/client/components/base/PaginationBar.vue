<!-- src/client/components/base/PaginationBar.vue -->
<script setup lang="ts">
import { t } from '../../../shared/locales';

defineProps<{
  page: number;
  totalPages: number;
}>();

const emit = defineEmits<{
  (e: 'update:page', next: number): void;
}>();
</script>

<template>
  <nav v-if="totalPages > 1" class="pagination-bar" :aria-label="t('collection.pageInfo', { page, total: totalPages })">
    <button
      type="button"
      class="ds-btn ds-btn--sm"
      :disabled="page <= 1"
      @click="emit('update:page', page - 1)"
    >
      {{ t('collection.prevPage') }}
    </button>

    <span class="ds-text-muted">
      {{ t('collection.pageInfo', { page, total: totalPages }) }}
    </span>

    <button
      type="button"
      class="ds-btn ds-btn--sm"
      :disabled="page >= totalPages"
      @click="emit('update:page', page + 1)"
    >
      {{ t('collection.nextPage') }}
    </button>
  </nav>
</template>

<style scoped>
.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  padding: var(--space-4) 0;
}
</style>
