<script setup lang="ts">
import { ref, computed, onMounted, onErrorCaptured, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { entityResolver } from '../../core/resolvers/entity.resolver';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { seriesOrchestrator } from '../../core/orchestrators/series.orchestrator';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import { isbnUtil } from '../../core/utils/isbn.util';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BaseButton from '../components/BaseButton.vue';
import LendModal from '../components/LendModal.vue';
import BookActionButtons from '../components/BookActionButtons.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';
import { entityHumanizer } from '../../core/resolvers/humanizer';
import { inventoryService } from '../../core/services/inventory.service';
import { wishlistService } from '../../core/services/wishlist.service';
import { imageUtil } from '../../core/utils/image.util';
import { connectionState } from '../../state/connection';
import { resolveCollectionOrderedUrisForBook } from '../../state/bookNavigation';

const route = useRoute();
const router = useRouter();

const book = ref<HumanizedBook | null>(null);
const isLoading = ref(true);
const errorMsg = ref('');
const successMessage = ref('');
const showLendModal = ref(false);
const showDeleteModal = ref(false);
const collectionOrderedUris = ref<string[]>([]);
const coverExhausted = ref(false);

watch(
  () => `${book.value?.uri || ''}|${book.value?.localCover || ''}|${book.value?.coverUrl || ''}`,
  () => {
    coverExhausted.value = false;
  }
);

const onDetailCoverError = (event: Event) => {
  if (!book.value) return;
  imageUtil.handleImageError(event, {
    isbn: book.value.isbn13 || book.value.isbn10,
    fallbackUrls: book.value.coverFallbackUrls,
    onExhausted: () => {
      coverExhausted.value = true;
    }
  });
};

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
  successMessage.value = 'Statut de lecture mis à jour.';
}

const isOwned = computed(() => book.value?.ownershipStatus === 'owned');
const isLent = computed(() => !!book.value?.loan);
const hasSeries = computed(() => !!book.value?.seriesId || !!book.value?.series);
const seriesIdentifier = computed(() => book.value?.seriesId || book.value?.series || '');

// Navigation et sélection rapide dans la série (Mode Simple)
const seriesTomes = ref<HumanizedBook[]>([]);
const selectedSeriesTomeUris = ref<string[]>([]);
const hydratedSeriesIds = new Set<string>();

const seriesProgress = computed(() => {
  const sid = book.value?.seriesId || '';
  return sid ? seriesOrchestrator.getProgress(sid).value : { current: 0, total: 0, isActive: false };
});

const missingSeriesTomes = computed(() =>
  seriesTomes.value.filter((t) => t.ownershipStatus !== 'owned')
);

const toggleSeriesTomeSelection = (uri: string) => {
  const idx = selectedSeriesTomeUris.value.indexOf(uri);
  if (idx > -1) {
    selectedSeriesTomeUris.value.splice(idx, 1);
  } else {
    selectedSeriesTomeUris.value.push(uri);
  }
};

const selectAllMissingSeriesTomes = () => {
  const missingUris = missingSeriesTomes.value.map((t) => t.uri);
  if (selectedSeriesTomeUris.value.length === missingUris.length) {
    selectedSeriesTomeUris.value = [];
  } else {
    selectedSeriesTomeUris.value = [...missingUris];
  }
};

const addSelectedSeriesTomesToCollection = async () => {
  if (selectedSeriesTomeUris.value.length === 0) return;
  try {
    const targets = [...selectedSeriesTomeUris.value];
    for (const uri of targets) {
      await queueService.enqueueAction('ADD_INVENTORY', uri);
    }
    seriesTomes.value = seriesTomes.value.map((t) =>
      targets.includes(t.uri) ? { ...t, ownershipStatus: 'owned' } : t
    );
    if (book.value && targets.includes(book.value.uri)) {
      book.value.ownershipStatus = 'owned';
    }
    selectedSeriesTomeUris.value = [];
    successMessage.value = `${targets.length} tome(s) de la série ajouté(s) à votre collection ✓`;
  } catch (e) {
    console.error(e);
    errorMsg.value = "Erreur lors de l'ajout des tomes sélectionnés.";
  }
};

const activeNavUris = computed(() => {
  if (!book.value) return [] as string[];
  if (collectionOrderedUris.value.length > 1 && collectionOrderedUris.value.includes(book.value.uri)) {
    return collectionOrderedUris.value;
  }
  if (seriesTomes.value.length > 1 && seriesTomes.value.some((t) => t.uri === book.value?.uri)) {
    return seriesTomes.value.map((t) => t.uri);
  }
  return [] as string[];
});

const hasSiblingNavigation = computed(() => activeNavUris.value.length > 1);

const currentNavIndex = computed(() => {
  if (!book.value || activeNavUris.value.length === 0) return -1;
  return activeNavUris.value.indexOf(book.value.uri);
});

const previousBookUri = computed(() => {
  const idx = currentNavIndex.value;
  return idx > 0 ? activeNavUris.value[idx - 1] : null;
});

const nextBookUri = computed(() => {
  const idx = currentNavIndex.value;
  return idx !== -1 && idx < activeNavUris.value.length - 1 ? activeNavUris.value[idx + 1] : null;
});

const loadSeriesContext = async () => {
  if (book.value?.seriesId) {
    const sid = book.value.seriesId;
    const context = await seriesOrchestrator.getCompleteSeriesForUI(sid, book.value.series);
    seriesTomes.value = context?.tomes || [];
    if (!hydratedSeriesIds.has(sid)) {
      hydratedSeriesIds.add(sid);
      seriesOrchestrator.startBackgroundHydration(sid);
    }
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

watch(
  () => [seriesProgress.value.current, seriesProgress.value.isActive],
  async () => {
    if (book.value?.seriesId) {
      const context = await seriesOrchestrator.getCompleteSeriesForUI(
        book.value.seriesId,
        book.value.series
      );
      seriesTomes.value = context?.tomes || [];
    }
  }
);

let activeLoadToken = 0;

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  }
  if (typeof val === 'string' && val.trim()) {
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function sanitizeBook(raw: HumanizedBook): HumanizedBook {
  return {
    ...raw,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Titre inconnu',
    authors: toStringArray(raw.authors),
    illustrators: toStringArray(raw.illustrators),
    scriptwriters: toStringArray(raw.scriptwriters),
    genres: toStringArray(raw.genres)
  };
}

function decodeRouteUri(raw: unknown): string {
  const str = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] || '') : '';
  if (!str) return '';
  try {
    return str.includes('%') ? decodeURIComponent(str) : str;
  } catch {
    return str;
  }
}

onErrorCaptured((err) => {
  console.error('[DETAIL VIEW] Erreur de rendu capturée :', err);
  errorMsg.value = 'Impossible d’afficher cette fiche livre.';
  isLoading.value = false;
  return false;
});

const navigateToBook = (uri: string) => {
  if (!uri) return;
  router.push(`/book/${encodeURIComponent(uri)}`);
};

const checkAndTriggerRehumanize = (currentBook: HumanizedBook) => {
  const needsHumanization = (currentBook.series && typeof currentBook.series === 'string' && currentBook.series.startsWith('wd:')) ||
                            currentBook.authors.some(a => a.startsWith('wd:')) ||
                            (currentBook.publisher && typeof currentBook.publisher === 'string' && currentBook.publisher.startsWith('wd:')) ||
                            currentBook.genres.some(g => g.startsWith('wd:')) ||
                            (currentBook.collection && typeof currentBook.collection === 'string' && currentBook.collection.startsWith('wd:'));
  if (needsHumanization) {
    console.log(`[DETAIL VIEW] Livre partiellement humanisé détecté (${currentBook.uri}). Ré-humanisation à la volée...`);
    entityHumanizer.rehumanize(currentBook).then((updated) => {
      if (updated) {
        book.value = sanitizeBook({ ...updated, loan: book.value?.loan });
      }
    });
  }
};

const loadBookDetails = async (rawUriParam: string) => {
  const loadToken = ++activeLoadToken;
  const uriParam = decodeRouteUri(rawUriParam);
  isLoading.value = true;
  errorMsg.value = '';
  successMessage.value = '';
  try {
    const normalized = isbnUtil.normalize(uriParam);
    if (isbnUtil.isValidFormat(normalized)) {
      console.log(`[DETAIL VIEW] Détection ISBN : Aiguillage vers le flux de recherche standard pour : ${normalized}`);
      const response = await searchService.searchByIsbn(normalized);
      if (loadToken !== activeLoadToken) return;
      if (response) {
        if ('isUnknown' in response && (response as any).isUnknown) {
          router.push({ name: 'BookCreateUnknown', query: { isbn: (response as any).isbn } });
          return;
        }
        const mainBook = sanitizeBook(response.mainBook);
        if (response.loan?.details) {
          mainBook.loan = response.loan.details;
        }
        book.value = mainBook;
        checkAndTriggerRehumanize(mainBook);
      } else {
        book.value = null;
        errorMsg.value = TEXTS.bookDetail.fetchError;
      }
      return;
    }

    // Flux normal pour les URIs (inv:..., ed:..., isbn:...)
    let cached = await databaseService.getBookFromCache(uriParam);
    if (!cached && uriParam.startsWith('isbn:')) {
      cached = await databaseService.getBookByIsbn(isbnUtil.normalize(uriParam.slice(5)));
    }
    if (loadToken !== activeLoadToken) return;
    if (cached) {
      const safeCached = sanitizeBook(cached);
      const activeLoan = await databaseService.getLoan(safeCached.uri);
      if (loadToken !== activeLoadToken) return;
      if (activeLoan) {
        safeCached.loan = activeLoan;
      }
      book.value = safeCached;
      checkAndTriggerRehumanize(safeCached);
      return;
    }

    console.log(`[DETAIL VIEW] Non trouvé en cache, résolution réseau pour : ${uriParam}`);
    const resolved = await entityResolver.resolvePhysicalEntity(uriParam);
    if (loadToken !== activeLoadToken) return;
    if (resolved) {
      const safeResolved = sanitizeBook(resolved);
      const activeLoan = await databaseService.getLoan(safeResolved.uri);
      if (loadToken !== activeLoadToken) return;
      if (activeLoan) {
        safeResolved.loan = activeLoan;
      }
      book.value = safeResolved;
      checkAndTriggerRehumanize(safeResolved);
    } else {
      book.value = null;
      errorMsg.value = TEXTS.bookDetail.fetchError;
    }
  } catch (e) {
    if (loadToken !== activeLoadToken) return;
    console.error("[DETAIL VIEW] Erreur de chargement :", e);
    book.value = null;
    errorMsg.value = TEXTS.bookDetail.loadError;
  } finally {
    if (loadToken !== activeLoadToken) return;
    isLoading.value = false;
    if (book.value?.uri) {
      loadLocalReadingMeta(book.value.uri);
      collectionOrderedUris.value = await resolveCollectionOrderedUrisForBook(book.value.uri);
    } else {
      collectionOrderedUris.value = [];
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
    seriesTomes.value = seriesTomes.value.map((t) =>
      t.uri === book.value?.uri ? { ...t, ownershipStatus: 'owned' } : t
    );
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
    seriesTomes.value = seriesTomes.value.map((t) =>
      t.uri === book.value?.uri ? { ...t, ownershipStatus: 'none' } : t
    );
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
            v-if="hasSiblingNavigation"
            class="wireframe-btn cover-nav-btn prev-btn"
            :disabled="!previousBookUri"
            @click="previousBookUri && navigateToBook(previousBookUri)"
            aria-label="Œuvre précédente"
          >
            &lt;
          </button>

          <div class="book-cover-wrapper">
            <div v-if="coverExhausted || (!book.localCover && !book.coverUrl && !book.isbn13 && !book.isbn10)" class="book-cover-placeholder">
              {{ TEXTS.bookDetail.noCover }}
            </div>
            <img
              v-else
              :src="imageUtil.resolveCoverUrl(book.localCover ? book : (book.coverUrl || imageUtil.buildCoverCandidates(book.isbn13 || book.isbn10)[0] || ''))"
              :alt="book.title"
              class="book-cover-image"
              @error="onDetailCoverError"
            />
          </div>

          <button
            v-if="hasSiblingNavigation"
            class="wireframe-btn cover-nav-btn next-btn"
            :disabled="!nextBookUri"
            @click="nextBookUri && navigateToBook(nextBookUri)"
            aria-label="Œuvre suivante"
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
              <span class="saga-sep"> — </span>
              <button type="button" class="discreet-saga-link" @click="navigateToSeries">
                Voir toute la saga{{ seriesTomes.length > 0 ? ` (${seriesTomes.length} tomes)` : '' }}
              </button>
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

          <!-- Lu / Non lu et Note discrets entre métadonnées et synopsis -->
          <div class="book-meta-group book-reading-discreet">
            <p class="book-meta-item reading-inline-row">
              <strong>Lecture :</strong>
              <select v-model="readingStatus" @change="saveLocalReadingMeta" class="discreet-meta-select">
                <option value="none">Non renseigné</option>
                <option value="unread">Non lu (À lire)</option>
                <option value="reading">En cours</option>
                <option value="read">Lu</option>
                <option value="abandoned">Abandonné</option>
              </select>
              <strong style="margin-left: 8px;">Note :</strong>
              <select v-model.number="readingRating" @change="saveLocalReadingMeta" class="discreet-meta-select">
                <option :value="0">—</option>
                <option :value="5">5 / 5</option>
                <option :value="4">4 / 5</option>
                <option :value="3">3 / 5</option>
                <option :value="2">2 / 5</option>
                <option :value="1">1 / 5</option>
              </select>
            </p>
          </div>
        </div>
      </div>

      <div class="book-description" v-if="book.description">
        <h3 class="result-title">{{ TEXTS.bookDetail.synopsis }}</h3>
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
          @delete="handleDelete"
        />
        <div style="margin-top: var(--spacing-sm); width: 100%; display: flex; justify-content: center;">
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

    <LendModal
      :show="showLendModal"
      :bookCount="1"
      @close="showLendModal = false"
      @confirm="confirmLend"
    />

    <!-- Modal de confirmation de suppression -->
    <Teleport to="body">
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
    </Teleport>
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
  width: 175px !important;
  height: 240px !important;
  flex-shrink: 0 !important;
}

.book-cover-wrapper :deep(.book-cover-image),
.book-cover-wrapper .book-cover-image {
  width: auto !important;
  height: auto !important;
  max-width: 100% !important;
  max-height: 100% !important;
  object-fit: contain !important;
}

.book-cover-wrapper .book-cover-placeholder {
  width: 100% !important;
  height: 100% !important;
  min-height: 0 !important;
  margin-bottom: 0 !important;
}

.cover-nav-btn {
  width: 40px !important;
  height: 40px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  font-family: var(--font-main) !important;
  font-size: 1.125rem !important;
  font-weight: 700 !important;
  padding: 0 !important;
  cursor: pointer !important;
  background-color: var(--color-bg-main) !important;
  border: 1px solid var(--color-border) !important;
  border-radius: 9999px !important;
  box-shadow: var(--shadow-sm) !important;
  color: var(--color-text-main) !important;
  user-select: none !important;
  transition: background-color 0.15s ease, border-color 0.15s ease !important;
}

.cover-nav-btn:hover:not(:disabled) {
  background-color: var(--color-bg-alt) !important;
  border-color: var(--color-border-hover) !important;
}

.cover-nav-btn:disabled {
  opacity: 0.25 !important;
  cursor: not-allowed !important;
}

.reading-inline-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.discreet-meta-select {
  border: 1px solid #cbd5e1;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  padding: 1px 4px;
  cursor: pointer;
}

.discreet-saga-link {
  background: none;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: #1d4ed8;
  text-decoration: underline;
  font-weight: 700;
  cursor: pointer;
}
</style>