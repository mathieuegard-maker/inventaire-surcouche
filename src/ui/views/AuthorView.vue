<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BookMiniCard from '../components/BookMiniCard.vue';
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
import type { HumanizedBook } from '../../core/types';
import { entityHumanizer } from '../../core/resolvers/humanizer';

const route = useRoute();
const router = useRouter();

const isLoading = ref(true);
const errorMessage = ref('');
const authorName = ref('');
const authorBooks = ref<HumanizedBook[]>([]);
const selectedIds = ref<string[]>([]);
const displayedTomes = ref<HumanizedBook[]>([]);
const showLendModal = ref(false);

const checkAndTriggerRehumanize = (currentBook: HumanizedBook) => {
  const needsHumanization = (currentBook.series && currentBook.series.startsWith('wd:')) ||
                            (currentBook.authors && currentBook.authors.some(a => a.startsWith('wd:'))) ||
                            (currentBook.publisher && currentBook.publisher.startsWith('wd:')) ||
                            (currentBook.genres && currentBook.genres.some(g => g.startsWith('wd:'))) ||
                            (currentBook.collection && currentBook.collection.startsWith('wd:'));
  if (needsHumanization) {
    console.log(`[AUTHOR VIEW] Livre partiellement humanisé détecté (${currentBook.uri}). Ré-humanisation à la volée...`);
    entityHumanizer.rehumanize(currentBook).then((updated) => {
      if (updated) {
        const idx = authorBooks.value.findIndex(b => b.uri === currentBook.uri);
        if (idx !== -1) {
          authorBooks.value[idx] = { 
            ...updated, 
            ownershipStatus: authorBooks.value[idx].ownershipStatus, 
            loan: authorBooks.value[idx].loan 
          };
        }
      }
    });
  }
};

onMounted(async () => {
  const authorId = route.params.id as string;
  if (!authorId) {
    errorMessage.value = TEXTS.authorView.errorFetch;
    isLoading.value = false;
    return;
  }

  try {
    const authorRes = await fetch(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(authorId)}`);
    if (authorRes.ok) {
      const authorData = await authorRes.json();
      const entity = authorData.entities?.[authorId];
      authorName.value = entity?.label || entity?.labels?.fr || entity?.labels?.en || authorId;
    } else {
      authorName.value = authorId;
    }

    const workUris = await inventaireSearchProvider.fetchAuthorWorks(authorId);
    if (workUris.length === 0) {
      isLoading.value = false;
      return;
    }

    // 3. Résolution groupée en URIs physiques
    const physicalUris = await workUriResolver.resolveBulk(workUris);

    // 4. Résolution complète en HumanizedBook (avec cache-first)
    const fetchedBooks: HumanizedBook[] = [];
    const CHUNK_SIZE = 10;

    for (let i = 0; i < physicalUris.length; i += CHUNK_SIZE) {
      const chunk = physicalUris.slice(i, i + CHUNK_SIZE);
      const chunkBooks = await Promise.all(
        chunk.map(async (uri) => {
          try {
            let book = await databaseService.getBookFromCache(uri);
            if (!book) {
              book = await entityResolver.resolvePhysicalEntity(uri);
              if (book) {
                await databaseService.saveBookToCache(book);
              }
            }
            if (book) {
              // Couplage dynamique avec l'état local (possession, souhaits, prêt)
              const isInInventory = await databaseService.isUriInRegistry('inventory', book.uri) ||
                                    (book.workUri ? await databaseService.isUriInRegistry('inventory', book.workUri) : false);
              if (isInInventory) {
                book.ownershipStatus = 'owned';
                const activeLoan = await databaseService.getLoan(book.uri);
                if (activeLoan) {
                  book.loan = activeLoan;
                }
              } else {
                const isInWishlist = await databaseService.isUriInRegistry('wishlist', book.uri) ||
                                     (book.workUri ? await databaseService.isUriInRegistry('wishlist', book.workUri) : false);
                if (isInWishlist) {
                  book.ownershipStatus = 'wish';
                } else {
                  book.ownershipStatus = 'none';
                }
              }
              checkAndTriggerRehumanize(book);
            }
            return book;
          } catch (e) {
            console.error(`[AUTHOR VIEW] Erreur de résolution pour ${uri} :`, e);
            return null;
          }
        })
      );
      fetchedBooks.push(...(chunkBooks.filter((b): b is HumanizedBook => !!b)));
    }

    authorBooks.value = fetchedBooks;
  } catch (error) {
    console.error('[AUTHOR VIEW] Échec du chargement du profil de l\'auteur :', error);
    errorMessage.value = TEXTS.authorView.errorFetch;
  } finally {
    isLoading.value = false;
  }
});

// Méthodes d'interaction
const isAllSelected = computed(() => authorBooks.value.length > 0 && selectedIds.value.length === authorBooks.value.length);
const selectedBooks = computed(() => authorBooks.value.filter(book => selectedIds.value.includes(book.uri)));
const hasLentSelected = computed(() => selectedBooks.value.some(book => !!book.loan));
const hasAvailableOwnedSelected = computed(() => selectedBooks.value.some(book => book.ownershipStatus === 'owned' && !book.loan));
const hasUnownedSelected = computed(() => selectedBooks.value.some(book => book.ownershipStatus !== 'owned'));

const isSelectionMixed = computed(() => {
  let categories = 0;
  if (hasUnownedSelected.value) categories++;
  if (hasAvailableOwnedSelected.value) categories++;
  if (hasLentSelected.value) categories++;
  return categories > 1;
});

const batchContext = computed(() => {
  if (hasUnownedSelected.value) return 'unowned';
  if (hasLentSelected.value) return 'lent';
  return 'owned';
});

const handleToggleAll = (checked: boolean) => {
  selectedIds.value = checked ? authorBooks.value.map(item => item.uri) : [];
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN') => {
  if (selectedIds.value.length === 0 || isSelectionMixed.value) return;
  if (action === 'LEND') {
    showLendModal.value = true;
    return;
  }
  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction(action, uri);
    }
    authorBooks.value = authorBooks.value.map(book => {
      if (selectedIds.value.includes(book.uri)) {
        if (action === 'RETURN') {
          const copy = { ...book };
          delete copy.loan;
          return copy;
        }
        return { ...book, ownershipStatus: action === 'ADD_INVENTORY' ? 'owned' : 'wish' };
      }
      return book;
    });
    selectedIds.value = [];
  } catch (error) {
    console.error('[AUTHOR VIEW] Échec de l\'action groupée :', error);
  }
};

const confirmGroupLend = async (friendName: string) => {
  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction('LEND', uri, { friendName });
    }
    authorBooks.value = authorBooks.value.map(book => {
      if (selectedIds.value.includes(book.uri)) {
        return { ...book, loan: { uri: book.uri, friendName, loanDate: Date.now() } };
      }
      return book;
    });
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
        v-if="!authorBooks.length && !errorMessage" 
        type="error" 
        :message="TEXTS.authorView.emptyWorks" 
      />

      <div v-if="authorBooks.length" class="semantic-bucket-section">
        <div class="wishlist-section-header">{{ TEXTS.authorView.sectionWorks }}</div>
        
        <WireframePagination
          :items="authorBooks"
          :searchKeys="['title', 'series']"
          :hasSelectAll="true"
          :selectAllValue="isAllSelected"
          :selectedCount="selectedIds.length"
          @update:selectAllValue="handleToggleAll"
          @update:processedItems="(val) => displayedTomes = val"
        />

        <BatchActionBar 
          :selected-count="selectedIds.length"
          :is-mixed="isSelectionMixed"
          :context="batchContext"
          @execute="dispatchBatchAction"
        />

        <WireframeTable v-if="displayedTomes.length > 0">
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
      </div>
    </div>

    <LendModal
      :show="showLendModal"
      :bookCount="selectedIds.length"
      @close="showLendModal = false"
      @confirm="confirmGroupLend"
    />
  </div>
</template>