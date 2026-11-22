<script setup lang="ts">
import { computed, ref } from 'vue';
import { connectionState } from '../../state/connection';
import {
  computeCommonBatchActions,
  type BatchActionType,
  type BatchBookLike
} from '../../core/utils/batch-actions.util';

const props = withDefaults(
  defineProps<{
    selectedCount: number;
    selectedBooks?: Array<BatchBookLike>;
    isMixed?: boolean;
    context?: 'owned' | 'lent' | 'wishlist' | 'unowned';
    inline?: boolean;
    busy?: boolean;
    busyLabel?: string;
    allowSeriesAttach?: boolean;
    allowGenreAdd?: boolean;
    confirmDelete?: boolean;
  }>(),
  {
    selectedBooks: undefined,
    isMixed: false,
    context: 'owned',
    inline: false,
    busy: false,
    busyLabel: 'Enregistrement...',
    allowSeriesAttach: false,
    allowGenreAdd: false,
    confirmDelete: true
  }
);

const emit = defineEmits<{
  (e: 'execute', action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE'): void;
  (e: 'attach-series'): void;
  (e: 'add-genre'): void;
  (e: 'clear'): void;
}>();

const isOffline = computed(() => connectionState.isOffline.value);
const showDeleteConfirmModal = ref(false);

const commonSummary = computed(() => {
  if (props.selectedBooks && props.selectedBooks.length > 0) {
    return computeCommonBatchActions(props.selectedBooks);
  }
  const c = props.selectedCount;
  const zero = { ADD_INVENTORY: 0, ADD_WISHLIST: 0, LEND: 0, RETURN: 0, DELETE: 0 };
  if (props.context === 'lent') {
    return {
      count: c,
      actions: ['RETURN', 'DELETE'] as BatchActionType[],
      eligibleCounts: { ...zero, RETURN: c, DELETE: c },
      isHomogeneousDelete: 'lent' as const
    };
  }
  if (props.context === 'wishlist') {
    return {
      count: c,
      actions: ['ADD_INVENTORY', 'DELETE'] as BatchActionType[],
      eligibleCounts: { ...zero, ADD_INVENTORY: c, DELETE: c },
      isHomogeneousDelete: 'wish' as const
    };
  }
  if (props.context === 'unowned') {
    return {
      count: c,
      actions: ['ADD_INVENTORY', 'ADD_WISHLIST'] as BatchActionType[],
      eligibleCounts: { ...zero, ADD_INVENTORY: c, ADD_WISHLIST: c },
      isHomogeneousDelete: null
    };
  }
  return {
    count: c,
    actions: ['LEND', 'DELETE'] as BatchActionType[],
    eligibleCounts: { ...zero, LEND: c, DELETE: c },
    isHomogeneousDelete: 'owned' as const
  };
});

const hasAction = (act: BatchActionType) => commonSummary.value.actions.includes(act);
const countSuffix = (act: BatchActionType) => {
  const n = commonSummary.value.eligibleCounts[act];
  return n > 0 && n < props.selectedCount ? ` (${n})` : '';
};

const handleDeleteClick = () => {
  if (props.confirmDelete) {
    showDeleteConfirmModal.value = true;
  } else {
    emit('execute', 'DELETE');
  }
};

const confirmDeleteAction = () => {
  showDeleteConfirmModal.value = false;
  emit('execute', 'DELETE');
};
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <div
      v-if="selectedCount > 0"
      :class="['batch-floating-dock', { 'is-inline': inline }]"
      role="region"
      aria-label="Barre d'actions sur la sélection"
    >
      <div class="batch-dock-card">
        <span class="batch-count-pill">{{ selectedCount }}</span>

        <span v-if="busy" class="batch-busy-pill">{{ busyLabel }}</span>

        <span v-else-if="isOffline" class="batch-hint-warn">Hors-ligne</span>

        <template v-else-if="commonSummary.actions.length === 0 && !allowSeriesAttach && !allowGenreAdd">
          <span class="batch-hint-warn">Aucune action disponible</span>
        </template>

        <div
          v-else
          role="toolbar"
          focusgroup="toolbar wrap"
          aria-label="Actions sur la sélection"
          class="batch-toolbar-group"
        >
          <button
            v-if="hasAction('ADD_INVENTORY')"
            type="button"
            class="batch-chip-btn primary"
            :disabled="busy"
            @click="emit('execute', 'ADD_INVENTORY')"
          >
            Posséder{{ countSuffix('ADD_INVENTORY') }}
          </button>

          <button
            v-if="hasAction('ADD_WISHLIST')"
            type="button"
            class="batch-chip-btn"
            :disabled="busy"
            @click="emit('execute', 'ADD_WISHLIST')"
          >
            Wishlist{{ countSuffix('ADD_WISHLIST') }}
          </button>

          <button
            v-if="hasAction('LEND')"
            type="button"
            class="batch-chip-btn primary"
            :disabled="busy"
            @click="emit('execute', 'LEND')"
          >
            Prêter{{ countSuffix('LEND') }}
          </button>

          <button
            v-if="hasAction('RETURN')"
            type="button"
            class="batch-chip-btn primary"
            :disabled="busy"
            @click="emit('execute', 'RETURN')"
          >
            Rendre{{ countSuffix('RETURN') }}
          </button>

          <button
            v-if="allowSeriesAttach"
            type="button"
            class="batch-chip-btn secondary"
            :disabled="busy"
            @click="emit('attach-series')"
          >
            Rattacher série
          </button>

          <button
            v-if="allowGenreAdd"
            type="button"
            class="batch-chip-btn secondary"
            :disabled="busy"
            @click="emit('add-genre')"
          >
            + Genre
          </button>

          <button
            v-if="hasAction('DELETE')"
            type="button"
            class="batch-chip-btn danger"
            :disabled="busy"
            @click="handleDeleteClick"
          >
            Supprimer{{ countSuffix('DELETE') }}
          </button>
        </div>

        <button
          type="button"
          class="batch-clear-x"
          aria-label="Tout désélectionner"
          title="Tout désélectionner"
          @click="emit('clear')"
        >
          ✕
        </button>
      </div>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="showDeleteConfirmModal" class="modal-overlay" @click.self="showDeleteConfirmModal = false">
      <div class="modal-box" role="dialog" aria-modal="true" aria-label="Confirmer la suppression">
        <h2>Confirmer la suppression</h2>
        <p class="modal-text">
          Êtes-vous sûr de vouloir supprimer
          <strong>{{ commonSummary.eligibleCounts.DELETE || selectedCount }} ouvrage(s)</strong>
          de votre bibliothèque ?
        </p>
        <div class="modal-actions">
          <button type="button" class="btn-danger" @click="confirmDeleteAction">
            Supprimer définitivement
          </button>
          <button type="button" class="btn-close" @click="showDeleteConfirmModal = false">
            Annuler
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.batch-floating-dock {
  position: fixed;
  inset-block-end: max(0.85rem, env(safe-area-inset-bottom));
  inset-inline-start: 50%;
  transform: translateX(-50%);
  z-index: 1200;
  inline-size: max-content;
  max-inline-size: calc(100vw - 1.5rem);
  pointer-events: auto;
}

.batch-floating-dock.is-inline {
  position: sticky;
  inset-block-end: 0.25rem;
  inset-inline-start: auto;
  transform: none;
  inline-size: 100%;
  max-inline-size: 100%;
  margin-block-start: 0.5rem;
  z-index: 20;
}

.batch-dock-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.7rem;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(8px);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-modal, 0 20px 25px -5px rgba(15, 23, 42, 0.16), 0 8px 10px -6px rgba(15, 23, 42, 0.08));
}

.batch-count-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 26px;
  min-block-size: 26px;
  padding-inline: 0.45rem;
  border-radius: 9999px;
  background: var(--color-primary-light, #eef2ff);
  color: var(--color-primary, #4f46e5);
  font-size: 0.78rem;
  font-weight: 700;
}

.batch-toolbar-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.batch-chip-btn {
  min-block-size: 36px;
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-main, #0f172a);
  font-family: var(--font-main);
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.25;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.batch-chip-btn:hover {
  background: var(--color-bg-alt, #f8fafc);
}

.batch-chip-btn.primary {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #ffffff;
}

.batch-chip-btn.primary:hover {
  background: var(--color-primary-hover, #4338ca);
}

.batch-chip-btn.secondary {
  background: #eef2ff;
  border-color: #c7d2fe;
  color: #3730a3;
}

.batch-chip-btn.secondary:hover {
  background: #e0e7ff;
}

.batch-chip-btn.danger {
  background: #ef4444;
  border-color: #ef4444;
  color: #ffffff;
}

.batch-chip-btn.danger:hover {
  background: #dc2626;
}

.batch-chip-btn:focus-visible,
.batch-clear-x:focus-visible {
  outline: 2px solid var(--color-primary, #4f46e5);
  outline-offset: 2px;
}

.batch-hint-warn {
  font-size: 0.78rem;
  font-weight: 600;
  color: #b45309;
  padding-inline: 0.35rem;
}

.batch-busy-pill {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--color-primary, #4f46e5);
  padding-inline: 0.5rem;
  white-space: nowrap;
}

.batch-clear-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 32px;
  min-block-size: 32px;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 9999px;
  background: var(--color-bg-alt, #f8fafc);
  color: var(--color-text-muted, #64748b);
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

.batch-clear-x:hover {
  background: #e2e8f0;
  color: var(--color-text-main, #0f172a);
}
</style>
