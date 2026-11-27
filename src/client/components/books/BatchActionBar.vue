<!-- src/client/components/books/BatchActionBar.vue -->
<!-- Barre d'actions flottante épurée : affiche les actions principales sur 1 ligne nette
     et range les actions excédentaires derrière un bouton « ••• » dépliable. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { MoreHorizontal, X } from '@lucide/vue';
import type { BookView } from '../../../shared/types/domain.types';
import { computeCommonBatchActions, type BatchActionType } from '../../../shared/bibliographic/batch-actions.util';
import { useUiStore } from '../../stores/ui.store';
import { t } from '../../../shared/locales';

interface BuiltinActionItem {
  key: string;
  label: string;
  variant: 'primary' | 'default' | 'danger';
  run: () => void;
}

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

const uiStore = useUiStore();
const expanded = ref(false);
let registeredActive = false;

const summary = computed(() => computeCommonBatchActions(props.selectedBooks));
const effectiveCount = computed(() =>
  props.customCount !== undefined ? props.customCount : summary.value.count
);

const allBuiltinActions = computed<BuiltinActionItem[]>(() => {
  const s = summary.value;
  const items: BuiltinActionItem[] = [];

  if (s.eligibleCounts.ADD_OWNED > 0) {
    items.push({
      key: 'ADD_OWNED',
      label: `${t('batch.own')} (${s.eligibleCounts.ADD_OWNED})`,
      variant: 'primary',
      run: () => emit('action', 'ADD_OWNED')
    });
  }
  if (s.eligibleCounts.RETURN > 0) {
    items.push({
      key: 'RETURN',
      label: `${t('batch.returnBtn')} (${s.eligibleCounts.RETURN})`,
      variant: 'primary',
      run: () => emit('action', 'RETURN')
    });
  }
  if (s.eligibleCounts.LEND > 0) {
    items.push({
      key: 'LEND',
      label: `${t('batch.lend')} (${s.eligibleCounts.LEND})`,
      variant: 'default',
      run: () => emit('action', 'LEND')
    });
  }
  if (s.eligibleCounts.ADD_WISH > 0) {
    items.push({
      key: 'ADD_WISH',
      label: `${t('batch.wish')} (${s.eligibleCounts.ADD_WISH})`,
      variant: 'default',
      run: () => emit('action', 'ADD_WISH')
    });
  }
  if (props.showAttachSeries && s.count > 0) {
    items.push({
      key: 'ATTACH_SERIES',
      label: `${t('batch.attachSeries')} (${s.count})`,
      variant: 'default',
      run: () => emit('open-attach-series')
    });
  }
  if (s.count > 0) {
    items.push({
      key: 'GENRES',
      label: `${t('batch.addGenre')} (${s.count})`,
      variant: 'default',
      run: () => emit('open-genres')
    });
  }
  if (s.eligibleCounts.DELETE > 0) {
    items.push({
      key: 'DELETE',
      label: `${t('batch.deleteBtn')} (${s.eligibleCounts.DELETE})`,
      variant: 'danger',
      run: () => emit('action', 'DELETE')
    });
  }
  return items;
});

// Garde au maximum 2 actions prioritaires visibles sur la ligne principale (+ ••• si d'autres existent)
const primaryActions = computed(() => {
  const list = allBuiltinActions.value;
  if (list.length <= 3) return list;
  return list.slice(0, 2);
});

const overflowActions = computed(() => {
  const list = allBuiltinActions.value;
  if (list.length <= 3) return [];
  return list.slice(2);
});

function triggerAction(item: BuiltinActionItem): void {
  expanded.value = false;
  item.run();
}

watch(
  effectiveCount,
  (count) => {
    const isNowActive = count > 0;
    if (!isNowActive) expanded.value = false;
    if (isNowActive && !registeredActive) {
      registeredActive = true;
      uiStore.setBatchBarActive(true);
    } else if (!isNowActive && registeredActive) {
      registeredActive = false;
      uiStore.setBatchBarActive(false);
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (registeredActive) {
    registeredActive = false;
    uiStore.setBatchBarActive(false);
  }
});
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
        <!-- Panneau dépliable des actions secondaires (au-dessus de la barre principale) -->
        <div v-if="expanded && overflowActions.length > 0" class="batch-bar__overflow">
          <button
            v-for="act in overflowActions"
            :key="act.key"
            type="button"
            class="ds-btn ds-btn--sm"
            :class="{
              'ds-btn--primary': act.variant === 'primary',
              'ds-btn--danger-soft': act.variant === 'danger'
            }"
            @click="triggerAction(act)"
          >
            {{ act.label }}
          </button>
        </div>

        <div class="batch-bar__main-row">
          <div class="batch-bar__badge">
            <strong>{{ effectiveCount }}</strong>
            <button
              type="button"
              class="batch-bar__close"
              :aria-label="t('batch.clearSelection')"
              @click="emit('clear')"
            >
              <X :size="14" aria-hidden="true" />
            </button>
          </div>

          <div class="batch-bar__actions">
            <slot name="actions">
              <button
                v-for="act in primaryActions"
                :key="act.key"
                type="button"
                class="ds-btn ds-btn--sm batch-bar__btn"
                :class="{
                  'ds-btn--primary': act.variant === 'primary',
                  'ds-btn--danger-soft': act.variant === 'danger'
                }"
                @click="triggerAction(act)"
              >
                {{ act.label }}
              </button>

              <button
                v-if="overflowActions.length > 0"
                type="button"
                class="ds-btn ds-btn--sm ds-btn--icon batch-bar__more"
                :class="{ 'ds-btn--soft': expanded }"
                :aria-expanded="expanded"
                :aria-label="t('batch.moreActionsBtn')"
                @click="expanded = !expanded"
              >
                <MoreHorizontal :size="18" aria-hidden="true" />
              </button>
            </slot>
          </div>
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
  bottom: var(--space-3);
  z-index: 150;
  width: min(calc(100vw - 1.25rem), 680px);
  pointer-events: auto;
}

.batch-bar__inner {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 8px 10px;
  background: var(--bg-surface);
  border: 1.5px solid var(--accent);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.batch-bar__main-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.batch-bar__badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.85rem;
  flex-shrink: 0;
}

.batch-bar__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  border: none;
  background: var(--bg-surface);
  color: var(--accent);
  cursor: pointer;
}

.batch-bar__actions {
  flex: 1;
  min-inline-size: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.batch-bar__btn {
  min-block-size: 36px;
  padding: 0.35rem 0.65rem;
  font-size: 0.82rem;
  white-space: nowrap;
}

.batch-bar__more {
  min-inline-size: 36px;
  min-block-size: 36px;
  flex-shrink: 0;
}

.batch-bar__overflow {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

@media (max-width: 820px) {
  .batch-bar {
    bottom: calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px) + 8px);
  }
}
</style>
