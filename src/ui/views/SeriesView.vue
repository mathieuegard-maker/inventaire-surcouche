<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SelectableBookList from '../components/SelectableBookList.vue';
import BaseButton from '../components/BaseButton.vue';
import { TEXTS } from '../locales/fr';
import { queueService } from '../../core/orchestrators/queue.orchestrator';

// AJOUT CRUCIAL : Import de ton vrai resolver de série depuis le Middle-End
import { seriesResolver } from '../../core/resolvers/series.resolver';
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
    // LE CÂBLAGE RÉEL : On appelle ton resolver qui va faire le "Windowing" (20 tomes urgents + background)
    const tomes = await seriesResolver.getFullSeries(seriesId.value);
    seriesTomes.value = tomes;
  } catch (error) {
    console.error("[VUE] Erreur lors du chargement de la série :", error);
  } finally {
    isLoading.value = false;
  }
});

const handleBack = () => {
  router.back();
};

const toggleSelection = () => {
  if (bookListRef.value) {
    bookListRef.value.toggleSelectAll(!isAllSelected.value);
  }
};

const handleUpdateSelection = (ids: string[]) => {
  selectedIds.value = ids;
};

const executeGroupAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST') => {
  // Traitement optimiste pour la réactivité visuelle (Optimistic UI)
  for (const id of selectedIds.value) {
    await queueService.enqueueAction(action, id);
    
    // Mise à jour immédiate de la carte dans l'interface
    const tome = seriesTomes.value.find(t => (t.isbn13 === id || t.uri === id));
    if (tome) {
      tome.ownershipStatus = action === 'ADD_INVENTORY' ? 'owned' : 'wish';
    }
  }
  
  // Réinitialisation de la sélection une fois le travail envoyé en file d'attente
  if (bookListRef.value) {
     bookListRef.value.toggleSelectAll(false);
  }
};
</script>

<template>
  <div class="series-view-container">
    
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
        <BaseButton @click="executeGroupAction('ADD_INVENTORY')">
          {{ TEXTS.bookCard.btnAddInventory }}
        </BaseButton>
        <BaseButton @click="executeGroupAction('ADD_WISHLIST')">
          {{ TEXTS.bookCard.btnAddWishlist }}
        </BaseButton>
        <BaseButton @click="console.log('Action de prêt groupée en cours de dev')">
          {{ TEXTS.bookCard.btnLend }}
        </BaseButton>
      </div>
    </div>

    <div v-if="isLoading" class="result-card">
      {{ TEXTS.seriesView.loading }}
    </div>

    <SelectableBookList 
      v-else
      ref="bookListRef"
      :items="seriesTomes"
      :focusIdentifier="focusIdentifier"
      @update:selection="handleUpdateSelection"
    />
  </div>
</template>