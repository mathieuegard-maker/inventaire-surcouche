<script setup lang="ts">
import { ref, nextTick, onUnmounted } from 'vue';
import { barcodeIsbnProvider } from '../../plugins/barcode/barcode-isbn.provider';
import { TEXTS } from '../locales/fr';
import type { SearchResponse } from '../../core/types';

const isScanningActive = ref(false);
const isSearching = ref(false);
const searchResult = ref<SearchResponse | null>(null);
const errorMessage = ref<string | null>(null);
const scannerId = 'barcode-scanner-viewport';

const startScanningSequence = async () => {
  searchResult.value = null;
  errorMessage.value = null;
  isScanningActive.value = true;

  // Attente impérative du cycle de rendu Vue pour garantir la présence de l'ID cible dans le DOM
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
  // Sécurité matériel : coupure obligatoire si l'utilisateur change d'onglet ou de route
  await barcodeIsbnProvider.stopScanner();
});
</script>

<template>
  <div class="view-container">
    <h2>📚 {{ TEXTS.app.name }} - Dashboard</h2>
    
    <div class="action-section">
      <button 
        @click="isScanningActive ? stopScanningSequence() : startScanningSequence()" 
        :class="['btn-action', isScanningActive ? 'btn-danger' : 'btn-primary']"
      >
        {{ isScanningActive ? TEXTS.scanner.btnClose : TEXTS.scanner.btnOpen }}
      </button>
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

    <div v-if="errorMessage" class="result-card error">
      <p class="result-value">{{ errorMessage }}</p>
    </div>

    <div v-if="searchResult" class="result-card success">
      <p class="result-title">{{ TEXTS.scanner.successDetected }}</p>
      <div class="book-details">
        <div class="book-info">
          <p class="book-title"><strong>{{ searchResult.mainBook.title }}</strong></p>
          <p class="book-authors" v-if="searchResult.mainBook.authors?.length">
            {{ searchResult.mainBook.authors.join(', ') }}
          </p>
          <p class="book-isbn" v-if="searchResult.mainBook.isbn13">
            ISBN : {{ searchResult.mainBook.isbn13 }}
          </p>
          <p class="ownership-status">
            Statut de possession : 
            <span class="badge" :class="searchResult.ownership.isWorkOwned ? 'owned' : 'missing'">
              {{ searchResult.ownership.isWorkOwned ? 'Possédé' : 'Absent' }}
            </span>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>