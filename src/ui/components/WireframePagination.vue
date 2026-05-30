<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { TEXTS } from '../locales/fr';

const props = withDefaults(defineProps<{
  items: any[];
  searchKeys: string[];
  hasSelectAll?: boolean;
  selectAllValue?: boolean;
  selectedCount?: number;
  currentPage?: number;
  pageSize?: number;
  searchQuery?: string;
}>(), {
  hasSelectAll: false,
  selectAllValue: false,
  selectedCount: 0,
  currentPage: undefined,
  pageSize: undefined,
  searchQuery: undefined
});

const emit = defineEmits<{
  (e: 'update:processedItems', filteredList: any[]): void;
  (e: 'update:selectAllValue', value: boolean): void;
  (e: 'update:currentPage', page: number): void;
  (e: 'update:pageSize', size: number): void;
  (e: 'update:searchQuery', query: string): void;
}>();

// États internes avec synchronisation bidirectionnelle
const internalSearchQuery = ref(props.searchQuery ?? '');
const internalPage = ref(props.currentPage ?? 1);
const internalPageSize = ref(props.pageSize ?? 20);

// Sync de l'extérieur vers l'intérieur
watch(() => props.currentPage, (val) => {
  if (val !== undefined && val !== internalPage.value) {
    internalPage.value = val;
  }
});
watch(() => props.pageSize, (val) => {
  if (val !== undefined && val !== internalPageSize.value) {
    internalPageSize.value = val;
  }
});
watch(() => props.searchQuery, (val) => {
  if (val !== undefined && val !== internalSearchQuery.value) {
    internalSearchQuery.value = val;
  }
});

// Émissions vers l'extérieur
watch(internalPage, (val) => {
  emit('update:currentPage', val);
});
watch(internalPageSize, (val) => {
  emit('update:pageSize', val);
});
watch(internalSearchQuery, (val) => {
  emit('update:searchQuery', val);
});

/**
 * 1. ÉTAPE DE FILTRAGE : Recherche textuelle seule
 */
const filteredItems = computed(() => {
  let list = [...props.items];

  if (internalSearchQuery.value.trim()) {
    const query = internalSearchQuery.value.toLowerCase().trim();
    list = list.filter(item => {
      return props.searchKeys.some(key => {
        const val = item[key];
        if (!val) return false;
        if (Array.isArray(val)) {
          return val.some(element => element && String(element).toLowerCase().includes(query));
        }
        return String(val).toLowerCase().includes(query);
      });
    });
  }

  return list;
});

/**
 * 2. ÉTAPE DE PAGINATION : Découpage en tranches
 */
const totalPages = computed(() => {
  return Math.ceil(filteredItems.value.length / internalPageSize.value) || 1;
});

const paginatedItems = computed(() => {
  const start = (internalPage.value - 1) * internalPageSize.value;
  const end = start + internalPageSize.value;
  return filteredItems.value.slice(start, end);
});

// Réinitialisation automatique de la page si les filtres changent
watch([internalSearchQuery, internalPageSize], () => {
  internalPage.value = 1;
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
        v-model="internalSearchQuery"
        :placeholder="TEXTS.pagination.placeholder"
        class="wireframe-input search-keyword-input"
      />
    </div>

    <!-- Contrôles de pagination du haut -->
    <div class="pagination-controls-row upper-pagination">
      <div class="pagination-upper-controls">
        <div v-if="hasSelectAll" class="pagination-select-all-zone">
          <input
            type="checkbox"
            :checked="selectAllValue"
            @change="emit('update:selectAllValue', ($event.target as HTMLInputElement).checked)"
            class="wireframe-checkbox"
          />
          <span class="pagination-select-all-label">
            {{ selectedCount === 0 ? TEXTS.pagination.selectAll : selectedCount + ' ' + TEXTS.pagination.selectedCount }}
          </span>
        </div>

        <div class="page-size-selector-box">
          <select v-model="internalPageSize" class="wireframe-input size-select">
            <option :value="20">20 {{ TEXTS.pagination.perPage }}</option>
            <option :value="50">50 {{ TEXTS.pagination.perPage }}</option>
            <option :value="100">100 {{ TEXTS.pagination.perPage }}</option>
          </select>
        </div>
      </div>

      <div class="page-navigation-buttons">
        <button
          class="wireframe-btn nav-arrow-btn"
          :disabled="internalPage === 1"
          @click="internalPage--"
        >
          [ {{ TEXTS.pagination.previous }} ]
        </button>
        
        <span class="pagination-counter-label">
          {{ TEXTS.pagination.page }} {{ internalPage }} / {{ totalPages }}
        </span>

        <button
          class="wireframe-btn nav-arrow-btn"
          :disabled="internalPage === totalPages"
          @click="internalPage++"
        >
          [ {{ TEXTS.pagination.next }} ]
        </button>
      </div>
    </div>

    <!-- Le contenu de la liste/table est inséré ici en sandwich -->
    <slot></slot>

    <!-- Contrôles de pagination du bas -->
    <div class="pagination-controls-row lower-pagination">
      <div class="pagination-upper-controls">
        <div v-if="hasSelectAll" class="pagination-select-all-zone">
          <input
            type="checkbox"
            :checked="selectAllValue"
            @change="emit('update:selectAllValue', ($event.target as HTMLInputElement).checked)"
            class="wireframe-checkbox"
          />
          <span class="pagination-select-all-label">
            {{ selectedCount === 0 ? TEXTS.pagination.selectAll : selectedCount + ' ' + TEXTS.pagination.selectedCount }}
          </span>
        </div>

        <div class="page-size-selector-box">
          <select v-model="internalPageSize" class="wireframe-input size-select">
            <option :value="20">20 {{ TEXTS.pagination.perPage }}</option>
            <option :value="50">50 {{ TEXTS.pagination.perPage }}</option>
            <option :value="100">100 {{ TEXTS.pagination.perPage }}</option>
          </select>
        </div>
      </div>

      <div class="page-navigation-buttons">
        <button
          class="wireframe-btn nav-arrow-btn"
          :disabled="internalPage === 1"
          @click="internalPage--"
        >
          [ {{ TEXTS.pagination.previous }} ]
        </button>
        
        <span class="pagination-counter-label">
          {{ TEXTS.pagination.page }} {{ internalPage }} / {{ totalPages }}
        </span>

        <button
          class="wireframe-btn nav-arrow-btn"
          :disabled="internalPage === totalPages"
          @click="internalPage++"
        >
          [ {{ TEXTS.pagination.next }} ]
        </button>
      </div>
    </div>
  </div>
</template>