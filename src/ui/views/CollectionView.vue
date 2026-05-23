<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseButton from '../components/BaseButton.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const router = useRouter();

// États de données de la collection
const allOwnedBooks = ref<HumanizedBook[]>([]);
const isLoading = ref(true);

// États des contrôles utilisateur
const currentMode = ref<'books' | 'series' | 'oneshots'>('books');
const selectedGenre = ref('all');
const currentSort = ref('title');

onMounted(async () => {
  try {
    const cached = await databaseService.getAllBooksFromCache();
    // On ne retient que les livres marqués possédés
    allOwnedBooks.value = cached.filter(b => b.ownershipStatus === 'owned');
  } catch (e) {
    console.error("[COLLECTION VIEW] Erreur au chargement du catalogue :", e);
  } finally {
    isLoading.value = false;
  }
});

const goBack = () => {
  router.push({ name: 'dashboard' });
};

const navigateToSeries = (seriesId: string) => {
  if (seriesId) {
    router.push({ name: 'SeriesView', params: { id: seriesId } });
  }
};

// 1. EXTRACTION DYNAMIQUE DES GENRES PRÉSENTS (Zéro texte en dur)
const dynamicGenres = computed(() => {
  const genresSet = new Set<string>();
  allOwnedBooks.value.forEach(book => {
    if (book.genres && Array.isArray(book.genres)) {
      book.genres.forEach(g => genresSet.add(g));
    }
  });
  return Array.from(genresSet).sort();
});

// 2. SEGMENTATION PAR MODE ET FILTRAGE PAR GENRE
const processedBooks = computed(() => {
  let list = [...allOwnedBooks.value];

  // Application du filtre de genre dynamique
  if (selectedGenre.value !== 'all') {
    list = list.filter(b => b.genres && b.genres.includes(selectedGenre.value));
  }

  // Application du filtre de mode structurel
  if (currentMode.value === 'oneshots') {
    // Uniquement les livres n'appartenant à aucune série
    return list.filter(b => !b.seriesId && !b.series);
  } else if (currentMode.value === 'books') {
    // Tous les livres à plat
    return list;
  }
  
  return list;
});

// 3. LOGIQUE DE GROUPEMENT PAR SÉRIE (Tête de gondole)
const seriesGondolas = computed(() => {
  // On filtre pour ne garder que les livres qui possèdent une série
  let list = allOwnedBooks.value.filter(b => b.seriesId || b.series);

  if (selectedGenre.value !== 'all') {
    list = list.filter(b => b.genres && b.genres.includes(selectedGenre.value));
  }

  const groups: Record<string, { id: string; name: string; tomes: HumanizedBook[] }> = {};

  list.forEach(book => {
    const key = book.seriesId || book.series || 'unknown';
    if (!groups[key]) {
      groups[key] = {
        id: book.seriesId || book.series || '',
        name: book.series || book.seriesId || '',
        tomes: []
      };
    }
    groups[key].tomes.push(book);
  });

  const gondolas = Object.values(groups).map(g => {
    // Tri interne des tomes pour trouver la couverture du tome le plus ancien possédé
    g.tomes.sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
    return {
      id: g.id,
      name: g.name,
      ownedCount: g.tomes.length,
      coverUrl: g.tomes[0]?.coverUrl,
      firstTitle: g.tomes[0]?.title || ''
    };
  });

  // Tri alphabétique par défaut des têtes de gondole
  return gondolas.sort((a, b) => a.name.localeCompare(b.name));
});

// 4. LOGIQUE DE TRI ALPHABÉTIQUE / AUTEUR / CHRONOLOGIQUE
const sortedBooks = computed(() => {
  const list = [...processedBooks.value];

  if (currentSort.value === 'title') {
    return list.sort((a, b) => a.title.localeCompare(b.title));
  } else if (currentSort.value === 'author') {
    return list.sort((a, b) => {
      const authA = a.authors && a.authors[0] ? a.authors[0] : '';
      const authB = b.authors && b.authors[0] ? b.authors[0] : '';
      return authA.localeCompare(authB);
    });
  } else if (currentSort.value === 'date') {
    // Tri antichronologique (Derniers mis à jour / ajoutés en haut)
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  return list;
});
</script>

<template>
  <div class="view-container">
    
    <div class="nav-header">
      <BaseButton @click="goBack">
        {{ TEXTS.seriesView.back }}
      </BaseButton>
      <h2>{{ TEXTS.collectionView.title }}</h2>
    </div>

    <div class="collection-modes-tabs">
      <button 
        :class="['tab-button', { active: currentMode === 'books' }]" 
        @click="currentMode = 'books'"
      >
        {{ TEXTS.collectionView.modeBooks }}
      </button>
      <button 
        :class="['tab-button', { active: currentMode === 'series' }]" 
        @click="currentMode = 'series'"
      >
        {{ TEXTS.collectionView.modeSeries }}
      </button>
      <button 
        :class="['tab-button', { active: currentMode === 'oneshots' }]" 
        @click="currentMode = 'oneshots'"
      >
        {{ TEXTS.collectionView.modeOneShots }}
      </button>
    </div>

    <div class="collection-controls-bar">
      <div class="control-group">
        <label>{{ TEXTS.collectionView.filterGenreLabel }}</label>
        <select v-model="selectedGenre" class="control-select">
          <option value="all">{{ TEXTS.collectionView.filterGenreAll }}</option>
          <option v-for="genre in dynamicGenres" :key="genre" :value="genre">
            {{ genre }}
          </option>
        </select>
      </div>

      <div class="control-group" v-if="currentMode !== 'series'">
        <label>{{ TEXTS.collectionView.sortLabel }}</label>
        <select v-model="currentSort" class="control-select">
          <option value="title">{{ TEXTS.collectionView.sortByTitle }}</option>
          <option value="author">{{ TEXTS.collectionView.sortByAuthor }}</option>
          <option value="date">{{ TEXTS.collectionView.sortByDate }}</option>
        </select>
      </div>
    </div>

    <div v-if="isLoading" class="result-card">
      <p>{{ TEXTS.seriesView.loading }}</p>
    </div>

    <div v-else class="series-list-container">
      
      <template v-if="currentMode === 'series'">
        <div v-if="seriesGondolas.length === 0" class="result-card error">
          <p>{{ TEXTS.collectionView.emptyCollection }}</p>
        </div>
        
        <div 
          v-for="saga in seriesGondolas" 
          :key="saga.id" 
          class="mini-card-row" 
          @click="navigateToSeries(saga.id)"
        >
          <div class="row-cover-container">
            <img v-if="saga.coverUrl" :src="saga.coverUrl" class="row-cover-image" />
            <div v-else class="row-cover-fallback">
              <span class="fallback-title">{{ saga.name }}</span>
            </div>
          </div>
          <div class="row-info-content">
            <p class="row-title">{{ saga.name }}</p>
            <p class="row-series-meta">{{ saga.ownedCount }} {{ TEXTS.collectionView.tomesOwned }}</p>
          </div>
        </div>
      </template>

      <template v-else>
        <div v-if="sortedBooks.length === 0" class="result-card error">
          <p>{{ TEXTS.collectionView.emptyCollection }}</p>
        </div>
        
        <BookMiniCard 
          v-for="livre in sortedBooks" 
          :key="livre.uri" 
          :book="livre"
        />
      </template>

    </div>
  </div>
</template>