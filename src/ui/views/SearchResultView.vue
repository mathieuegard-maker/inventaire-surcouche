<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import { TEXTS } from '../locales/fr';
import { inventaireSearchProvider, type SearchResultItem } from '../../core/providers/inventaire-search.provider';
import { semanticBucketMapper } from '../../core/resolvers/mapper';
import { workUriResolver } from '../../core/resolvers/workUri.resolver';
import { databaseService } from '../../core/database/database.service';
import { connectionState } from '../../state/connection';

const route = useRoute();
const router = useRouter();

const isLoading = ref(true);
const errorMessage = ref('');

// États réactifs volatiles stockés exclusivement en RAM (Zéro écriture Dexie)
const authorResults = ref<SearchResultItem[]>([]);
const seriesResults = ref<SearchResultItem[]>([]);
const workResults = ref<SearchResultItem[]>([]);

const executeSemanticSearch = async () => {
  const query = route.query.q as string;
  if (!query) {
    errorMessage.value = TEXTS.searchResults.errorEmptyQuery;
    isLoading.value = false;
    return;
  }

  isLoading.value = true;
  errorMessage.value = '';

  const isOffline = connectionState.isOffline.value;

  if (isOffline) {
    try {
      console.log(`[SEARCH RESULT VIEW] Mode hors-ligne actif. Recherche locale pour : ${query}`);
      const localBooks = await databaseService.searchBooksLocally(query);
      workResults.value = localBooks.map(book => ({
        uri: book.uri,
        type: 'work',
        label: book.title,
        description: book.authors?.join(', ') || book.series || undefined,
        coverUrl: book.localCover || book.coverUrl
      }));
      authorResults.value = [];
      seriesResults.value = [];
    } catch (e) {
      console.error('[SEARCH RESULT VIEW] Échec de la recherche locale :', e);
      errorMessage.value = "Erreur de recherche locale hors-ligne.";
    } finally {
      isLoading.value = false;
    }
    return;
  }

  try {
    const rawItems = await inventaireSearchProvider.searchByKeywords(query);
    
    // Partitionnement des résultats via le mapper mutualisé
    const buckets = semanticBucketMapper.partition(rawItems);
    
    authorResults.value = buckets.authors;
    seriesResults.value = buckets.series;
    workResults.value = buckets.works;
  } catch (error) {
    console.error('[SEARCH RESULT VIEW] Échec de la recherche sémantique :', error);
    errorMessage.value = TEXTS.searchResults.errorFetch;
  } finally {
    isLoading.value = false;
  }
};

onMounted(async () => {
  await executeSemanticSearch();
});

// Ré-exécution automatique si l'utilisateur saisit une nouvelle recherche textuelle depuis la barre
watch(() => route.query.q, async () => {
  await executeSemanticSearch();
});

const handleSelectAuthor = (uri: string) => {
  router.push({ name: 'AuthorView', params: { id: uri } });
};

const handleSelectSeries = (uri: string) => {
  router.push({ name: 'SeriesView', params: { id: uri } });
};

const handleSelectWork = async (uri: string) => {
  const isOffline = connectionState.isOffline.value;
  if (isOffline) {
    console.log(`[SEARCH RESULT VIEW] Redirection directe hors-ligne pour l'URI : ${uri}`);
    router.push(`/book/${encodeURIComponent(uri)}`);
    return;
  }

  isLoading.value = true;
  try {
    // Le Pivot ISBN : Résolution de l'édition physique canonique en tâche de fond
    const isbn = await workUriResolver.resolveIsbnFromWorkUri(uri);
    if (isbn) {
      router.push(`/book/${encodeURIComponent(isbn)}`);
    } else {
      alert(TEXTS.searchResults.errorNoPhysicalEdition);
      isLoading.value = false;
    }
  } catch (error) {
    console.error('[SEARCH RESULT VIEW] Échec du pivot ISBN :', error);
    alert(TEXTS.searchResults.errorPivot);
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle :text="TEXTS.searchResults.title" level="h2" />

    <BaseLoading v-if="isLoading" />

    <div v-else class="main-content-wrapper">
      <BaseBanner v-if="errorMessage" type="error" :message="errorMessage" />
      
      <BaseBanner 
        v-if="!authorResults.length && !seriesResults.length && !workResults.length && !errorMessage" 
        type="error" 
        :message="TEXTS.searchResults.emptyResults" 
      />

      <!-- SEAU SÉMANTIQUE 1 : LES SAGAS / SÉRIES -->
      <div v-if="seriesResults.length" class="semantic-bucket-section">
        <div class="wishlist-section-header">{{ TEXTS.searchResults.sectionSeries }}</div>
        <div class="wireframe-table-container">
          <div 
            v-for="item in seriesResults" 
            :key="item.uri" 
            class="mini-card-row card-row-clickable"
            @click="handleSelectSeries(item.uri)"
          >
            <div class="row-cover-container row-macaron-container">
              <span class="row-macaron-label">{{ TEXTS.searchResults.badgeSeries }}</span>
            </div>
            <div class="row-info-content">
              <p class="row-title">{{ item.label }}</p>
              <p v-if="item.description" class="row-series-meta">{{ item.description }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- SEAU SÉMANTIQUE 2 : LES AUTEURS -->
      <div v-if="authorResults.length" class="semantic-bucket-section">
        <div class="wishlist-section-header">{{ TEXTS.searchResults.sectionAuthors }}</div>
        <div class="wireframe-table-container">
          <div 
            v-for="item in authorResults" 
            :key="item.uri" 
            class="mini-card-row card-row-clickable"
            @click="handleSelectAuthor(item.uri)"
          >
            <div class="row-cover-container row-macaron-container">
              <span class="row-macaron-label">{{ TEXTS.searchResults.badgeAuthor }}</span>
            </div>
            <div class="row-info-content">
              <p class="row-title">{{ item.label }}</p>
              <p v-if="item.description" class="row-series-meta">{{ item.description }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- SEAU SÉMANTIQUE 3 : LES LIVRES / TOMES ISOLÉS -->
      <div v-if="workResults.length" class="semantic-bucket-section">
        <div class="wishlist-section-header">{{ TEXTS.searchResults.sectionWorks }}</div>
        <div class="wireframe-table-container">
          <div 
            v-for="item in workResults" 
            :key="item.uri" 
            class="mini-card-row card-row-clickable"
            @click="handleSelectWork(item.uri)"
          >
            <div class="row-cover-container row-macaron-container">
              <span class="row-macaron-label">{{ TEXTS.searchResults.badgeWork }}</span>
            </div>
            <div class="row-info-content">
              <p class="row-title">{{ item.label }}</p>
              <p v-if="item.description" class="row-series-meta">{{ item.description }}</p>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>