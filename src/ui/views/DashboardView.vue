<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { barcodeIsbnProvider } from '../../plugins/barcode/barcode-isbn.provider';
import { manualIsbnProvider } from '../../plugins/manual/manual-isbn.provider';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import BaseButton from '../components/BaseButton.vue';
import BookResultCard from '../components/BookResultCard.vue';
import { TEXTS } from '../locales/fr';
import type { SearchResponse } from '../../core/types';

const isScanningActive = ref(false);
const isSearching = ref(false);
const searchResult = ref<SearchResponse | null>(null);
const errorMessage = ref<string | null>(null);

const scannerId = 'barcode-scanner-viewport';
const manualContainerId = 'manual-input-container';

onMounted(() => {
  // Initialisation du plugin d'acquisition manuelle dans son conteneur dédié
  manualIsbnProvider.setup(manualContainerId, async (isbn) => {
    searchResult.value = null;
    errorMessage.value = null;
    try {
      const response = await searchService.searchByIsbn(isbn);
      if (response) {
        searchResult.value = response;
      } else {
        errorMessage.value = "Ouvrage introuvable sur les serveurs d'Inventaire.io.";
      }
    } catch (err: any) {
      errorMessage.value = err.message || "Erreur lors du traitement de l'ouvrage.";
    }
  });
});

const startScanningSequence = async () => {
  searchResult.value = null;
  errorMessage.value = null;
  isScanningActive.value = true;

  await nextTick();

  await barcodeIsbnProvider.startScanner(
    scannerId,
    (response) => {
      isScanningActive.value = false;
      isSearching.value = false;
      if (response) {
        searchResult.value = response;
      } else {
        errorMessage.value = "Ouvrage introuvable sur les serveurs d'Inventaire.io.";
      }
    },
    (errorMsg) => {
      isScanningActive.value = false;
      isSearching.value = false;
      errorMessage.value = errorMsg;
    },
    () => {
      isSearching.value = true;
    }
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

    <div v-if="errorMessage" class="result-card error">
      <p class="result-value">{{ errorMessage }}</p>
    </div>

    <BookResultCard v-if="searchResult" :searchResult="searchResult" />
  </div>
</template>