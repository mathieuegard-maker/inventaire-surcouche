<!-- src/client/components/books/BatchActionBar.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { BookView } from '../../../shared/types/domain.types';
import { computeCommonBatchActions, type BatchActionType } from '../../../shared/bibliographic/batch-actions.util';
import { t } from '../../../shared/locales';

const props = withDefaults(
  defineProps<{
    selectedBooks: BookView[];
    showAttachSeries?: boolean;
  }>(),
  {
    showAttachSeries: false
  }
);

const emit = defineEmits<{
  (e: 'action', action: BatchActionType): void;
  (e: 'open-genres'): void;
  (e: 'open-attach-series'): void;
  (e: 'clear'): void;
}>();

const summary = computed(() => computeCommonBatchActions(props.selectedBooks));
</script>

<template>
  <aside v-if="summary.count > 0" class="batch-bar" role="region" :aria-label="t('batch.selectedCount', { count: summary.count })">
    <div class="batch-bar__inner">
      <strong class="batch-bar__count">
        {{ t('batch.selectedCount', { count: summary.count }) }}
      </strong>

      <div class="batch-bar__actions">
        <button
          v-if="summary.eligibleCounts.ADD_OWNED > 0"
          type="button"
          class="ds-btn ds-btn--primary ds-btn--sm"
          @click="emit('action', 'ADD_OWNED')"
        >
          {{ t('batch.own') }} ({{ summary.eligibleCounts.ADD_OWNED }})
        </button>

        <button
          v-if="summary.eligibleCounts.ADD_WISH > 0"
          type="button"
          class="ds-btn ds-btn--sm"
          @click="emit('action', 'ADD_WISH')"
        >
          {{ t('batch.wish') }} ({{ summary.eligibleCounts.ADD_WISH }})
        </button>

        <button
          v-if="summary.eligibleCounts.LEND > 0"
          type="button"
          class="ds-btn ds-btn--sm"
          @click="emit('action', 'LEND')"
        >
          {{ t('batch.lend') }} ({{ summary.eligibleCounts.LEND }})
        </button>

        <button
          v-if="summary.eligibleCounts.RETURN > 0"
          type="button"
          class="ds-btn ds-btn--sm"
          @click="emit('action', 'RETURN')"
        >
          {{ t('batch.returnBtn') }} ({{ summary.eligibleCounts.RETURN }})
        </button>

        <button
          v-if="showAttachSeries"
          type="button"
          class="ds-btn ds-btn--sm"
          @click="emit('open-attach-series')"
        >
          {{ t('batch.attachSeries') }} ({{ summary.count }})
        </button>

        <button
          type="button"
          class="ds-btn ds-btn--sm"
          @click="emit('open-genres')"
        >
          {{ t('batch.addGenre') }} ({{ summary.count }})
        </button>

        <button
          v-if="summary.eligibleCounts.DELETE > 0"
          type="button"
          class="ds-btn ds-btn--danger ds-btn--sm"
          @click="emit('action', 'DELETE')"
        >
          {{ t('batch.deleteBtn') }} ({{ summary.eligibleCounts.DELETE }})
        </button>

        <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="emit('clear')">
          {{ t('batch.clearSelection') }}
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.batch-bar {
  position: sticky;
  bottom: var(--space-3);
  z-index: 90;
  margin-top: var(--space-4);
}

.batch-bar__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-surface);
  border: 2px solid var(--accent);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.batch-bar__count {
  color: var(--accent);
  font-size: 0.92rem;
}

.batch-bar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

@media (max-width: 820px) {
  .batch-bar {
    bottom: calc(var(--tabbar-height) + var(--space-2));
  }
}
</style>
