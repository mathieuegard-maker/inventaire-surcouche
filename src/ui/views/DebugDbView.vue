<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { databaseService } from '../../core/database/database.service';
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
  if (confirm('Vider intégralement le cache local ?')) {
    await databaseService.cache_books.clear();
    await loadDatabase();
  }
};
</script>

<template>
  <div style="padding: 20px; font-family: monospace;">
    <h2>🛠 Laboratoire Local (Dexie DB)</h2>
    
    <div style="margin-bottom: 20px; display: flex; gap: 10px;">
      <input 
        v-model="searchQuery" 
        placeholder="Rechercher par titre, URI, wd:..." 
        style="padding: 8px; width: 300px; border: 1px solid #ccc;"
      />
      <button @click="loadDatabase" style="padding: 8px;">Rafraîchir</button>
      <button @click="clearDatabase" style="padding: 8px; background: #e74c3c; color: white;">Vider le cache</button>
    </div>

    <div v-if="isLoading">Chargement de la base de données...</div>

    <table v-else style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12px;">
      <thead>
        <tr style="background: #eee;">
          <th style="padding: 8px; border: 1px solid #ccc;">Couverture</th>
          <th style="padding: 8px; border: 1px solid #ccc;">Titre</th>
          <th style="padding: 8px; border: 1px solid #ccc;">Série & N°</th>
          <th style="padding: 8px; border: 1px solid #ccc;">Édition (inv:)</th>
          <th style="padding: 8px; border: 1px solid #ccc;">Œuvre (wd:)</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="book in filteredBooks" :key="book.uri">
          <td style="padding: 8px; border: 1px solid #ccc;">
            <img v-if="book.coverUrl" :src="book.coverUrl" style="width: 40px; height: auto;" />
            <span v-else>❌</span>
          </td>
          <td style="padding: 8px; border: 1px solid #ccc; font-weight: bold;">{{ book.title }}</td>
          <td style="padding: 8px; border: 1px solid #ccc;">{{ book.series || '-' }} (Tome {{ book.seriesNumber || '?' }})</td>
          <td style="padding: 8px; border: 1px solid #ccc;">{{ book.uri }}</td>
          <td style="padding: 8px; border: 1px solid #ccc;">{{ book.workUri || '-' }}</td>
        </tr>
      </tbody>
    </table>
    <p style="margin-top: 10px; color: #666;">Total en cache : {{ filteredBooks.length }} / {{ allBooks.length }}</p>
  </div>
</template>