<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BookMiniCard from '../components/BookMiniCard.vue';
import SeriesMiniCard from '../components/SeriesMiniCard.vue';
import WireframeTable from '../components/WireframeTable.vue';
import WireframePagination from '../components/WireframePagination.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import LendModal from '../components/LendModal.vue';
import { TEXTS } from '../locales/fr';
import { inventaireSearchProvider } from '../../core/providers/inventaire-search.provider';
import { workUriResolver } from '../../core/resolvers/workUri.resolver';
import { databaseService } from '../../core/database/database.service';
import { entityResolver } from '../../core/resolvers/entity.resolver';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { annotateIntegralCoverage } from '../../core/bibliographic/integral.util';
import { normalizeTextKey } from '../../core/resolvers/bnf.resolver';
import { filterEligibleBooksForBatchAction } from '../../core/utils/batch-actions.util';
import { imageUtil } from '../../core/utils/image.util';
import type {
  CatalogSearchResponse,
  CatalogSearchSeriesHit
} from '../../core/services/catalog-search.service';
import type { HumanizedBook } from '../../core/types';
import { connectionState, fetchWithTimeout } from '../../state/connection';
import { sessionStore } from '../../state/session';
import { textSearchState } from '../../state/textSearchState';
import { saveBookNavigationOrder } from '../../state/bookNavigation';

const route = useRoute();
const router = useRouter();

const isLoading = ref(true);
const errorMessage = ref('');
const authorName = ref('');
const authorSeries = ref<CatalogSearchSeriesHit[]>([]);
const authorBooks = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const displayedTomes = ref<HumanizedBook[]>([]);
const filteredAuthorBooks = ref<HumanizedBook[]>([]);
const showLendModal = ref(false);

const loadAuthorProfile = async (rawAuthorParam: string) => {
  isLoading.value = true;
  errorMessage.value = '';
  authorSeries.value = [];
  authorBooks.value = [];
  selectedIds.value = [];
  displayedTomes.value = [];
  filteredAuthorBooks.value = [];

  const authorId = decodeURIComponent(rawAuthorParam || '').trim();
  if (!authorId) {
    errorMessage.value = TEXTS.authorView.errorFetch;
    isLoading.value = false;
    return;
  }

  try {
    const isEntityUri = /^(?:wd|inv):/i.test(authorId);
    if (isEntityUri && !connectionState.isOffline.value) {
      const authorRes = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(authorId)}`).catch(() => null);
      if (authorRes?.ok) {
        const authorData = await authorRes.json().catch(() => null);
        const entity = authorData?.entities?.[authorId];
        authorName.value = entity?.label || entity?.labels?.fr || entity?.labels?.en || authorId;
      } else {
        authorName.value = authorId;
      }
    } else {
      authorName.value = authorId;
    }

    // 1. Collecter tous les livres locaux correspondant à cet auteur (rapide + offline-ready)
    const allCached = await databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]);
    const loans = await databaseService.getAllLoans().catch(() => []);
    const loanByUri = new Map(loans.map((l) => [l.uri, l]));
    const normAuthor = normalizeTextKey(authorName.value);

    const bookMap = new Map<string, HumanizedBook>();
    const seriesMap = new Map<string, CatalogSearchSeriesHit>();

    for (const b of allCached) {
      const people = [...(b.authors || []), ...(b.scriptwriters || []), ...(b.illustrators || [])];
      const matches = people.some((p) => {
        const np = normalizeTextKey(p);
        return np === normAuthor || np.includes(normAuthor) || normAuthor.includes(np);
      });
      if (!matches) continue;
      const copy: HumanizedBook = { ...b, loan: loanByUri.get(b.uri) || b.loan };
      bookMap.set(copy.uri, copy);
      if (copy.series) {
        const sKey = normalizeTextKey(copy.series);
        const existingS = seriesMap.get(sKey);
        if (existingS) {
          existingS.volumesCount++;
          if (copy.ownershipStatus === 'owned') existingS.ownedCount++;
          if (!existingS.coverUrl) existingS.coverUrl = imageUtil.resolveCoverUrl(copy);
        } else {
          seriesMap.set(sKey, {
            id: copy.seriesId || `search-series:${encodeURIComponent(copy.series)}`,
            name: copy.series,
            coreKey: sKey,
            authors: [authorName.value],
            coverUrl: imageUtil.resolveCoverUrl(copy),
            volumesCount: 1,
            ownedCount: copy.ownershipStatus === 'owned' ? 1 : 0,
            source: 'local',
            isMaterializedInLocal: Boolean(copy.seriesId)
          });
        }
      }
    }

    // 2. Recherche catalogue serveur exhaustive (Séries + Livres BnF/SQLite) pour cet auteur
    if (!connectionState.isOffline.value && authorName.value) {
      const savedUri = sessionStore.getUserUri() || undefined;
      const res = await fetchWithTimeout('/api/v2/books/search-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: authorName.value, userUri: savedUri }),
        timeout: 15000
      }).catch(() => null);

      if (res?.ok) {
        const data = (await res.json()) as CatalogSearchResponse;
        for (const s of data.series || []) {
          const existing = seriesMap.get(s.coreKey) || seriesMap.get(normalizeTextKey(s.name));
          if (!existing) {
            seriesMap.set(s.coreKey, s);
          } else {
            if (s.isMaterializedInLocal && !existing.isMaterializedInLocal) {
              existing.id = s.id;
              existing.isMaterializedInLocal = true;
            }
            if (!existing.coverUrl && s.coverUrl) existing.coverUrl = s.coverUrl;
          }
        }
        for (const hit of data.books || []) {
          if (bookMap.has(hit.uri)) continue;
          const cached = await databaseService.getBookFromCache(hit.uri).catch(() => null);
          const candidates = hit.coverFallbackUrls?.length
            ? hit.coverFallbackUrls
            : hit.isbn13
              ? imageUtil.buildCoverCandidates(hit.isbn13, [hit.coverUrl])
              : [];
          bookMap.set(cached?.uri || hit.uri, {
            uri: cached?.uri || hit.uri,
            bookId: cached?.bookId || hit.bookId,
            type: 'edition',
            isbn13: cached?.isbn13 || hit.isbn13,
            title: cached?.title || hit.title,
            authors: cached?.authors?.length ? cached.authors : hit.authors,
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
            loan: cached?.loan
          });
        }
      } else if (isEntityUri) {
        // Repli historique Inventaire.io uniquement si URI wd:/inv:
        const workUris = await inventaireSearchProvider.fetchAuthorWorks(authorId).catch(() => []);
        const physicalUris = await workUriResolver.resolveBulk(workUris.slice(0, 30)).catch(() => []);
        for (const uri of physicalUris) {
          if (bookMap.has(uri)) continue;
          const b = (await databaseService.getBookFromCache(uri)) || (await entityResolver.resolvePhysicalEntity(uri));
          if (b) bookMap.set(b.uri, b);
        }
      }
    }

    authorSeries.value = Array.from(seriesMap.values()).sort((a, b) => {
      if (a.ownedCount !== b.ownedCount) return b.ownedCount - a.ownedCount;
      return a.name.localeCompare(b.name, 'fr');
    });

    const mergedBooks = annotateIntegralCoverage(Array.from(bookMap.values()), allCached);
    authorBooks.value = mergedBooks;
    saveBookNavigationOrder(mergedBooks.map((b) => b.uri), 'author');
  } catch (err: unknown) {
    console.error('[AUTHOR VIEW] Erreur chargement auteur :', err);
    errorMessage.value = TEXTS.authorView.errorFetch;
  } finally {
    isLoading.value = false;
  }
};

const openSeriesHit = async (s: CatalogSearchSeriesHit) => {
  if (s.isMaterializedInLocal || s.id.startsWith('wd:') || s.id.startsWith('inv:') || s.id.startsWith('ser_')) {
    await router.push({ name: 'SeriesView', params: { id: s.id }, query: { fromMode: 'author' } });
    return;
  }
  textSearchState.form.value = {
    title: '',
    series: s.name,
    volumeNumber: '',
    author: authorName.value,
    edition: '',
    publisher: '',
    isbn: ''
  };
  await router.push({ name: 'ScanView', query: { mode: 'search' } });
};

onMounted(() => loadAuthorProfile(route.params.id as string));
watch(() => route.params.id, (newId) => {
  if (newId) void loadAuthorProfile(newId as string);
});

const isAllSelected = computed(() => {
  const targets = filteredAuthorBooks.value.length > 0 ? filteredAuthorBooks.value : authorBooks.value;
  return targets.length > 0 && targets.every((b) => selectedIds.value.includes(b.uri));
});
const selectedBooks = computed(() => authorBooks.value.filter((b) => selectedIds.value.includes(b.uri)));
const eligibleLendBooks = computed(() => filterEligibleBooksForBatchAction(selectedBooks.value, 'LEND'));

const handleToggleAll = (checked: boolean) => {
  const targets = filteredAuthorBooks.value.length > 0 ? filteredAuthorBooks.value : authorBooks.value;
  selectedIds.value = checked ? targets.map((item) => item.uri) : [];
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE') => {
  const eligible = filterEligibleBooksForBatchAction(selectedBooks.value, action);
  if (eligible.length === 0) return;
  if (action === 'LEND') {
    showLendModal.value = true;
    return;
  }
  const eligibleSet = new Set(eligible.map((b) => b.uri));
  try {
    for (const book of eligible) {
      if (action === 'DELETE') {
        const removeAct = book.ownershipStatus === 'wish' ? 'REMOVE_WISHLIST' : 'REMOVE_INVENTORY';
        await queueService.enqueueAction(removeAct, book.uri);
      } else {
        await queueService.enqueueAction(action, book.uri);
      }
    }
    authorBooks.value = authorBooks.value.map((book) => {
      if (eligibleSet.has(book.uri)) {
        if (action === 'RETURN') {
          const { loan, ...rest } = book;
          return rest;
        }
        if (action === 'DELETE') {
          const { loan, ...rest } = book;
          return { ...rest, ownershipStatus: 'none' as const };
        }
        return { ...book, ownershipStatus: action === 'ADD_INVENTORY' ? 'owned' : 'wish' };
      }
      return book;
    });
    selectedIds.value = [];
  } catch (error) {
    console.error("[AUTHOR VIEW] Échec de l'action groupée :", error);
  }
};

const confirmGroupLend = async (friendName: string) => {
  const eligible = eligibleLendBooks.value;
  const eligibleSet = new Set(eligible.map((b) => b.uri));
  try {
    for (const book of eligible) {
      await queueService.enqueueAction('LEND', book.uri, { friendName });
    }
    authorBooks.value = authorBooks.value.map((book) =>
      eligibleSet.has(book.uri) ? { ...book, loan: { uri: book.uri, friendName, loanDate: Date.now() } } : book
    );
    selectedIds.value = [];
  } catch (error) {
    console.error('[AUTHOR VIEW] Échec du prêt groupé :', error);
  } finally {
    showLendModal.value = false;
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle :text="authorName || TEXTS.authorView.title" level="h2" />

    <BaseLoading v-if="isLoading" />

    <div v-else class="main-content-wrapper">
      <BaseBanner v-if="errorMessage" type="error" :message="errorMessage" />

      <BaseBanner
        v-if="!authorSeries.length && !authorBooks.length && !errorMessage"
        type="error"
        :message="TEXTS.authorView.emptyWorks"
      />

      <!-- SECTION 1 : SÉRIES DE L'AUTEUR -->
      <div v-if="authorSeries.length" class="semantic-bucket-section" style="margin-bottom: 1.25rem;">
        <div class="wishlist-section-header">Séries ({{ authorSeries.length }})</div>
        <WireframeTable>
          <SeriesMiniCard
            v-for="saga in authorSeries"
            :key="saga.id"
            :name="saga.name"
            :owned-count="saga.ownedCount"
            :cover-url="saga.coverUrl ? imageUtil.resolveExternalUrl(saga.coverUrl) : undefined"
            @click="openSeriesHit(saga)"
          />
        </WireframeTable>
      </div>

      <!-- SECTION 2 : ŒUVRES & ALBUMS -->
      <div v-if="authorBooks.length" class="semantic-bucket-section">
        <div class="wishlist-section-header">{{ TEXTS.authorView.sectionWorks }} ({{ authorBooks.length }})</div>

        <WireframePagination
          :items="authorBooks"
          :searchKeys="['title', 'series']"
          :hasSelectAll="true"
          :selectAllValue="isAllSelected"
          :selectedCount="selectedIds.length"
          @update:selectAllValue="handleToggleAll"
          @update:filteredItems="(val) => { filteredAuthorBooks = val; saveBookNavigationOrder(val.map((b: HumanizedBook) => b.uri), 'author'); }"
          @update:processedItems="(val) => displayedTomes = val"
        >
          <div v-if="displayedTomes.length === 0">
            <BaseBanner type="error" :message="TEXTS.collectionView?.emptyCollection" />
          </div>

          <WireframeTable v-else>
            <BookMiniCard
              v-for="livre in displayedTomes"
              :key="livre.uri"
              :book="livre"
              :model-value="selectedIds.includes(livre.uri)"
              @update:model-value="(val) => {
                if (val) {
                  if (!selectedIds.includes(livre.uri)) selectedIds.push(livre.uri);
                } else {
                  const idx = selectedIds.indexOf(livre.uri);
                  if (idx > -1) selectedIds.splice(idx, 1);
                }
              }"
            />
          </WireframeTable>

          <BatchActionBar
            :selected-count="selectedIds.length"
            :selected-books="selectedBooks"
            @execute="dispatchBatchAction"
            @clear="selectedIds = []"
          />
        </WireframePagination>
      </div>
    </div>

    <LendModal
      :show="showLendModal"
      :bookCount="eligibleLendBooks.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />
  </div>
</template>
