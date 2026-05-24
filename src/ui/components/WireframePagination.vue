<script setup lang="ts">
import { ref, computed, watch } from 'vue';

const props = withDefaults(defineProps<{
  items: any[];
  searchKeys: string[];
  hasSelectAll?: boolean;
  selectAllValue?: boolean;
  selectedCount?: number;
}>(), {
  hasSelectAll: false,
  selectAllValue: false,
  selectedCount: 0
});

const emit = defineEmits<{
  (e: 'update:processedItems', filteredList: any[]): void;
  (e: 'update:selectAllValue', value: boolean): void;
}>();

// États internes
const searchQuery = ref('');
const currentPage = ref(1);
const pageSize = ref(20);

/**
 * 1. ÉTAPE DE FILTRAGE : Recherche textuelle seule
 */
const filteredItems = computed(() => {
  let list = [...props.items];

  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase().trim();
    list = list.filter(item => {
      return props.searchKeys.some(key => {
        const val = item[key];
        return val && String(val).toLowerCase().includes(query);
      });
    });
  }

  return list;
});

/**
 * 2. ÉTAPE DE PAGINATION : Découpage en tranches (20, 50, 100)
 */
const totalPages = computed(() => {
  return Math.ceil(filteredItems.value.length / pageSize.value) || 1;
});

const paginatedItems = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  const end = start + pageSize.value;
  return filteredItems.value.slice(start, end);
});

// Réinitialisation automatique de la page si les filtres changent
watch([searchQuery, pageSize], () => {
  currentPage.value = 1;
});

// Émission automatique de la liste finale vers le tableau d'affichage parent
watch(paginatedItems, (newList) => {
  emit('update:processedItems', newList);
}, { immediate: true });
</script>

<template>
  <div class="pagination-orchestrator">
    <div class="search-keyword-row">
      <input
        type="text"
        v-model="searchQuery"
        placeholder="RECHERCHER UN ALBUM OU UNE SÉRIE (EX: ASTERIX)..."
        class="wireframe-input search-keyword-input"
      />
    </div>

    <div class="pagination-controls-row">
      <div class="pagination-upper-controls">
        <div v-if="hasSelectAll" class="pagination-select-all-zone">
          <input
            type="checkbox"
            :checked="selectAllValue"
            @change="emit('update:selectAllValue', ($event.target as HTMLInputElement).checked)"
            class="wireframe-checkbox"
          />
          <span class="pagination-select-all-label">
            {{ selectedCount === 0 ? 'Tout sélectionner' : `${selectedCount} sélectionné(s)` }}
          </span>
        </div>

        <div class="page-size-selector-box">
          <select v-model="pageSize" class="wireframe-input size-select">
            <option :value="20">20 PAR PAGE</option>
            <option :value="50">50 PAR PAGE</option>
            <option :value="100">100 PAR PAGE</option>
          </select>
        </div>
      </div>

      <div class="page-navigation-buttons">
        <button
          class="wireframe-btn nav-arrow-btn"
          :disabled="currentPage === 1"
          @click="currentPage--"
        >
          [ PRÉCÉDENT ]
        </button>
        
        <span class="pagination-counter-label">
          PAGE {{ currentPage }} / {{ totalPages }}
        </span>

        <button
          class="wireframe-btn nav-arrow-btn"
          :disabled="currentPage === totalPages"
          @click="currentPage++"
        >
          [ SUIVANT ]
        </button>
      </div>
    </div>
  </div>
</template>