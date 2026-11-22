<script setup lang="ts">
import { computed, ref } from 'vue';
import { databaseService } from '../../../core/database/database.service';
import { searchService } from '../../../core/orchestrators/search.orchestrator';
import { resolveHintsViaV4Backend } from '../../../core/services/v4-client.service';
import type { Canal3ResolutionOption } from '../../../core/services/canal3-resolver.service';
import { annotateIntegralCoverage } from '../../../core/bibliographic/integral.util';
import { isbnUtil } from '../../../core/utils/isbn.util';
import { imageUtil } from '../../../core/utils/image.util';
import { saveBookNavigationOrder } from '../../../state/bookNavigation';
import { pendingScansStore } from '../../../state/pendingScans';
import type { HumanizedBook } from '../../../core/types';
import { useBookBatchActions } from '../../composables/useBookBatchActions';
import BookMiniCard from '../BookMiniCard.vue';
import WireframeTable from '../WireframeTable.vue';
import BatchActionBar from '../BatchActionBar.vue';
import LendModal from '../LendModal.vue';
import IntegralConfigFields from '../IntegralConfigFields.vue';

const form = ref({
  title: '',
  series: '',
  volumeNumber: '',
  author: '',
  edition: '',
  publisher: '',
  isbn: ''
});

const isSearching = ref(false);
const searchError = ref('');
const searchDone = ref(false);
const results = ref<HumanizedBook[]>([]);

const {
  selectedUris,
  selectedBooks,
  isAllSelected,
  showLendModal,
  batchBusy,
  feedbackMessage,
  errorMessage: batchError,
  editingIntegralUri,
  integralFlag,
  integralVolsText,
  integralSaving,
  toggleAll,
  toggleSelection,
  clearSelection,
  toggleIntegralEditor,
  applyIntegralEditor,
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
  form.value = {
    title: '',
    series: '',
    volumeNumber: '',
    author: '',
    edition: '',
    publisher: '',
    isbn: ''
  };
  results.value = [];
  clearSelection();
  searchError.value = '';
  feedbackMessage.value = '';
  batchError.value = '';
  searchDone.value = false;
};

const optionToHumanizedBook = async (opt: Canal3ResolutionOption): Promise<HumanizedBook | null> => {
  const isbn13 = String(opt.isbn13 || '').trim();
  if (!isbn13) return null;
  const uri = `isbn:${isbn13}`;
  const cached = await databaseService.getBookFromCache(uri).catch(() => null);
  const candidates = opt.coverFallbackUrls?.length
    ? opt.coverFallbackUrls
    : imageUtil.buildCoverCandidates(isbn13, [opt.coverUrl]);
  return {
    uri: cached?.uri || uri,
    bookId: cached?.bookId,
    type: 'edition',
    isbn13,
    title: cached?.title || opt.title || 'Titre inconnu',
    authors: cached?.authors?.length
      ? cached.authors
      : opt.authors?.length
        ? opt.authors
        : ['Auteur inconnu'],
    illustrators: cached?.illustrators || [],
    scriptwriters: cached?.scriptwriters || [],
    publisher: cached?.publisher || opt.publisher,
    publishDate: cached?.publishDate || opt.publishDate,
    series: cached?.series || opt.series,
    seriesId: cached?.seriesId,
    seriesNumber: cached?.seriesNumber || opt.seriesNumber,
    genres: cached?.genres || [],
    coverUrl: cached?.localCover || cached?.coverUrl || opt.coverUrl || candidates[0],
    coverFallbackUrls: cached?.coverFallbackUrls || candidates,
    ownershipStatus: cached?.ownershipStatus || 'none',
    isIntegral: cached?.isIntegral ?? Boolean(opt.isIntegral),
    integralMetadata:
      cached?.integralMetadata ||
      (opt.includedVolumeNumbers?.length
        ? {
            includedVolumeNumbers: opt.includedVolumeNumbers,
            includedWorkIds: [],
            includedIsbns: []
          }
        : undefined),
    wishedByName: cached?.wishedByName,
    loan: cached?.loan
  };
};

const handleSearch = async () => {
  if (!hasCriteria.value || isSearching.value) return;
  isSearching.value = true;
  searchError.value = '';
  batchError.value = '';
  feedbackMessage.value = '';
  searchDone.value = false;
  results.value = [];
  clearSelection();

  try {
    const f = form.value;
    const cleanedIsbn = f.isbn.trim() ? isbnUtil.normalize(f.isbn.trim()) : '';

    if (cleanedIsbn && isbnUtil.isValidFormat(cleanedIsbn)) {
      const isbn13 = cleanedIsbn.length === 10 ? isbnUtil.toIsbn13(cleanedIsbn) : cleanedIsbn;
      const res = await searchService.searchByIsbn(isbn13);
      if ((res as any)?.isOfflineUnavailable) {
        pendingScansStore.addPendingScan(isbn13);
        searchError.value = `Hors réseau : l'ISBN ${isbn13} a été mémorisé pour consultation ultérieure.`;
        return;
      }
      if (res?.mainBook) {
        const allCached = await databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]);
        results.value = annotateIntegralCoverage([res.mainBook], allCached);
        saveBookNavigationOrder([res.mainBook.uri], 'direct');
      }
      searchDone.value = true;
      return;
    }

    const resolved = await resolveHintsViaV4Backend({
      hints: {
        title: f.title.trim() || undefined,
        series: f.series.trim() || undefined,
        volumeNumber: f.volumeNumber.trim() || undefined,
        author: f.author.trim() || undefined,
        collection: f.edition.trim() || undefined,
        publisher: f.publisher.trim() || undefined
      },
      sourceChannel: 'canal_3_text_search',
      skipLocalD1: false
    });

    if (!resolved) {
      searchError.value = 'Service de recherche temporairement indisponible.';
      return;
    }

    const seen = new Set<string>();
    const books: HumanizedBook[] = [];
    const pushOption = async (opt: Canal3ResolutionOption) => {
      const code = String(opt.isbn13 || '').trim();
      if (!code || seen.has(code)) return;
      seen.add(code);
      const book = await optionToHumanizedBook(opt);
      if (book) books.push(book);
    };

    if (resolved.isbn13 && resolved.meta) {
      await pushOption({
        isbn13: resolved.isbn13,
        title: resolved.meta.title,
        authors: resolved.meta.authors || [],
        publisher: resolved.meta.publisher,
        publishDate: resolved.meta.publishDate,
        coverUrl: resolved.meta.coverUrl,
        coverFallbackUrls: resolved.meta.coverFallbackUrls,
        series: resolved.meta.series,
        seriesNumber: resolved.meta.seriesNumber,
        sourcesCount: resolved.sourcesCount || 1,
        score: 100
      });
    }
    for (const alt of resolved.alternatives || []) {
      await pushOption(alt);
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
        Renseignez un ou plusieurs champs pour rechercher un ouvrage (BnF &amp; catalogue) :
      </p>

      <div class="text-search-grid">
        <label class="ds-field">
          <span>Nom / Titre</span>
          <input v-model="form.title" type="text" class="ds-input" placeholder="Ex: Le Secret de la Licorne" />
        </label>
        <label class="ds-field">
          <span>Série</span>
          <input v-model="form.series" type="text" class="ds-input" placeholder="Ex: Tintin" />
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
          <input v-model="form.edition" type="text" class="ds-input" placeholder="Ex: Collector, Intégrale..." />
        </label>
        <label class="ds-field">
          <span>Éditeur</span>
          <input v-model="form.publisher" type="text" class="ds-input" placeholder="Ex: Casterman, Dargaud..." />
        </label>
        <label class="ds-field">
          <span>ISBN</span>
          <input v-model="form.isbn" type="text" class="ds-input" placeholder="Ex: 9782203001107" />
        </label>
      </div>

      <div class="ds-actions-row form-actions">
        <button type="submit" class="wireframe-btn primary" :disabled="isSearching || !hasCriteria">
          {{ isSearching ? 'Recherche en cours...' : 'Rechercher' }}
        </button>
        <button type="button" class="wireframe-btn" :disabled="isSearching" @click="resetForm">
          Effacer
        </button>
      </div>

      <div v-if="searchError || batchError" class="ds-banner ds-banner-error feedback-gap">
        {{ searchError || batchError }}
      </div>
      <div v-if="feedbackMessage" class="ds-banner ds-banner-success feedback-gap">
        {{ feedbackMessage }}
      </div>
    </form>

    <div v-if="searchDone && results.length === 0" class="ds-card">
      <p class="search-hint" style="margin: 0;">
        Aucun résultat trouvé pour ces critères. Essayez de simplifier le titre ou de retirer un filtre.
      </p>
    </div>

    <div v-if="results.length > 0" class="ds-card">
      <div class="ds-section-header">
        <label class="select-all-row">
          <input
            type="checkbox"
            class="wireframe-checkbox"
            :checked="isAllSelected"
            @change="toggleAll(($event.target as HTMLInputElement).checked)"
          />
          <span>
            {{ selectedUris.length === 0 ? `Tout cocher (${results.length})` : `${selectedUris.length} sélectionné(s)` }}
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
        >
          <template #extra>
            <button type="button" class="ds-pill-btn" @click="toggleIntegralEditor(livre)">
              {{ livre.isIntegral ? 'Modifier intégrale' : 'Déclarer intégrale' }}
            </button>
            <div v-if="editingIntegralUri === livre.uri" class="inline-integral-panel">
              <IntegralConfigFields
                v-model:is-integral="integralFlag"
                v-model:included-volumes-text="integralVolsText"
                :compact="true"
                :disabled="integralSaving"
                :input-id="`search-int-${livre.uri}`"
              />
              <div class="ds-actions-row">
                <button
                  type="button"
                  class="wireframe-btn primary"
                  :disabled="integralSaving"
                  @click="applyIntegralEditor(livre)"
                >
                  Valider
                </button>
                <button
                  type="button"
                  class="wireframe-btn"
                  :disabled="integralSaving"
                  @click="editingIntegralUri = null"
                >
                  Fermer
                </button>
              </div>
            </div>
          </template>
        </BookMiniCard>
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

.search-hint {
  margin: 0 0 0.65rem;
  font-size: 0.86rem;
  color: var(--color-text-muted);
}

.text-search-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
  gap: 0.5rem;
}

.form-actions {
  margin-top: 0.75rem;
}

.feedback-gap {
  margin-top: 0.65rem;
}

.select-all-row {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.86rem;
  font-weight: 700;
  cursor: pointer;
}

.inline-integral-panel {
  margin-top: 0.45rem;
  padding: 0.55rem;
  background: var(--color-bg-alt);
  border: var(--border-width) solid var(--color-border-hover);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
</style>
