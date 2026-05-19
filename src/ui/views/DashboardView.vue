<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { barcodeIsbnProvider } from '../../plugins/barcode/barcode-isbn.provider';
import { manualIsbnProvider } from '../../plugins/manual/manual-isbn.provider';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import BaseButton from '../components/BaseButton.vue';
import BookResultCard from '../components/BookResultCard.vue';
import { TEXTS } from '../locales/fr';
import type { SearchResponse } from '../../core/types';

const isScanningActive = ref(false);
const isSearching = ref(false);

const searchResult = ref<SearchResponse | null>(null);
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

const scannerId = 'barcode-scanner-viewport';
const manualContainerId = 'manual-input-container';

onMounted(() => {
  manualIsbnProvider.setup(manualContainerId, async (isbn) => {
    resetStates();
    try {
      const response = await searchService.searchByIsbn(isbn);
      if (response) {
        searchResult.value = response;
      } else {
        errorMessage.value = TEXTS.scanner.notFound;
      }
    } catch (err: any) {
      errorMessage.value = TEXTS.scanner.errorGeneral;
    }
  });
});

const resetStates = () => {
  searchResult.value = null;
  errorMessage.value = null;
  successMessage.value = null;
};

const startScanningSequence = async () => {
  resetStates();
  isScanningActive.value = true;
  await nextTick();

  await barcodeIsbnProvider.startScanner(
    scannerId,
    (response) => {
      isScanningActive.value = false;
      isSearching.value = false;
      if (response) searchResult.value = response;
      else errorMessage.value = TEXTS.scanner.notFound;
    },
    (errorMsg) => {
      isScanningActive.value = false;
      isSearching.value = false;
      errorMessage.value = errorMsg;
    },
    () => { isSearching.value = true; }
  );
};

const stopScanningSequence = async () => {
  await barcodeIsbnProvider.stopScanner();
  isScanningActive.value = false;
  isSearching.value = false;
};

onUnmounted(async () => {
  await barcodeIsbnProvider.stopScanner();
});

const handleAddInventory = async (identifier: string) => {
  errorMessage.value = null;
  successMessage.value = null;
  try {
    if (searchResult.value) {
      searchResult.value.ownership.isWorkOwned = true;
      searchResult.value.ownership.isEditionOwned = true;
    }
    successMessage.value = TEXTS.scanner.addInventorySuccess;
    await queueService.enqueueAction('ADD_INVENTORY', identifier);
  } catch (error) {
    errorMessage.value = TEXTS.scanner.errorQueue;
  }
};

const handleAddWishlist = async (identifier: string) => {
  errorMessage.value = null;
  successMessage.value = null;
  try {
    if (searchResult.value) {
      searchResult.value.ownership.isWished = true;
    }
    successMessage.value = TEXTS.scanner.addWishlistSuccess;
    await queueService.enqueueAction('ADD_WISHLIST', identifier);
  } catch (error) {
    errorMessage.value = TEXTS.scanner.errorQueue;
  }
};

const handleLend = (identifier: string) => {
  console.log("Ouverture du tunnel de prêt pour :", identifier);
};

const handleViewSeries = (seriesId: string) => {
  console.log("Recherche de la série :", seriesId);
};
</script>

<template>
  <div class="view-container">
    <h2>📚 {{ TEXTS.app.name }} - Dashboard</h2>
    
    <div class="action-section">
      <BaseButton 
        @click="isScanningActive ? stopScanningSequence() : startScanningSequence()" 
        :variantClass="isScanningActive ? 'btn-danger' : 'btn-primary'"
      >
        {{ isScanningActive ? TEXTS.scanner.btnClose : TEXTS.scanner.btnOpen }}
      </BaseButton>
    </div>

    <div v-show="isScanningActive" class="scanner-box">
      <h3>{{ TEXTS.scanner.title }}</h3>
      <div class="scanner-viewport-wrapper">
        <div :id="scannerId" class="scanner-viewport"></div>
        <div v-if="!isSearching" class="scanner-placeholder">
          <p>{{ TEXTS.scanner.searching }}</p>
        </div>
      </div>
    </div>

    <div :id="manualContainerId"></div>

    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
    </div>
    
    <div v-if="successMessage" class="result-card success">
      <p>✅ {{ successMessage }}</p>
    </div>

    <BookResultCard 
      v-if="searchResult" 
      :searchResult="searchResult" 
      @action-add-inventory="handleAddInventory"
      @action-add-wishlist="handleAddWishlist"
      @action-lend="handleLend"
      @action-view-series="handleViewSeries"
    />
  </div>
</template>