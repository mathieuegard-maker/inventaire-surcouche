<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { barcodeIsbnProvider } from '../../plugins/barcode/barcode-isbn.provider';
import { manualIsbnProvider } from '../../plugins/manual/manual-isbn.provider';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import BaseButton from '../components/BaseButton.vue';
import { TEXTS } from '../locales/fr';

const router = useRouter();

const isScanningActive = ref(false);
const isSearching = ref(false);
const errorMessage = ref<string | null>(null);

const scannerId = 'barcode-scanner-viewport';
const manualContainerId = 'manual-input-container';

onMounted(() => {
  manualIsbnProvider.setup(manualContainerId, async (isbn) => {
    errorMessage.value = null;
    try {
      const response = await searchService.searchByIsbn(isbn);
      if (response && response.mainBook?.uri) {
        // Redirection immédiate vers la vue de détail autonome
        router.push(`/book/${encodeURIComponent(response.mainBook.uri)}`);
      } else {
        errorMessage.value = TEXTS.scanner.notFound;
      }
    } catch (err: any) {
      errorMessage.value = TEXTS.scanner.errorGeneral;
    }
  });
});

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
        // Redirection immédiate vers la vue de détail autonome
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

    <div v-if="errorMessage" class="error-banner">
      {{ errorMessage }}
    </div>
  </div>
</template>