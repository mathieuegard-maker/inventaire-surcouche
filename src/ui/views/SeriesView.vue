<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SelectableBookList from '../components/SelectableBookList.vue';
import BaseButton from '../components/BaseButton.vue';
import LendModal from '../components/LendModal.vue';
import { TEXTS } from '../locales/fr';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { seriesOrchestrator } from '../../core/orchestrators/series.orchestrator';
import type { HumanizedBook } from '../../core/types';

const route = useRoute();
const router = useRouter();

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

const handleBack = () => {
  router.back();
};

const toggleSelection = () => {
  if (isAllSelected.value) {
    selectedIds.value = [];
  } else {
    selectedIds.value = seriesTomes.value.map(item => item.uri);
  }
};

const executeGroupAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST') => {
  if (selectedIds.value.length === 0 || isSelectionMixed.value) return;
  
  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction(action, uri);
    }
    
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (selectedIds.value.includes(tome.uri)) {
        return {
          ...tome,
          ownershipStatus: action === 'ADD_INVENTORY' ? 'owned' : 'wish'
        };
      }
      return tome;
    });
    
    selectedIds.value = [];
  } catch (error) {
    console.error(`Erreur lors de l'exécution de l'action groupée ${action} :`, error);
  }
};

const handleGroupLend = () => {
  if (isSelectionMixed.value) return;
  showLendModal.value = true;
};

const confirmGroupLend = async (friendName: string) => {
  if (selectedIds.value.length === 0 || isSelectionMixed.value) return;

  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction('LEND', uri, { friendName });
    }
    
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (selectedIds.value.includes(tome.uri)) {
        return {
          ...tome,
          loan: {
            uri: tome.uri,
            friendName,
            loanDate: Date.now()
          }
        };
      }
      return tome;
    });
    
    selectedIds.value = [];
  } catch (error) {
    console.error("Erreur lors du prêt groupé :", error);
  } finally {
    showLendModal.value = false;
  }
};

const handleGroupReturn = async () => {
  if (selectedIds.value.length === 0 || isSelectionMixed.value) return;
  
  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction('RETURN', uri);
    }
    
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (selectedIds.value.includes(tome.uri)) {
        const { loan, ...rest } = tome;
        return rest;
      }
      return tome;
    });
    
    selectedIds.value = [];
  } catch (error) {
    console.error("Erreur lors du retour groupé :", error);
  }
};
</script>

<template>
  <div class="view-container">
    <div class="series-header">
      <BaseButton @click="handleBack">
        {{ TEXTS.seriesView.back }}
      </BaseButton>
      <h2>{{ seriesName }}</h2>
      <p v-if="!isLoading">{{ seriesTomes.length }} tomes dans la série</p>
    </div>

    <div class="sticky-action-bar">
      <div class="selection-status">
        <input 
          type="checkbox" 
          class="wireframe-checkbox"
          :checked="isAllSelected" 
          @change="toggleSelection" 
          :disabled="isLoading"
        />
        <span>
          {{ selectedIds.length > 0 
            ? `${selectedIds.length} ${TEXTS.seriesView.selectedCount}` 
            : TEXTS.seriesView.emptySelection 
          }}
        </span>
      </div>

      <div class="group-actions" v-if="selectedIds.length > 0">
        
        <div v-if="isSelectionMixed" class="mixed-error-container">
          <p class="error-text-line">⚠️ {{ TEXTS.seriesView.mixedSelectionError }}</p>
          <p class="error-advice-line">{{ TEXTS.seriesView.mixedSelectionAdvice }}</p>
        </div>

        <template v-else-if="hasUnownedSelected">
          <BaseButton @click="executeGroupAction('ADD_INVENTORY')">
            {{ TEXTS.bookCard.btnAddInventory }}
          </BaseButton>
          <BaseButton @click="executeGroupAction('ADD_WISHLIST')">
            {{ TEXTS.bookCard.btnAddWishlist }}
          </BaseButton>
        </template>

        <template v-else-if="hasAvailableOwnedSelected">
          <BaseButton @click="handleGroupLend">
            {{ TEXTS.bookCard.btnLend }}
          </BaseButton>
        </template>

        <template v-else-if="hasLentSelected">
          <BaseButton @click="handleGroupReturn">
            {{ TEXTS.seriesView.btnReturnGroup || TEXTS.bookCard.btnReturn }}
          </BaseButton>
        </template>
        
      </div>
    </div>

    <div v-if="isLoading" class="result-card">
      {{ TEXTS.seriesView.loading }}
    </div>

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