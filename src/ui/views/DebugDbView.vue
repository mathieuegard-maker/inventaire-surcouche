<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { databaseService, db } from '../../core/database/database.service';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const allBooks = ref<HumanizedBook[]>([]);
const searchQuery = ref('');
const isLoading = ref(true);

onMounted(async () => {
  await loadDatabase();
});

const loadDatabase = async () => {
  isLoading.value = true;
  try {
    allBooks.value = await databaseService.getAllBooksFromCache();
  } catch (e) {
    console.error("Erreur de chargement de la DB :", e);
  } finally {
    isLoading.value = false;
  }
};

const filteredBooks = computed(() => {
  if (!searchQuery.value) return allBooks.value;
  const q = searchQuery.value.toLowerCase();
  return allBooks.value.filter(book => 
    (book.title && book.title.toLowerCase().includes(q)) ||
    (book.uri && book.uri.toLowerCase().includes(q)) ||
    (book.workUri && book.workUri.toLowerCase().includes(q)) ||
    (book.series && book.series.toLowerCase().includes(q))
  );
});

const clearDatabase = async () => {
  if (confirm(TEXTS.debugDbView.clearConfirm)) {
    await db.cache_books.clear();
    await loadDatabase();
  }
};
</script>

<template>
  <div class="debug-view-container">
    <h2>{{ TEXTS.debugDbView.title }}</h2>
    
    <div class="debug-action-bar">
      <input 
        v-model="searchQuery" 
        :placeholder="TEXTS.debugDbView.placeholder" 
        class="debug-search-input"
      />
      <button @click="loadDatabase" class="btn-action">{{ TEXTS.debugDbView.btnRefresh }}</button>
      <button @click="clearDatabase" class="btn-danger">{{ TEXTS.debugDbView.btnClear }}</button>
    </div>

    <div v-if="isLoading" class="result-card">{{ TEXTS.debugDbView.loading }}</div>

    <table v-else class="debug-table">
      <thead>
        <tr>
          <th>{{ TEXTS.debugDbView.thCover }}</th>
          <th>{{ TEXTS.debugDbView.thTitle }}</th>
          <th>{{ TEXTS.debugDbView.thSeries }}</th>
          <th>{{ TEXTS.debugDbView.thEdition }}</th>
          <th>{{ TEXTS.debugDbView.thWork }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="book in filteredBooks" :key="book.uri">
          <td>
            <img v-if="book.localCover || book.coverUrl" :src="book.localCover || book.coverUrl" class="debug-cover-img" />
            <span v-else>❌</span>
          </td>
          <td>{{ book.title }}</td>
          <td>{{ book.series || '-' }} <span v-if="book.seriesNumber">(Tome {{ book.seriesNumber }})</span></td>
          <td>{{ book.uri }}</td>
          <td>{{ book.workUri || '-' }}</td>
        </tr>
      </tbody>
    </table>
    <p class="debug-footer-text">{{ TEXTS.debugDbView.totalInCache }} {{ filteredBooks.length }} / {{ allBooks.length }}</p>
  </div>
</template>