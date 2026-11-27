<!-- src/client/components/books/BatchActionBar.vue -->
<!-- Barre d'actions flottante persistante au bas de l'écran (au-dessus de la bottom bar sur mobile) :
     reste accessible en permanence pendant le défilement pour sélectionner plusieurs éléments. -->
<script setup lang="ts">
import { computed } from 'vue';
import { X } from '@lucide/vue';
import type { BookView } from '../../../shared/types/domain.types';
import { computeCommonBatchActions, type BatchActionType } from '../../../shared/bibliographic/batch-actions.util';
import { t } from '../../../shared/locales';

const props = withDefaults(
  defineProps<{
    selectedBooks?: BookView[];
    customCount?: number;
    showAttachSeries?: boolean;
  }>(),
  {
    selectedBooks: () => [],
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
const effectiveCount = computed(() =>
  props.customCount !== undefined ? props.customCount : summary.value.count
);
</script>

<template>
  <Teleport to="body">
    <aside
      v-if="effectiveCount > 0"
      class="batch-bar"
      role="region"
      :aria-label="t('batch.selectedCount', { count: effectiveCount })"
    >
      <div class="batch-bar__inner">
        <div class="batch-bar__head">
          <strong class="batch-bar__count">
            {{ t('batch.selectedCount', { count: effectiveCount }) }}
          </strong>
          <button
            type="button"
            class="batch-bar__close"
            :aria-label="t('batch.clearSelection')"
            @click="emit('clear')"
          >
            <X :size="16" aria-hidden="true" />
          </button>
        </div>

        <div class="batch-bar__actions">
          <slot name="actions">
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
          </slot>
        </div>
      </div>
    </aside>
  </Teleport>
</template>

<style scoped>
.batch-bar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--space-4);
  z-index: 150;
  width: min(calc(100vw - 1.25rem), 760px);
  pointer-events: auto;
}

.batch-bar__inner {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--bg-surface);
  border: 1.5px solid var(--accent);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.batch-bar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.batch-bar__count {
  color: var(--accent);
  font-size: 0.88rem;
}

.batch-bar__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  color: var(--text-muted);
  cursor: pointer;
}

.batch-bar__actions {
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  gap: var(--space-2);
  padding-bottom: 2px;
  scrollbar-width: thin;
}

.batch-bar__actions > :deep(*) {
  flex-shrink: 0;
}

@media (min-width: 640px) {
  .batch-bar__actions {
    flex-wrap: wrap;
    overflow-x: visible;
  }
}

@media (max-width: 820px) {
  .batch-bar {
    bottom: calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px) + var(--space-2));
  }
}
</style>
