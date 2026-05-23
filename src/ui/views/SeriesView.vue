<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import SelectableBookList from '../components/SelectableBookList.vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import LendModal from '../components/LendModal.vue';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { seriesOrchestrator } from '../../core/orchestrators/series.orchestrator';
import type { HumanizedBook } from '../../core/types';

const route = useRoute();

const seriesId = computed(() => route.params.id as string);

const seriesTomes = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);
const showLendModal = ref(false);

const isAllSelected = computed(() => {
  return seriesTomes.value.length > 0 && selectedIds.value.length === seriesTomes.value.length;
});

const seriesName = computed(() => {
  if (seriesTomes.value.length > 0) {
    return seriesTomes.value[0].series || seriesId.value;
  }
  return seriesId.value;
});

const selectedBooks = computed(() => {
  return seriesTomes.value.filter(tome => selectedIds.value.includes(tome.uri));
});

const hasLentSelected = computed(() => {
  return selectedBooks.value.some(book => !!book.loan);
});

const hasAvailableOwnedSelected = computed(() => {
  return selectedBooks.value.some(book => book.ownershipStatus === 'owned' && !book.loan);
});

const hasUnownedSelected = computed(() => {
  return selectedBooks.value.some(book => book.ownershipStatus !== 'owned');
});

const isSelectionMixed = computed(() => {
  let categories = 0;
  if (hasUnownedSelected.value) categories++;
  if (hasAvailableOwnedSelected.value) categories++;
  if (hasLentSelected.value) categories++;
  return categories > 1;
});

// Déduction sémantique automatique du contexte pour la BatchActionBar
const batchContext = computed(() => {
  if (hasUnownedSelected.value) return 'unowned';
  if (hasLentSelected.value) return 'lent';
  return 'owned';
});

onMounted(async () => {
  isLoading.value = true;
  try {
    const context = await seriesOrchestrator.getCompleteSeriesForUI(seriesId.value);
    if (context) {
      seriesTomes.value = context.tomes;
    }
  } catch (e) {
    console.error("Erreur lors du chargement sémantique de la saga :", e);
  } finally {
    isLoading.value = false;
  }
});

const handleToggleAll = (checked: boolean) => {
  if (!checked) {
    selectedIds.value = [];
  } else {
    selectedIds.value = seriesTomes.value.map(item => item.uri);
  }
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN') => {
  if (selectedIds.value.length === 0 || isSelectionMixed.value) return;

  if (action === 'LEND') {
    showLendModal.value = true;
    return;
  }

  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction(action, uri);
    }

    seriesTomes.value = seriesTomes.value.map(tome => {
      if (selectedIds.value.includes(tome.uri)) {
        if (action === 'RETURN') {
          const { loan, ...rest } = tome;
          return rest;
        }
        return {
          ...tome,
          ownershipStatus: action === 'ADD_INVENTORY' ? 'owned' : 'wish'
        };
      }
      return tome;
    });

    selectedIds.value = [];
  } catch (error) {
    console.error(error);
  }
};

const confirmGroupLend = async (friendName: string) => {
  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction('LEND', uri, { friendName });
    }
    
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (selectedIds.value.includes(tome.uri)) {
        return {
          ...tome,
          loan: { uri: tome.uri, friendName, loanDate: Date.now() }
        };
      }
      return tome;
    });
    
    selectedIds.value = [];
  } catch (error) {
    console.error(error);
  } finally {
    showLendModal.value = false;
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader :title="seriesName" showBack>
      <template #actions>
        <p v-if="!isLoading">{{ seriesTomes.length }} tomes dans la série</p>
      </template>
    </BaseHeader>

    <BatchActionBar 
      v-if="!isLoading"
      :model-value="isAllSelected"
      :selected-count="selectedIds.length"
      :is-mixed="isSelectionMixed"
      :context="batchContext"
      @update:model-value="handleToggleAll"
      @execute="dispatchBatchAction"
    />

    <BaseLoading v-if="isLoading" />

    <SelectableBookList 
      v-else
      :items="seriesTomes"
      v-model="selectedIds"
    />

    <LendModal
      :show="showLendModal"
      :bookCount="selectedIds.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />
  </div>
</template>