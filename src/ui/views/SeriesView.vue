<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SelectableBookList from '../components/SelectableBookList.vue';
import BaseButton from '../components/BaseButton.vue';
import { TEXTS } from '../locales/fr';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { seriesOrchestrator } from '../../core/orchestrators/series.orchestrator';
import type { HumanizedBook } from '../../core/types';

const route = useRoute();
const router = useRouter();

const seriesId = computed(() => route.params.id as string);
const focusIdentifier = computed(() => route.query.focus as string);

const seriesTomes = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);

const bookListRef = ref<InstanceType<typeof SelectableBookList> | null>(null);

const isAllSelected = computed(() => {
  return seriesTomes.value.length > 0 && selectedIds.value.length === seriesTomes.value.length;
});

// Calcul intelligent du titre : on cherche le nom humain de la série dans le premier tome
const seriesName = computed(() => {
  if (seriesTomes.value.length > 0) {
    return seriesTomes.value[0].series || seriesTomes.value[0].seriesName || seriesId.value;
  }
  return seriesId.value;
});

onMounted(async () => {
  isLoading.value = true;
  try {
    // Utilisation de notre orchestrateur réutilisable pour alimenter proprement l'interface
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
    bookListRef.value?.toggleSelectAll(false);
  } else {
    // Sélection par URI pour être en phase complète avec le Middle-End
    selectedIds.value = seriesTomes.value.map(item => item.uri);
    bookListRef.value?.toggleSelectAll(true);
  }
};

const executeGroupAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST') => {
  if (selectedIds.value.length === 0) return;
  
  try {
    // Envoi séquentiel des actions dans la file d'attente Optimistic UI
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction(action, uri);
    }
    
    // Rafraîchissement optimiste et réactif de l'UI locale
    seriesTomes.value = seriesTomes.value.map(tome => {
      if (selectedIds.value.includes(tome.uri)) {
        return {
          ...tome,
          ownershipStatus: action === 'ADD_INVENTORY' ? 'owned' : 'wish'
        };
      }
      return tome;
    });
    
    // Réinitialisation des sélections
    selectedIds.value = [];
    if (bookListRef.value) {
      bookListRef.value.toggleSelectAll(false);
    }
  } catch (error) {
    console.error(`Erreur lors de l'exécution de l'action groupée ${action} :`, error);
  }
};

// CORRECTION 1 : Déclaration d'une fonction valide pour le bouton Prêter
const handleGroupLend = () => {
  console.log('Action de prêt groupée en cours de dev');
};
</script>

<template>
  <div class="view-container">
    <div class="series-header">
      <BaseButton @click="handleBack">
        {{ TEXTS.seriesView?.back || 'Retour' }}
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
            ? `${selectedIds.length} ${TEXTS.seriesView?.selectedCount || 'sélectionnés'}` 
            : (TEXTS.seriesView?.emptySelection || 'Aucun tome sélectionné') 
          }}
        </span>
      </div>

      <div class="group-actions" v-if="selectedIds.length > 0">
        <BaseButton @click="executeGroupAction('ADD_INVENTORY')">
          {{ TEXTS.bookCard?.btnAddInventory || 'Ajouter à l\'inventaire' }}
        </BaseButton>
        <BaseButton @click="executeGroupAction('ADD_WISHLIST')">
          {{ TEXTS.bookCard?.btnAddWishlist || 'Ajouter à la wishlist' }}
        </BaseButton>
        <BaseButton @click="handleGroupLend">
          {{ TEXTS.bookCard?.btnLend || 'Prêter' }}
        </BaseButton>
      </div>
    </div>

    <div v-if="isLoading" class="result-card">
      {{ TEXTS.seriesView?.loading || 'Chargement des tomes...' }}
    </div>

    <SelectableBookList 
      v-else
      ref="bookListRef"
      :items="seriesTomes"
      :focusIdentifier="focusIdentifier"
      @update:selection="selectedIds = $event"
    />
  </div>
</template>