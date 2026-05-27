<script setup lang="ts">
import { ref, nextTick, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { barcodeIsbnProvider } from '../../plugins/barcode/barcode-isbn.provider';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import SmartSearchBar from '../components/SmartSearchBar.vue';
import { TEXTS } from '../locales/fr';

const router = useRouter();

const searchQuery = ref('');
const isScanningActive = ref(false);
const isSearching = ref(false);
const errorMessage = ref<string | null>(null);

const scannerId = 'barcode-scanner-viewport';

/**
 * Lance la résolution sémantique de l'ISBN via le service du cœur
 */
const handleSearch = async (isbn: string) => {
  if (!isbn) return;
  errorMessage.value = null;
  try {
    const cleanedIsbn = isbn.replace(/-/g, '');
    const response = await searchService.searchByIsbn(cleanedIsbn);
    if (response && response.mainBook?.uri) {
      router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
    } else {
      errorMessage.value = TEXTS.scanner.notFound;
    }
  } catch (err: any) {
    errorMessage.value = TEXTS.scanner.errorGeneral;
  }
};

/**
 * Redirige vers l'écran intermédiaire sémantique pour la recherche textuelle
 */
const handleKeywordsSearch = (query: string) => {
  router.push({ name: 'SearchResultView', query: { q: query } });
};

/**
 * Initialise le module de flux caméra matériel
 */
const startScanningSequence = async () => {
  errorMessage.value = null;
  isScanningActive.value = true;
  await nextTick();

  await barcodeIsbnProvider.startScanner(
    scannerId,
    (response) => {
      isScanningActive.value = false;
      isSearching.value = false;
      if (response && response.mainBook?.uri) {
        router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
      } else {
        errorMessage.value = TEXTS.scanner.notFound;
      }
    },
    (errorMsg) => {
      isScanningActive.value = false;
      isSearching.value = false;
      errorMessage.value = errorMsg;
    },
    () => { isSearching.value = true; }
  );
};

/**
 * Interrompt proprement la capture optique
 */
const stopScanningSequence = async () => {
  await barcodeIsbnProvider.stopScanner();
  isScanningActive.value = false;
  isSearching.value = false;
};

/**
 * Gère l'état de bascule du scanner matériel
 */
const toggleScanSequence = () => {
  if (isScanningActive.value) {
    stopScanningSequence();
  } else {
    startScanningSequence();
  }
};

onUnmounted(async () => {
  await barcodeIsbnProvider.stopScanner();
});
</script>

<template>
  <div class="view-container">
    <BaseHeader />

    <BaseTitle :text="TEXTS.home.title" level="h2" />
    
    <SmartSearchBar 
      v-model="searchQuery" 
      :isScanningActive="isScanningActive" 
      @isbn-detected="handleSearch" 
      @keywords-detected="handleKeywordsSearch" 
      @toggle-scan="toggleScanSequence" 
    />

    <div v-show="isScanningActive" class="scanner-box">
      <BaseTitle :text="TEXTS.scanner.title" level="h3" />
      <div class="scanner-viewport-wrapper">
        <div :id="scannerId" class="scanner-viewport"></div>
        <div v-if="!isSearching" class="scanner-placeholder">
          <p>{{ TEXTS.scanner.searching }}</p>
        </div>
      </div>
    </div>

    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
    </div>
  </div>
</template>