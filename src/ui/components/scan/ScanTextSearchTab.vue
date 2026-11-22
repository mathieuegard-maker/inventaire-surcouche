<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { databaseService } from '../../../core/database/database.service';
import { searchService } from '../../../core/orchestrators/search.orchestrator';
import type {
  CatalogSearchBookHit,
  CatalogSearchResponse,
  CatalogSearchSeriesHit
} from '../../../core/services/catalog-search.service';
import { annotateIntegralCoverage } from '../../../core/bibliographic/integral.util';
import { isbnUtil } from '../../../core/utils/isbn.util';
import { imageUtil } from '../../../core/utils/image.util';
import { saveBookNavigationOrder } from '../../../state/bookNavigation';
import { fetchWithTimeout } from '../../../state/connection';
import { sessionStore } from '../../../state/session';
import { pendingScansStore } from '../../../state/pendingScans';
import { textSearchState } from '../../../state/textSearchState';
import type { HumanizedBook } from '../../../core/types';
import { useBookBatchActions } from '../../composables/useBookBatchActions';
import BookMiniCard from '../BookMiniCard.vue';
import SeriesMiniCard from '../SeriesMiniCard.vue';
import WireframeTable from '../WireframeTable.vue';
import BatchActionBar from '../BatchActionBar.vue';
import LendModal from '../LendModal.vue';

const router = useRouter();

// État persistant : ouvrir une fiche puis revenir en arrière conserve la recherche !
const form = textSearchState.form;
const seriesResults = textSearchState.seriesResults;
const results = textSearchState.bookResults;
const searchDone = textSearchState.searchDone;
const searchError = textSearchState.searchError;

const isSearching = ref(false);

const {
  selectedUris,
  selectedBooks,
  isAllSelected,
  showLendModal,
  batchBusy,
  feedbackMessage,
  errorMessage: batchError,
  toggleAll,
  toggleSelection,
  clearSelection,
  dispatchBatchAction,
  confirmGroupLend
} = useBookBatchActions(results, {
  sourceChannel: 'canal_3_text_search',
  fallbackToBackgroundCreation: false
});

const hasCriteria = computed(() => {
  const f = form.value;
  return Boolean(
    f.title.trim() ||
      f.series.trim() ||
      f.volumeNumber.trim() ||
      f.author.trim() ||
      f.edition.trim() ||
      f.publisher.trim() ||
      f.isbn.trim()
  );
});

const resetForm = () => {
  textSearchState.reset();
  clearSelection();
  feedbackMessage.value = '';
  batchError.value = '';
};

const hitToHumanizedBook = async (hit: CatalogSearchBookHit): Promise<HumanizedBook> => {
  const cached = await databaseService.getBookFromCache(hit.uri).catch(() => null);
  const candidates = hit.coverFallbackUrls?.length
    ? hit.coverFallbackUrls
    : hit.isbn13
      ? imageUtil.buildCoverCandidates(hit.isbn13, [hit.coverUrl])
      : hit.coverUrl
        ? [hit.coverUrl]
        : [];
  return {
    uri: cached?.uri || hit.uri,
    bookId: cached?.bookId || hit.bookId,
    type: 'edition',
    isbn13: cached?.isbn13 || hit.isbn13,
    title: cached?.title || hit.title || 'Titre inconnu',
    authors: cached?.authors?.length
      ? cached.authors
      : hit.authors?.length
        ? hit.authors
        : ['Auteur inconnu'],
    illustrators: cached?.illustrators || [],
    scriptwriters: cached?.scriptwriters || [],
    publisher: cached?.publisher || hit.publisher,
    publishDate: cached?.publishDate || hit.publishDate,
    series: cached?.series || hit.series,
    seriesId: cached?.seriesId || hit.seriesId,
    seriesNumber: cached?.seriesNumber || hit.seriesNumber,
    genres: cached?.genres || [],
    coverUrl: cached?.localCover || cached?.coverUrl || hit.coverUrl || candidates[0],
    coverFallbackUrls: cached?.coverFallbackUrls || candidates,
    ownershipStatus: cached?.ownershipStatus || hit.ownershipStatus || 'none',
    isIntegral: cached?.isIntegral ?? Boolean(hit.isIntegral),
    integralMetadata:
      cached?.integralMetadata ||
      (hit.includedVolumeNumbers?.length
        ? {
            includedVolumeNumbers: hit.includedVolumeNumbers,
            includedWorkIds: [],
            includedIsbns: []
          }
        : undefined),
    wishedByName: cached?.wishedByName,
    loan: cached?.loan
  };
};

const openSeriesHit = async (s: CatalogSearchSeriesHit) => {
  if (s.isMaterializedInLocal || s.id.startsWith('wd:') || s.id.startsWith('inv:') || s.id.startsWith('ser_')) {
    await router.push({ name: 'SeriesView', params: { id: s.id }, query: { fromMode: 'search' } });
    return;
  }
  // Série découverte uniquement en externe (BnF) : relancer la recherche ciblée sur cette série
  form.value = {
    ...form.value,
    series: s.name,
    title: '',
    volumeNumber: ''
  };
  await handleSearch();
};

const handleSearch = async () => {
  if (!hasCriteria.value || isSearching.value) return;
  isSearching.value = true;
  searchError.value = '';
  batchError.value = '';
  feedbackMessage.value = '';
  searchDone.value = false;
  clearSelection();

  try {
    const f = form.value;
    const cleanedIsbn = f.isbn.trim() ? isbnUtil.normalize(f.isbn.trim()) : '';

    if (cleanedIsbn && isbnUtil.isValidFormat(cleanedIsbn)) {
      const isbn13 = cleanedIsbn.length === 10 ? isbnUtil.toIsbn13(cleanedIsbn) : cleanedIsbn;
      const res = await searchService.searchByIsbn(isbn13);
      seriesResults.value = [];
      if ((res as any)?.isOfflineUnavailable) {
        pendingScansStore.addPendingScan(isbn13);
        searchError.value = `Hors réseau : l'ISBN ${isbn13} a été mémorisé pour consultation ultérieure.`;
        results.value = [];
        return;
      }
      if (res?.mainBook) {
        const allCached = await databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]);
        results.value = annotateIntegralCoverage([res.mainBook], allCached);
        saveBookNavigationOrder([res.mainBook.uri], 'direct');
      } else {
        results.value = [];
      }
      searchDone.value = true;
      return;
    }

    const savedUri = sessionStore.getUserUri() || undefined;
    const response = await fetchWithTimeout('/api/v2/books/search-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: f.title.trim() || undefined,
        series: f.series.trim() || undefined,
        volumeNumber: f.volumeNumber.trim() || undefined,
        author: f.author.trim() || undefined,
        edition: f.edition.trim() || undefined,
        publisher: f.publisher.trim() || undefined,
        userUri: savedUri
      }),
      timeout: 16000
    });

    if (!response.ok) {
      searchError.value = 'Service de recherche temporairement indisponible.';
      return;
    }

    const data = (await response.json()) as CatalogSearchResponse;
    seriesResults.value = Array.isArray(data.series) ? data.series : [];

    const books: HumanizedBook[] = [];
    for (const hit of data.books || []) {
      books.push(await hitToHumanizedBook(hit));
    }

    const allCached = await databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]);
    results.value = annotateIntegralCoverage(books, allCached);
    saveBookNavigationOrder(books.map((b) => b.uri), 'direct');
    searchDone.value = true;
  } catch (err: unknown) {
    searchError.value = err instanceof Error ? err.message : 'Erreur lors de la recherche.';
  } finally {
    isSearching.value = false;
  }
};
</script>

<template>
  <section class="text-search-section">
    <form class="ds-card" @submit.prevent="handleSearch">
      <p class="search-hint">
        Renseignez un ou plusieurs champs pour explorer séries et œuvres (catalogue serveur &amp; BnF) :
      </p>

      <div class="text-search-grid">
        <label class="ds-field">
          <span>Nom / Titre</span>
          <input v-model="form.title" type="text" class="ds-input" placeholder="Ex: Le Secret de la Licorne" />
        </label>
        <label class="ds-field">
          <span>Série</span>
          <input v-model="form.series" type="text" class="ds-input" placeholder="Ex: Tintin, De Cape et de Crocs" />
        </label>
        <label class="ds-field">
          <span>N° de tome</span>
          <input v-model="form.volumeNumber" type="text" class="ds-input" placeholder="Ex: 11" />
        </label>
        <label class="ds-field">
          <span>Auteur</span>
          <input v-model="form.author" type="text" class="ds-input" placeholder="Ex: Hergé" />
        </label>
        <label class="ds-field">
          <span>Édition / Collection</span>
          <input v-model="form.edition" type="text" class="ds-input" placeholder="Ex: Intégrale, Nomad" />
        </label>
        <label class="ds-field">
          <span>Éditeur</span>
          <input v-model="form.publisher" type="text" class="ds-input" placeholder="Ex: Casterman, Delcourt" />
        </label>
        <label class="ds-field">
          <span>ISBN (10 ou 13)</span>
          <input v-model="form.isbn" type="text" class="ds-input" placeholder="Ex: 9782203001107" />
        </label>
      </div>

      <div class="ds-actions-row">
        <button
          type="submit"
          class="wireframe-btn primary search-submit-btn"
          :disabled="!hasCriteria || isSearching"
        >
          {{ isSearching ? 'Recherche en cours...' : 'Rechercher' }}
        </button>
        <button type="button" class="wireframe-btn search-reset-btn" :disabled="isSearching" @click="resetForm">
          Effacer
        </button>
      </div>
    </form>

    <div v-if="searchError" class="ds-banner ds-banner-error">{{ searchError }}</div>
    <div v-if="batchError" class="ds-banner ds-banner-error">{{ batchError }}</div>
    <div v-if="feedbackMessage" class="ds-banner ds-banner-success">{{ feedbackMessage }}</div>

    <div v-if="searchDone && seriesResults.length === 0 && results.length === 0 && !searchError" class="ds-card">
      <p class="search-empty">Aucune série ni aucun ouvrage trouvé avec ces critères.</p>
    </div>

    <!-- SECTION 1 : SÉRIES CORRESPONDANTES -->
    <div v-if="seriesResults.length > 0" class="ds-card">
      <div class="ds-section-header">
        <h3 class="search-section-title">Séries correspondantes ({{ seriesResults.length }})</h3>
      </div>
      <WireframeTable>
        <SeriesMiniCard
          v-for="saga in seriesResults"
          :key="saga.id"
          :name="saga.name"
          :owned-count="saga.ownedCount"
          :cover-url="saga.coverUrl ? imageUtil.resolveExternalUrl(saga.coverUrl) : undefined"
          @click="openSeriesHit(saga)"
        />
      </WireframeTable>
    </div>

    <!-- SECTION 2 : ŒUVRES & ALBUMS -->
    <div v-if="results.length > 0" class="ds-card">
      <div class="ds-section-header">
        <h3 class="search-section-title">Œuvres &amp; albums ({{ results.length }})</h3>
        <label class="select-all-row">
          <input
            type="checkbox"
            class="wireframe-checkbox"
            :checked="isAllSelected"
            @change="toggleAll(($event.target as HTMLInputElement).checked)"
          />
          <span>
            {{ selectedUris.length === 0 ? 'Tout cocher' : `${selectedUris.length} sélectionné(s)` }}
          </span>
        </label>
      </div>

      <WireframeTable>
        <BookMiniCard
          v-for="livre in results"
          :key="livre.uri"
          :book="livre"
          :model-value="selectedUris.includes(livre.uri)"
          @update:model-value="(val) => toggleSelection(livre.uri, val)"
        />
      </WireframeTable>

      <BatchActionBar
        :inline="true"
        :selected-count="selectedUris.length"
        :selected-books="selectedBooks"
        :busy="batchBusy"
        @execute="dispatchBatchAction"
        @clear="clearSelection"
      />
    </div>

    <LendModal
      :show="showLendModal"
      :bookCount="selectedBooks.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />
  </section>
</template>

<style scoped>
.text-search-section {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.search-hint,
.search-empty {
  margin: 0 0 0.75rem;
  font-size: 0.88rem;
  color: var(--color-text-muted);
}

.search-empty {
  margin-bottom: 0;
}

.search-section-title {
  margin: 0;
  font-size: 0.96rem;
  font-weight: 800;
  color: var(--color-text-main);
}

.text-search-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 0.65rem;
  margin-bottom: 0.85rem;
}

.search-submit-btn {
  flex: 2;
  min-width: 160px;
}

.search-reset-btn {
  flex: 1;
  min-width: 100px;
}

.select-all-row {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
}
</style>
