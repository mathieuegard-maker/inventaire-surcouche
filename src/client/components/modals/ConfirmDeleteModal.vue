<!-- src/client/components/modals/ConfirmDeleteModal.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import type { BookView } from '../../../shared/types/domain.types';
import { partitionBooksForDeletion } from '../../../shared/bibliographic/batch-actions.util';
import { t } from '../../../shared/locales';

const props = defineProps<{
  open: boolean;
  books: BookView[];
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (
    e: 'confirm',
    payload: {
      bookIds: string[];
      lentDecisions: Record<string, 'keep' | 'return_and_delete'>;
    }
  ): void;
}>();

const partitioned = computed(() => partitionBooksForDeletion(props.books));
const decisions = ref<Record<string, 'keep' | 'return_and_delete'>>({});

watch(
  () => [props.open, props.books] as const,
  ([isOpen]) => {
    if (!isOpen) return;
    const next: Record<string, 'keep' | 'return_and_delete'> = {};
    for (const lentBook of partitioned.value.lentRequiringDecision) {
      next[lentBook.id] = 'keep';
    }
    decisions.value = next;
  },
  { immediate: true }
);

const totalEligibleCount = computed(
  () => partitioned.value.standardToDelete.length + partitioned.value.lentRequiringDecision.length
);

function handleConfirm(): void {
  const allIds = [
    ...partitioned.value.standardToDelete.map((b) => b.id),
    ...partitioned.value.lentRequiringDecision.map((b) => b.id)
  ];
  emit('confirm', {
    bookIds: allIds,
    lentDecisions: { ...decisions.value }
  });
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('batch.confirmDeleteTitle')"
    max-width="560px"
    @close="emit('close')"
  >
    <div class="ds-stack">
      <p v-if="partitioned.lentRequiringDecision.length === 0">
        {{ t('batch.confirmDeleteMessage', { count: totalEligibleCount }) }}
      </p>

      <template v-else>
        <p v-if="partitioned.standardToDelete.length > 0" class="ds-panel">
          {{ t('batch.standardDeleteSummary', { count: partitioned.standardToDelete.length }) }}
        </p>

        <div class="ds-banner ds-banner--warning">
          <strong>{{ t('batch.lentConflictTitle') }}</strong>
          <p>{{ t('batch.lentConflictDesc') }}</p>
        </div>

        <div class="ds-stack">
          <div
            v-for="lentBook in partitioned.lentRequiringDecision"
            :key="lentBook.id"
            class="ds-panel lent-decision-item"
          >
            <div class="lent-decision-item__header">
              <strong>{{ lentBook.title }}</strong>
              <span v-if="lentBook.activeLoan" class="ds-badge">
                {{ t('loans.lentTo', { name: lentBook.activeLoan.borrowerName }) }}
              </span>
            </div>

            <label class="lent-radio">
              <input
                v-model="decisions[lentBook.id]"
                type="radio"
                :name="`lent-decision-${lentBook.id}`"
                value="keep"
              />
              <span>{{ t('batch.lentKeepAction') }}</span>
            </label>

            <label class="lent-radio lent-radio--danger">
              <input
                v-model="decisions[lentBook.id]"
                type="radio"
                :name="`lent-decision-${lentBook.id}`"
                value="return_and_delete"
              />
              <span>{{ t('batch.lentReturnAndDeleteAction') }}</span>
            </label>
          </div>
        </div>
      </template>
    </div>

    <template #footer>
      <button type="button" class="ds-btn" :disabled="busy" @click="emit('close')">
        {{ t('app.cancel') }}
      </button>
      <button type="button" class="ds-btn ds-btn--danger" :disabled="busy" @click="handleConfirm">
        {{ busy ? t('app.loading') : t('batch.confirmDeleteAction') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.lent-decision-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.lent-decision-item__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.lent-radio {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--text-primary);
}

.lent-radio input[type='radio'] {
  accent-color: var(--accent);
}

.lent-radio--danger {
  color: var(--danger);
}
</style>
