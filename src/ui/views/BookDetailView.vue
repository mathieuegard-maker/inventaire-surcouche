<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
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

      <div v-if="hasSeries" style="margin-top: var(--spacing-md); margin-bottom: var(--spacing-md); width: 100%; border: 2px solid #000; background: #fff; padding: 0.75rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.6rem;">
          <strong style="font-size: 0.95rem;">
            Série : {{ book.series || 'SAGA' }} ({{ seriesTomes.length }} tome{{ seriesTomes.length > 1 ? 's' : '' }})
          </strong>
          <button class="wireframe-btn" style="width: auto; padding: 0.3rem 0.65rem; font-size: 0.8rem;" @click="navigateToSeries">
            [ {{ TEXTS.bookDetail.btnSeries.toUpperCase() }} ]
          </button>
        </div>

        <div v-if="seriesProgress.isActive" style="font-size: 0.82rem; font-weight: 700; color: #1d4ed8; margin-bottom: 0.6rem; padding: 0.4rem 0.6rem; background: #eff6ff; border: 1px dashed #1d4ed8;">
          Récupération automatique des tomes de la série via BnF ({{ seriesProgress.current }} / {{ seriesProgress.total || '...' }})...
        </div>

        <div v-if="seriesTomes.length > 0" style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.6rem;">
          <button
            v-if="missingSeriesTomes.length > 0"
            type="button"
            class="wireframe-btn"
            style="width: auto; padding: 0.35rem 0.65rem; font-size: 0.8rem;"
            @click="selectAllMissingSeriesTomes"
          >
            {{ selectedSeriesTomeUris.length === missingSeriesTomes.length ? 'Tout décocher' : `Tout cocher (${missingSeriesTomeUris.length === 0 ? missingSeriesTomes.length : missingSeriesTomes.length} manquant${missingSeriesTomes.length > 1 ? 's' : ''})` }}
          </button>
          <button
            v-if="selectedSeriesTomeUris.length > 0"
            type="button"
            class="wireframe-btn btn-primary"
            style="width: auto; padding: 0.35rem 0.75rem; font-size: 0.82rem; font-weight: 800;"
            @click="addSelectedSeriesTomesToCollection"
          >
            + Ajouter les {{ selectedSeriesTomeUris.length }} tome(s) coché(s) à ma collection
          </button>
        </div>

        <div v-if="seriesTomes.length > 0" style="max-height: 260px; overflow-y: auto; border-top: 1px solid #cbd5e1; padding-top: 0.4rem; display: flex; flex-direction: column; gap: 0.35rem;">
          <div
            v-for="tome in seriesTomes"
            :key="tome.uri"
            style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.35rem 0.5rem; border: 1px solid #cbd5e1; background: #f8fafc;"
            :style="tome.uri === book.uri ? 'border: 2px solid #000; background: #fef9c3;' : ''"
          >
            <label style="display: flex; align-items: center; gap: 0.5rem; flex: 1; cursor: pointer; font-size: 0.85rem;">
              <input
                v-if="tome.ownershipStatus !== 'owned'"
                type="checkbox"
                :checked="selectedSeriesTomeUris.includes(tome.uri)"
                @change="toggleSeriesTomeSelection(tome.uri)"
                style="width: 18px; height: 18px; cursor: pointer;"
              />
              <span v-else style="color: #15803d; font-weight: 800; font-size: 0.8rem; min-width: 18px; text-align: center;">OK</span>
              <span>
                <strong v-if="tome.seriesNumber">T.{{ tome.seriesNumber }} — </strong>
                <span>{{ tome.title }}</span>
              </span>
            </label>
            <div style="display: flex; align-items: center; gap: 0.4rem;">
              <span
                v-if="tome.ownershipStatus === 'owned'"
                style="font-size: 0.72rem; font-weight: 800; background: #dcfce7; color: #166534; padding: 0.15rem 0.4rem; border: 1px solid #166534;"
              >
                Possédé
              </span>
              <button
                v-if="tome.uri !== book.uri"
                type="button"
                class="wireframe-btn"
                style="width: auto; padding: 0.2rem 0.45rem; font-size: 0.75rem;"
                @click="navigateToBook(tome.uri)"
              >
                Voir
              </button>
            </div>
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
</style>