<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { entityResolver } from '../../core/resolvers/entity.resolver';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { isbnUtil } from '../../core/utils/isbn.util';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BaseButton from '../components/BaseButton.vue';
import LendModal from '../components/LendModal.vue';
import BookActionButtons from '../components/BookActionButtons.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';

const route = useRoute();
const router = useRouter();

const book = ref<HumanizedBook | null>(null);
const isLoading = ref(true);
const errorMsg = ref('');
const successMessage = ref('');
const showLendModal = ref(false);

const isOwned = computed(() => book.value?.ownershipStatus === 'owned');
const isLent = computed(() => !!book.value?.loan);
const hasSeries = computed(() => !!book.value?.seriesId || !!book.value?.series);
const seriesIdentifier = computed(() => book.value?.seriesId || book.value?.series || '');

onMounted(async () => {
  const uriParam = route.params.uri as string;
  if (!uriParam) {
    errorMsg.value = TEXTS.bookDetail?.missingId || "Identifiant du livre manquant.";
    isLoading.value = false;
    return;
  }

  try {
    const normalized = isbnUtil.normalize(uriParam);
    if (isbnUtil.isValidFormat(normalized)) {
      console.log(`[DETAIL VIEW] Détection ISBN : Aiguillage vers le flux de recherche standard pour : ${normalized}`);
      const response = await searchService.searchByIsbn(normalized);
      if (response && response.mainBook) {
        const mainBook = response.mainBook;
        if (response.loan?.details) {
          mainBook.loan = response.loan.details;
        }
        book.value = mainBook;
      } else {
        errorMsg.value = "Impossible de récupérer les détails de cette édition.";
      }
      isLoading.value = false;
      return;
    }

    // Flux normal pour les URIs (inv:...) ou autres identifiants
    const cached = await databaseService.getBookFromCache(uriParam);
    if (cached) {
      const activeLoan = await databaseService.getLoan(cached.uri);
      if (activeLoan) {
        cached.loan = activeLoan;
      }
      book.value = cached;
      isLoading.value = false;
      return;
    }

    console.log(`[DETAIL VIEW] Non trouvé en cache, résolution réseau pour : ${uriParam}`);
    // FIX COMPILATION : Appel de la méthode exacte supportée par le résolveur
    const resolved = await entityResolver.resolvePhysicalEntity(uriParam);
    if (resolved) {
      const activeLoan = await databaseService.getLoan(resolved.uri);
      if (activeLoan) {
        resolved.loan = activeLoan;
      }
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
  showLendModal.value = true;
};

const confirmLend = async (friendName: string) => {
  if (!book.value?.uri) return;
  try {
    await queueService.enqueueAction('LEND', book.value.uri, { friendName });
    book.value.loan = {
      uri: book.value.uri,
      friendName,
      loanDate: Date.now()
    };
  } catch (e) {
    console.error(e);
  } finally {
    showLendModal.value = false;
  }
};

const handleReturn = async () => {
  if (!book.value?.uri) return;
  try {
    await queueService.enqueueAction('RETURN', book.value.uri);
    if (book.value.loan) {
      delete book.value.loan;
    }
  } catch (e) {
    console.error(e);
  }
};
</script>

<template>
  <div class="view-container detail-container">
    <BaseHeader title="Détails de l'édition" showBack>
      <template #actions>
        <BaseButton v-if="hasSeries" @click="navigateToSeries">📚 Voir la saga</BaseButton>
      </template>
    </BaseHeader>

    <BaseLoading v-if="isLoading" />

    <BaseBanner v-else-if="errorMsg" type="error" :message="errorMsg" />

    <div v-else-if="book" class="result-card success">
      <BaseBanner v-if="successMessage" type="success" :message="successMessage" />

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
            <span class="badge" :class="isLent ? 'lent' : (isOwned ? 'owned' : 'missing')">
              {{ 
                isLent ? `${TEXTS.bookStatus?.lent || 'Prêté'} : ${book.loan?.friendName}` : 
                (book.ownershipStatus === 'owned' ? TEXTS.bookStatus?.owned : 
                (book.ownershipStatus === 'wish' ? TEXTS.bookStatus?.wish : TEXTS.bookStatus?.none)) 
              }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="hasSeries" style="margin-top: var(--spacing-md); margin-bottom: var(--spacing-md); width: 100%;">
        <button class="wireframe-btn" @click="navigateToSeries">
          [ VOIR TOUTE LA SÉRIE : {{ book.series || 'SAGA' }} ]
        </button>
      </div>

      <div class="book-description" v-if="book.description">
        <h3 class="result-title">Synopsis</h3>
        <p>{{ book.description }}</p>
      </div>

      <div class="book-actions-layout">
        <BookActionButtons 
          :ownership-status="book.ownershipStatus"
          :is-lent="isLent"
          @add-inventory="handleAddInventory"
          @add-wishlist="handleAddWishlist"
          @lend="handleLend"
          @return="handleReturn"
        />
      </div>
    </div>

    <LendModal
      :show="showLendModal"
      :bookCount="1"
      @close="showLendModal = false"
      @confirm="confirmLend"
    />
  </div>
</template>