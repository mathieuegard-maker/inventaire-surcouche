<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { entityResolver } from '../../core/resolvers/entity.resolver';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import BaseButton from '../components/BaseButton.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const route = useRoute();
const router = useRouter();

const book = ref<HumanizedBook | null>(null);
const isLoading = ref(true);
const errorMsg = ref('');
const successMessage = ref('');

const isOwned = computed(() => book.value?.ownershipStatus === 'owned');
const hasSeries = computed(() => !!book.value?.seriesId || !!book.value?.series);
const seriesIdentifier = computed(() => book.value?.seriesId || book.value?.series || '');

onMounted(async () => {
  const uriParam = route.params.uri as string;
  if (!uriParam) {
    errorMsg.value = "Identifiant du livre manquant.";
    isLoading.value = false;
    return;
  }

  try {
    const cached = await databaseService.getBookFromCache(uriParam);
    if (cached) {
      book.value = cached;
      isLoading.value = false;
      return;
    }

    console.log(`[DETAIL VIEW] Non trouvé en cache, résolution réseau pour : ${uriParam}`);
    const resolved = await entityResolver.resolvePhysicalEntity(uriParam);
    if (resolved) {
      book.value = resolved;
    } else {
      errorMsg.value = "Impossible de récupérer les détails de cette édition.";
    }
  } catch (e) {
    console.error("[DETAIL VIEW] Erreur de chargement :", e);
    errorMsg.value = "Une erreur est survenue lors de la récupération des données.";
  } finally {
    isLoading.value = false;
  }
});

const goBack = () => {
  router.back();
};

const navigateToSeries = () => {
  if (seriesIdentifier.value) {
    router.push({ name: 'SeriesView', params: { id: seriesIdentifier.value } });
  }
};

const handleAddInventory = async () => {
  if (!book.value?.uri) return;
  errorMsg.value = '';
  successMessage.value = '';
  try {
    book.value.ownershipStatus = 'owned';
    successMessage.value = TEXTS.scanner?.addInventorySuccess || "Ajouté à l'inventaire";
    await queueService.enqueueAction('ADD_INVENTORY', book.value.uri);
  } catch (error) {
    errorMsg.value = TEXTS.scanner?.errorQueue || "Erreur lors de l'ajout";
  }
};

const handleAddWishlist = async () => {
  if (!book.value?.uri) return;
  errorMsg.value = '';
  successMessage.value = '';
  try {
    book.value.ownershipStatus = 'wish';
    successMessage.value = TEXTS.scanner?.addWishlistSuccess || "Ajouté à la wishlist";
    await queueService.enqueueAction('ADD_WISHLIST', book.value.uri);
  } catch (error) {
    errorMsg.value = TEXTS.scanner?.errorQueue || "Erreur lors de l'ajout";
  }
};

const handleLend = () => {
  console.log("Ouverture du tunnel de prêt pour :", book.value?.uri);
};
</script>

<template>
  <div class="view-container detail-container">
    <div class="nav-header">
      <BaseButton @click="goBack">← Retour</BaseButton>
      <BaseButton v-if="hasSeries" @click="navigateToSeries">📚 Voir la saga</BaseButton>
    </div>

    <div v-if="isLoading" class="result-card">
      <p>Chargement des spécifications de l'édition...</p>
    </div>

    <div v-else-if="errorMsg" class="result-card error">
      <p>{{ errorMsg }}</p>
      <BaseButton @click="goBack">Retourner à l'accueil</BaseButton>
    </div>

    <div v-else-if="book" class="result-card success">
      <div v-if="successMessage" class="success-banner">
        <p>✅ {{ successMessage }}</p>
      </div>

      <div class="book-card-layout">
        <div v-if="!book.coverUrl" class="book-cover-placeholder">
          Pas de<br>couverture
        </div>
        <img 
          v-else 
          :src="book.coverUrl" 
          :alt="book.title" 
          class="book-cover-image" 
        />

        <div class="book-info-layout">
          <div>
            <h3 class="book-title">{{ book.title }}</h3>
            <h4 v-if="book.subtitle" class="book-subtitle">{{ book.subtitle }}</h4>
          </div>

          <div v-if="hasSeries" class="book-meta-group">
            <p class="book-meta-item">
              <strong>Série :</strong> 
              {{ book.series }}
              <span v-if="book.seriesNumber"> (Tome {{ book.seriesNumber }})</span>
            </p>
          </div>

          <div class="book-meta-group" v-if="book.authors?.length || book.scriptwriters?.length || book.illustrators?.length">
            <p class="book-meta-item" v-if="book.authors?.length">
              <strong>Auteur(s) :</strong> {{ book.authors.join(', ') }}
            </p>
            <p class="book-meta-item" v-if="book.scriptwriters?.length">
              <strong>Scénariste(s) :</strong> {{ book.scriptwriters.join(', ') }}
            </p>
            <p class="book-meta-item" v-if="book.illustrators?.length">
              <strong>Illustrateur(s) :</strong> {{ book.illustrators.join(', ') }}
            </p>
          </div>

          <div class="book-meta-group">
            <p class="book-meta-item" v-if="book.publisher">
              <strong>Éditeur :</strong> {{ book.publisher }} 
              <span v-if="book.collection">[{{ book.collection }}]</span>
            </p>
            <p class="book-meta-item" v-if="book.genres?.length">
              <strong>Genres :</strong> {{ book.genres.join(', ') }}
            </p>
            <p class="book-meta-item" v-if="book.publishDate">
              <strong>Parution :</strong> {{ book.publishDate }}
            </p>
            <p class="book-meta-item" v-if="book.pageCount">
              <strong>Pages :</strong> {{ book.pageCount }}
            </p>
            <p class="book-meta-item" v-if="book.isbn13 || book.isbn10">
              <strong>ISBN :</strong> {{ book.isbn13 || book.isbn10 }}
            </p>
          </div>

          <div class="badge-container">
            <span class="badge" :class="isOwned ? 'owned' : 'missing'">
              {{ isOwned ? 'Dans votre bibliothèque' : (book.ownershipStatus === 'wish' ? 'Dans votre liste d\'envies' : 'Non possédé') }}
            </span>
          </div>
        </div>
      </div>

      <div class="book-description" v-if="book.description">
        <h3 class="result-title">Synopsis</h3>
        <p>{{ book.description }}</p>
      </div>

      <div class="book-actions-layout">
        <template v-if="!isOwned">
          <BaseButton @click="handleAddInventory">
            Ajouter à l'inventaire
          </BaseButton>
          <BaseButton @click="handleAddWishlist">
            Ajouter à la wishlist
          </BaseButton>
        </template>
        <template v-else>
          <BaseButton @click="handleLend">
            Prêter
          </BaseButton>
        </template>
      </div>
    </div>
  </div>
</template>