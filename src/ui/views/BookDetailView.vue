<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { entityResolver } from '../../core/resolvers/entity.resolver';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import { isbnUtil } from '../../core/utils/isbn.util';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BaseButton from '../components/BaseButton.vue';
import LendModal from '../components/LendModal.vue';
import SeriesMergeModal from '../components/SeriesMergeModal.vue';
import BookActionButtons from '../components/BookActionButtons.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';
import { entityHumanizer } from '../../core/resolvers/humanizer';
import { inventoryService } from '../../core/services/inventory.service';
import { wishlistService } from '../../core/services/wishlist.service';
import { imageUtil } from '../../core/utils/image.util';
import { compressImageToWebpDataUrl } from '../../core/utils/webp-compressor.util';
import { connectionState } from '../../state/connection';

const route = useRoute();
const router = useRouter();

const book = ref<HumanizedBook | null>(null);
const isLoading = ref(true);
const errorMsg = ref('');
const successMessage = ref('');
const showLendModal = ref(false);
const showDeleteModal = ref(false);
const showSeriesMergeModal = ref(false);

// Statut de lecture optionnel (stocké localement par URI d'œuvre/édition)
const readingStatus = ref<string>('none');
const readingRating = ref<number>(0);

function loadLocalReadingMeta(uri: string) {
  try {
    const raw = localStorage.getItem(`biblio_reading_${uri}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      readingStatus.value = parsed.status || 'none';
      readingRating.value = Number(parsed.rating) || 0;
    } else {
      readingStatus.value = 'none';
      readingRating.value = 0;
    }
  } catch {
    readingStatus.value = 'none';
    readingRating.value = 0;
  }
}

function saveLocalReadingMeta() {
  if (!book.value?.uri) return;
  localStorage.setItem(
    `biblio_reading_${book.value.uri}`,
    JSON.stringify({ status: readingStatus.value, rating: readingRating.value })
  );
  successMessage.value = 'Statut de lecture mis à jour ✓';
}

async function handleCustomCoverUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !book.value) return;
  try {
    const webpDataUrl = await compressImageToWebpDataUrl(file, {
      maxWidth: 420,
      maxHeight: 600,
      quality: 0.8,
      cropRatio: 0.7
    });
    book.value.localCover = webpDataUrl;
    book.value.coverUrl = webpDataUrl;
    book.value.isLocallyEdited = true;
    await databaseService.saveBookToCache(book.value);
    successMessage.value = 'Couverture recadrée et compressée en WebP ✓';
  } catch (e: any) {
    errorMsg.value = e.message || 'Impossible de compresser la couverture.';
  } finally {
    input.value = '';
  }
}

async function handleSeriesMerged(payload: { seriesId: string; seriesTitle: string }) {
  if (!book.value) return;
  book.value.seriesId = payload.seriesId;
  book.value.series = payload.seriesTitle;
  successMessage.value = `Rattaché à la série "${payload.seriesTitle}" ✓`;
  await loadSeriesContext();
}

const isOwned = computed(() => book.value?.ownershipStatus === 'owned');
const isLent = computed(() => !!book.value?.loan);
const hasSeries = computed(() => !!book.value?.seriesId || !!book.value?.series);
const seriesIdentifier = computed(() => book.value?.seriesId || book.value?.series || '');

// Navigation dans la série
const seriesTomes = ref<HumanizedBook[]>([]);

const currentTomeIndex = computed(() => {
  if (!book.value || seriesTomes.value.length === 0) return -1;
  return seriesTomes.value.findIndex(t => t.uri === book.value?.uri);
});

const previousBook = computed(() => {
  const idx = currentTomeIndex.value;
  if (idx > 0) return seriesTomes.value[idx - 1];
  return null;
});

const nextBook = computed(() => {
  const idx = currentTomeIndex.value;
  if (idx !== -1 && idx < seriesTomes.value.length - 1) return seriesTomes.value[idx + 1];
  return null;
});

const loadSeriesContext = async () => {
  if (book.value?.seriesId) {
    const tomes = await databaseService.getBooksBySeriesId(book.value.seriesId);
    // Tri numérique par numéro de tome
    tomes.sort((a, b) => {
      const numA = parseFloat(a.seriesNumber || '0') || 0;
      const numB = parseFloat(b.seriesNumber || '0') || 0;
      return numA - numB;
    });
    seriesTomes.value = tomes;
  } else if (book.value?.series) {
    const tomes = await databaseService.findLocalSeriesMatches(book.value.series);
    tomes.sort((a, b) => {
      const numA = parseFloat(a.seriesNumber || '0') || 0;
      const numB = parseFloat(b.seriesNumber || '0') || 0;
      return numA - numB;
    });
    seriesTomes.value = tomes;
  } else {
    seriesTomes.value = [];
  }
};

const navigateToBook = (uri: string) => {
  router.push({ name: 'BookDetail', params: { uri } });
};

const checkAndTriggerRehumanize = (currentBook: HumanizedBook) => {
  const needsHumanization = (currentBook.series && currentBook.series.startsWith('wd:')) ||
                            (currentBook.authors && currentBook.authors.some(a => a.startsWith('wd:'))) ||
                            (currentBook.publisher && currentBook.publisher.startsWith('wd:')) ||
                            (currentBook.genres && currentBook.genres.some(g => g.startsWith('wd:'))) ||
                            (currentBook.collection && currentBook.collection.startsWith('wd:'));
  if (needsHumanization) {
    console.log(`[DETAIL VIEW] Livre partiellement humanisé détecté (${currentBook.uri}). Ré-humanisation à la volée...`);
    entityHumanizer.rehumanize(currentBook).then((updated) => {
      if (updated) {
        book.value = { ...updated, loan: book.value?.loan };
      }
    });
  }
};

const loadBookDetails = async (uriParam: string) => {
  isLoading.value = true;
  errorMsg.value = '';
  successMessage.value = '';
  try {
    const normalized = isbnUtil.normalize(uriParam);
    if (isbnUtil.isValidFormat(normalized)) {
      console.log(`[DETAIL VIEW] Détection ISBN : Aiguillage vers le flux de recherche standard pour : ${normalized}`);
      const response = await searchService.searchByIsbn(normalized);
      if (response) {
        if ('isUnknown' in response && (response as any).isUnknown) {
          router.push({ name: 'BookCreateUnknown', query: { isbn: (response as any).isbn } });
          return;
        }
        const mainBook = response.mainBook;
        if (response.loan?.details) {
          mainBook.loan = response.loan.details;
        }
        book.value = mainBook;
        checkAndTriggerRehumanize(mainBook);
      } else {
        errorMsg.value = TEXTS.bookDetail.fetchError;
      }
      return;
    }

    // Flux normal pour les URIs (inv:...) ou autres identifiants (avec fallback ISBN si promu en tâche de fond)
    let cached = await databaseService.getBookFromCache(uriParam);
    if (!cached && uriParam.startsWith('isbn:')) {
      cached = await databaseService.getBookByIsbn(isbnUtil.normalize(uriParam.slice(5)));
    }
    if (cached) {
      const activeLoan = await databaseService.getLoan(cached.uri);
      if (activeLoan) {
        cached.loan = activeLoan;
      }
      book.value = cached;
      checkAndTriggerRehumanize(cached);
      return;
    }

    console.log(`[DETAIL VIEW] Non trouvé en cache, résolution réseau pour : ${uriParam}`);
    const resolved = await entityResolver.resolvePhysicalEntity(uriParam);
    if (resolved) {
      const activeLoan = await databaseService.getLoan(resolved.uri);
      if (activeLoan) {
        resolved.loan = activeLoan;
      }
      book.value = resolved;
      checkAndTriggerRehumanize(resolved);
    } else {
      errorMsg.value = TEXTS.bookDetail.fetchError;
    }
  } catch (e) {
    console.error("[DETAIL VIEW] Erreur de chargement :", e);
    errorMsg.value = TEXTS.bookDetail.loadError;
  } finally {
    isLoading.value = false;
    if (book.value?.uri) {
      loadLocalReadingMeta(book.value.uri);
    }
    await loadSeriesContext();
  }
};

watch(() => route.params.uri, (newUri) => {
  if (newUri) {
    loadBookDetails(newUri as string);
  }
});

watch(
  () => backgroundCreationOrchestrator.status.value.lastCompletedAt,
  async (val) => {
    if (!val || !book.value) return;
    const currentIsbn = book.value.isbn13 || book.value.isbn10 || (book.value.uri.startsWith('isbn:') ? book.value.uri.slice(5) : undefined);
    const refreshed =
      (await databaseService.getBookFromCache(book.value.uri)) ||
      (currentIsbn ? await databaseService.getBookByIsbn(isbnUtil.normalize(currentIsbn)) : undefined);
    if (refreshed) {
      const activeLoan = await databaseService.getLoan(refreshed.uri);
      book.value = activeLoan ? { ...refreshed, loan: activeLoan } : refreshed;
    }
    await loadSeriesContext();
  }
);

onMounted(() => {
  const uriParam = route.params.uri as string;
  if (uriParam) {
    loadBookDetails(uriParam);
  } else {
    errorMsg.value = TEXTS.bookDetail?.missingId || "Identifiant du livre manquant.";
    isLoading.value = false;
  }
});

const navigateToSeries = () => {
  if (seriesIdentifier.value) {
    router.push({ name: 'SeriesView', params: { id: seriesIdentifier.value } });
  }
};

const navigateToEdit = () => {
  if (book.value?.uri) {
    router.push(`/book/${encodeURIComponent(book.value.uri)}/edit`);
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

const handleDelete = () => {
  showDeleteModal.value = true;
};

const confirmDelete = async () => {
  if (!book.value?.uri) return;
  errorMsg.value = '';
  successMessage.value = '';
  try {
    const status = book.value.ownershipStatus;
    if (status === 'owned') {
      await inventoryService.removeFromLibrary(book.value.uri);
    } else if (status === 'wish') {
      await wishlistService.removeFromWishlist([book.value.uri]);
    }
    book.value.ownershipStatus = 'none';
    if (book.value.loan) {
      delete book.value.loan;
    }
    successMessage.value = TEXTS.bookDetail?.deleteSuccess || "L'ouvrage a bien été supprimé.";
  } catch (error: any) {
    errorMsg.value = error.message || "Erreur lors de la suppression de l'ouvrage.";
  } finally {
    showDeleteModal.value = false;
  }
};
</script>

<template>
  <div class="view-container detail-container">
    <BaseHeader title="Détails de l'édition" showBack>
      <template #actions>
        <BaseButton v-if="hasSeries" @click="navigateToSeries">{{ TEXTS.bookDetail.btnSeries }}</BaseButton>
      </template>
    </BaseHeader>

    <BaseLoading v-if="isLoading" />

    <BaseBanner v-else-if="errorMsg" type="error" :message="errorMsg" />

    <div v-else-if="book" class="result-card success">
      <BaseBanner v-if="successMessage" type="success" :message="successMessage" />

      <!-- Bandeau de Statut de Possession Explicite -->
      <div class="book-status-banner" :class="isLent ? 'lent' : (book.ownershipStatus === 'owned' ? 'owned' : (book.ownershipStatus === 'wish' ? 'wish' : 'none'))">
        <span class="status-banner-text">
          {{ 
            isLent ? `${TEXTS.bookStatus?.lent || 'Prêté'} à ${book.loan?.friendName}` : 
            (book.ownershipStatus === 'owned' ? TEXTS.bookStatus?.owned : 
            (book.ownershipStatus === 'wish' ? TEXTS.bookStatus?.wish : TEXTS.bookStatus?.none)) 
          }}
        </span>
      </div>

      <div class="book-card-layout">
        <div class="book-cover-nav-container">
          <button 
            v-if="hasSeries"
            class="wireframe-btn cover-nav-btn prev-btn" 
            :disabled="!previousBook" 
            @click="previousBook && navigateToBook(previousBook.uri)"
            aria-label="Tome précédent"
          >
            &lt;
          </button>

          <div class="book-cover-wrapper">
            <div v-if="!book.localCover && !book.coverUrl" class="book-cover-placeholder">
              {{ TEXTS.bookDetail.noCover }}
            </div>
            <img 
              v-else 
              :src="imageUtil.resolveCoverUrl(book)" 
              :alt="book.title" 
              class="book-cover-image" 
            />
          </div>

          <button 
            v-if="hasSeries"
            class="wireframe-btn cover-nav-btn next-btn" 
            :disabled="!nextBook" 
            @click="nextBook && navigateToBook(nextBook.uri)"
            aria-label="Tome suivant"
          >
            &gt;
          </button>
        </div>

        <div class="book-info-layout">
          <div>
            <h3 class="book-title">{{ book.title }}</h3>
            <h4 v-if="book.subtitle" class="book-subtitle">{{ book.subtitle }}</h4>
          </div>

          <div v-if="hasSeries" class="book-meta-group">
            <p class="book-meta-item">
              <strong>{{ TEXTS.bookCard.series }} :</strong> 
              {{ book.series }}
              <span v-if="book.seriesNumber"> (Tome {{ book.seriesNumber }})</span>
            </p>
          </div>

          <div class="book-meta-group" v-if="book.authors?.length || book.scriptwriters?.length || book.illustrators?.length">
            <p class="book-meta-item" v-if="book.authors?.length">
              <strong>{{ TEXTS.bookCard.meta.authors }} :</strong> {{ book.authors.join(', ') }}
            </p>
            <p class="book-meta-item" v-if="book.scriptwriters?.length">
              <strong>{{ TEXTS.bookCard.meta.scriptwriters }} :</strong> {{ book.scriptwriters.join(', ') }}
            </p>
            <p class="book-meta-item" v-if="book.illustrators?.length">
              <strong>{{ TEXTS.bookCard.meta.illustrators }} :</strong> {{ book.illustrators.join(', ') }}
            </p>
          </div>

          <div class="book-meta-group">
            <p class="book-meta-item" v-if="book.publisher">
              <strong>{{ TEXTS.bookCard.meta.publisher }} :</strong> {{ book.publisher }} 
              <span v-if="book.collection">[{{ book.collection }}]</span>
            </p>
            <p class="book-meta-item" v-if="book.genres?.length">
              <strong>{{ TEXTS.bookCard.meta.genres }} :</strong> {{ book.genres.join(', ') }}
            </p>
            <p class="book-meta-item" v-if="book.publishDate">
              <strong>{{ TEXTS.bookCard.meta.publishDate }} :</strong> {{ book.publishDate }}
            </p>
            <p class="book-meta-item" v-if="book.pageCount">
              <strong>{{ TEXTS.bookCard.meta.pageCount }} :</strong> {{ book.pageCount }}
            </p>
            <p class="book-meta-item" v-if="book.isbn13 || book.isbn10">
              <strong>ISBN :</strong> {{ book.isbn13 || book.isbn10 }}
            </p>
          </div>
        </div>
      </div>

      <div v-if="hasSeries" style="margin-top: var(--spacing-md); margin-bottom: var(--spacing-md); width: 100%;">
        <button class="wireframe-btn" @click="navigateToSeries">
          [ {{ TEXTS.bookDetail.btnSeries.toUpperCase() }} : {{ book.series || 'SAGA' }} ]
        </button>
      </div>

      <div class="book-description" v-if="book.description">
        <h3 class="result-title">{{ TEXTS.bookDetail.synopsis }}</h3>
        <p>{{ book.description }}</p>
      </div>

      <!-- Statut de lecture optionnel + Actions V2 (Couverture WebP & Rattachement Série / Hors-Série) -->
      <div style="margin: 1rem 0; padding: 0.75rem; border: 2px solid #000; background: #f8fafc; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          <strong style="font-size: 0.85rem;">📖 Lecture (optionnel) :</strong>
          <select v-model="readingStatus" @change="saveLocalReadingMeta" style="border: 2px solid #000; padding: 0.3rem 0.5rem; font-weight: 700; font-size: 0.82rem;">
            <option value="none">— Non renseigné —</option>
            <option value="unread">📚 À lire (PAL)</option>
            <option value="reading">⏳ En cours de lecture</option>
            <option value="read">✅ Lu</option>
            <option value="abandoned">⏸️ Abandonné</option>
          </select>
          <select v-model.number="readingRating" @change="saveLocalReadingMeta" style="border: 2px solid #000; padding: 0.3rem 0.5rem; font-weight: 700; font-size: 0.82rem;">
            <option :value="0">Note : —</option>
            <option :value="5">★★★★★ (5/5)</option>
            <option :value="4">★★★★☆ (4/5)</option>
            <option :value="3">★★★☆☆ (3/5)</option>
            <option :value="2">★★☆☆☆ (2/5)</option>
            <option :value="1">★☆☆☆☆ (1/5)</option>
          </select>
        </div>

        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <label class="wireframe-btn" style="cursor: pointer; padding: 0.35rem 0.65rem; font-size: 0.8rem; width: auto;">
            <input type="file" accept="image/*" capture="environment" hidden @change="handleCustomCoverUpload" />
            📸 Photo Couverture (WebP)
          </label>
          <button
            type="button"
            class="wireframe-btn"
            style="padding: 0.35rem 0.65rem; font-size: 0.8rem; width: auto; background: #eef2ff;"
            @click="showSeriesMergeModal = true"
          >
            🔗 {{ hasSeries ? 'Changer / Fusionner la série' : 'Rattacher à une série (ou Hors-Série)' }}
          </button>
        </div>
      </div>

      <div class="book-actions-layout">
        <BookActionButtons 
          :ownership-status="book.ownershipStatus"
          :is-lent="isLent"
          @add-inventory="handleAddInventory"
          @add-wishlist="handleAddWishlist"
          @lend="handleLend"
          @return="handleReturn"
          @delete="handleDelete"
        />
        <div v-if="book.ownershipStatus === 'owned'" style="margin-top: var(--spacing-sm); width: 100%; display: flex; justify-content: center;">
          <BaseButton 
            type="primary" 
            style="width: 100%;"
            :disabled="connectionState.isOffline.value"
            @click="navigateToEdit"
          >
            [ MODIFIER / CORRIGER LA FICHE ]
          </BaseButton>
        </div>
      </div>
    </div>

    <SeriesMergeModal
      v-if="book"
      :show="showSeriesMergeModal"
      :bookUris="[book.uri, ...(book.workUri ? [book.workUri] : [])]"
      :currentSeriesId="book.seriesId"
      :currentSeriesTitle="book.series"
      :initialVolumeLabel="book.seriesNumber"
      @close="showSeriesMergeModal = false"
      @merged="handleSeriesMerged"
    />

    <LendModal
      :show="showLendModal"
      :bookCount="1"
      @close="showLendModal = false"
      @confirm="confirmLend"
    />

    <!-- Modal de confirmation de suppression -->
    <div v-if="showDeleteModal" class="modal-overlay" @click.self="showDeleteModal = false">
      <div class="modal-box">
        <h2>{{ TEXTS.bookDetail?.deleteConfirmTitle || 'Confirmer la suppression' }}</h2>
        <p class="modal-text">
          {{ book?.ownershipStatus === 'owned' ? (TEXTS.bookDetail?.deleteConfirmMsg || 'Voulez-vous vraiment supprimer cet ouvrage de votre collection ? Cette action est définitive et le retirera également de votre compte inventaire.io.') : (TEXTS.bookDetail?.deleteConfirmWishMsg || 'Voulez-vous vraiment retirer cet ouvrage de votre liste d\'envies ? Cette action est définitive et le retirera également de votre compte inventaire.io.') }}
        </p>
        
        <div class="modal-actions">
          <button 
            @click="confirmDelete" 
            class="btn-danger"
          >
            {{ TEXTS.bookDetail?.btnDeleteConfirm || 'Supprimer' }}
          </button>
          
          <button @click="showDeleteModal = false" class="btn-close">
            {{ TEXTS.bookDetail?.btnDeleteCancel || 'Annuler' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.book-cover-nav-container {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: center !important;
  gap: var(--spacing-md) !important;
  width: 100% !important;
}

.book-cover-wrapper {
  display: flex !important;
  justify-content: center !important;
  align-items: center !important;
  flex-shrink: 0 !important;
}

.cover-nav-btn {
  width: 40px !important;
  height: 40px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  font-family: monospace !important;
  font-size: 20px !important;
  font-weight: bold !important;
  padding: 0 !important;
  cursor: pointer !important;
  background-color: var(--color-bg-main) !important;
  border: var(--border-width) solid var(--color-border) !important;
  color: var(--color-text-main) !important;
  user-select: none !important;
}

.cover-nav-btn:disabled {
  opacity: 0.25 !important;
  cursor: not-allowed !important;
}
</style>