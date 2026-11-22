<script setup lang="ts">
import { toRef } from 'vue';
import type { HumanizedBook } from '../../../core/types';
import { useBookBatchActions } from '../../composables/useBookBatchActions';
import BookMiniCard from '../BookMiniCard.vue';
import WireframeTable from '../WireframeTable.vue';
import BatchActionBar from '../BatchActionBar.vue';
import LendModal from '../LendModal.vue';
import IntegralConfigFields from '../IntegralConfigFields.vue';

const props = withDefaults(
  defineProps<{
    books: HumanizedBook[];
    modeLabel: string;
    emptyHint: string;
    idPrefix: string;
    resolvingIsbn?: string | null;
    isResolving?: boolean;
  }>(),
  {
    resolvingIsbn: null,
    isResolving: false
  }
);

const emit = defineEmits<{
  (e: 'clear-list'): void;
}>();

const booksRef = toRef(props, 'books');
const {
  selectedUris,
  selectedBooks,
  isAllSelected,
  showLendModal,
  batchBusy,
  feedbackMessage,
  errorMessage,
  editingIntegralUri,
  integralFlag,
  integralVolsText,
  integralSaving,
  toggleAll,
  toggleSelection,
  clearSelection,
  toggleIntegralEditor,
  applyIntegralEditor,
  dispatchBatchAction,
  confirmGroupLend
} = useBookBatchActions(booksRef, {
  sourceChannel: 'canal_1_barcode',
  fallbackToBackgroundCreation: true
});

const handleClearList = () => {
  clearSelection();
  emit('clear-list');
};
</script>

<template>
  <section class="scan-list-section">
    <div v-if="feedbackMessage" class="ds-banner ds-banner-success">{{ feedbackMessage }}</div>
    <div v-if="errorMessage" class="ds-banner ds-banner-error">{{ errorMessage }}</div>

    <div v-if="isResolving" class="ds-card ds-banner-info">
      <strong>Chargement de l'ouvrage ({{ resolvingIsbn }}) en cours...</strong>
    </div>

    <div v-if="books.length === 0" class="ds-card">
      <p class="empty-hint">{{ emptyHint }}</p>
    </div>

    <div v-else class="ds-card">
      <div class="ds-section-header">
        <label class="select-all-row">
          <input
            type="checkbox"
            class="wireframe-checkbox"
            :checked="isAllSelected"
            @change="toggleAll(($event.target as HTMLInputElement).checked)"
          />
          <span>
            {{ selectedUris.length === 0 ? `Tout cocher (${books.length})` : `${selectedUris.length} sélectionné(s)` }}
          </span>
        </label>
        <button type="button" class="clear-list-link" @click="handleClearList">
          Vider la liste
        </button>
      </div>

      <WireframeTable>
        <BookMiniCard
          v-for="livre in books"
          :key="livre.uri"
          :book="livre"
          :model-value="selectedUris.includes(livre.uri)"
          @update:model-value="(val) => toggleSelection(livre.uri, val)"
        >
          <template #extra>
            <button type="button" class="ds-pill-btn" @click="toggleIntegralEditor(livre)">
              {{ livre.isIntegral ? 'Modifier intégrale' : 'Déclarer intégrale' }}
            </button>
            <div v-if="editingIntegralUri === livre.uri" class="inline-integral-panel">
              <IntegralConfigFields
                v-model:is-integral="integralFlag"
                v-model:included-volumes-text="integralVolsText"
                :compact="true"
                :disabled="integralSaving"
                :input-id="`${idPrefix}-int-${livre.uri}`"
              />
              <div class="ds-actions-row">
                <button
                  type="button"
                  class="wireframe-btn primary"
                  :disabled="integralSaving"
                  @click="applyIntegralEditor(livre)"
                >
                  Valider
                </button>
                <button
                  type="button"
                  class="wireframe-btn"
                  :disabled="integralSaving"
                  @click="editingIntegralUri = null"
                >
                  Fermer
                </button>
              </div>
            </div>
          </template>
        </BookMiniCard>
      </WireframeTable>

      <BatchActionBar
        :inline="true"
        :selected-count="selectedUris.length"
        :selected-books="selectedBooks"
        :busy="batchBusy"
        @execute="dispatchBatchAction"
        @clear="clearSelection"
      />
    </div>

    <LendModal
      :show="showLendModal"
      :bookCount="selectedBooks.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />
  </section>
</template>

<style scoped>
.scan-list-section {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.empty-hint {
  margin: 0;
  font-size: 0.88rem;
  color: var(--color-text-muted);
}

.select-all-row {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.86rem;
  font-weight: 700;
  cursor: pointer;
}

.clear-list-link {
  background: transparent;
  border: none;
  color: var(--color-primary);
  font-weight: 700;
  font-size: 0.82rem;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
}

.inline-integral-panel {
  margin-top: 0.45rem;
  padding: 0.55rem;
  background: var(--color-bg-alt);
  border: var(--border-width) solid var(--color-border-hover);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
</style>
