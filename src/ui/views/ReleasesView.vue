<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BookMiniCard from '../components/BookMiniCard.vue';
import WireframeTable from '../components/WireframeTable.vue';
import WireframePagination from '../components/WireframePagination.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import { databaseService } from '../../core/database/database.service';
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { seriesReleaseService, type SeriesReleaseAlert } from '../../core/services/series-release.service';
import { connectionState } from '../../state/connection';
import { saveBookNavigationOrder } from '../../state/bookNavigation';
import type { HumanizedBook } from '../../core/types';

const alerts = seriesReleaseService.alerts;
const isChecking = seriesReleaseService.isChecking;
const isOffline = connectionState.isOffline;

const selectedIds = ref<string[]>([]);
const displayedBooks = ref<HumanizedBook[]>([]);
const infoBanner = ref<string | null>(null);
const currentPage = ref(1);
const pageSize = ref(20);
const searchQuery = ref('');

onMounted(async () => {
  await seriesReleaseService.checkNewReleasesOnOpen();
});

const releaseBooks = computed<HumanizedBook[]>(() =>
  alerts.value.map((a) => ({
    uri: a.isbn13 ? `isbn:${a.isbn13}` : a.volumeUri,
    isbn13: a.isbn13,
    type: 'edition',
    title: a.volumeTitle,
    authors: [],
    illustrators: [],
    scriptwriters: [],
    series: a.seriesTitle,
    seriesId: a.seriesUri,
    seriesNumber: a.seriesNumber,
    coverUrl: a.coverUrl,
    genres: [],
    ownershipStatus: 'none'
  }))
);

const alertByBookUri = computed(() => {
  const map = new Map<string, SeriesReleaseAlert>();
  for (const a of alerts.value) {
    const uri = a.isbn13 ? `isbn:${a.isbn13}` : a.volumeUri;
    map.set(uri, a);
  }
  return map;
});

const selectedBooks = computed(() =>
  releaseBooks.value.filter((b) => selectedIds.value.includes(b.uri))
);

const isAllSelected = computed(
  () => releaseBooks.value.length > 0 && selectedIds.value.length === releaseBooks.value.length
);

const handleToggleAll = (checked: boolean) => {
  selectedIds.value = checked ? releaseBooks.value.map((b) => b.uri) : [];
};

const dispatchBatchAction = async (
  action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE'
) => {
  if (selectedIds.value.length === 0) return;
  infoBanner.value = null;

  const selectedAlerts = selectedIds.value
    .map((u) => alertByBookUri.value.get(u))
    .filter((a): a is SeriesReleaseAlert => Boolean(a));

  const hasDemoOnly = selectedAlerts.some((a) => a.id.startsWith('demo:'));
  if (hasDemoOnly) {
    for (const a of selectedAlerts) {
      await seriesReleaseService.dismissAlert(a.id);
    }
    selectedIds.value = [];
    infoBanner.value = `Simulation : ${selectedAlerts.length} nouveauté(s) traitée(s) (${action === 'ADD_INVENTORY' ? 'Collection' : 'Wishlist'}).`;
    return;
  }

  for (const alert of selectedAlerts) {
    let targetUri = alert.volumeUri;
    if (alert.isbn13) {
      const resolved = await searchService.searchByIsbn(alert.isbn13).catch(() => null);
      if (resolved && !('isUnknown' in resolved) && resolved.mainBook?.uri) {
        targetUri = resolved.mainBook.uri;
      }
    }
    await queueService.enqueueAction(action === 'ADD_INVENTORY' ? 'ADD_INVENTORY' : 'ADD_WISHLIST', targetUri);
    await seriesReleaseService.dismissAlert(alert.id);
  }
  selectedIds.value = [];
};

const triggerSimulation = async () => {
  infoBanner.value = null;
  const cached = await databaseService.getAllBooksFromCache().catch(() => [] as HumanizedBook[]);
  const seenSeries = new Set<string>();
  const samples: Array<{
    seriesUri?: string;
    seriesTitle?: string;
    seriesNumber?: string;
    coverUrl?: string;
    isbn13?: string;
    volumeTitle?: string;
  }> = [];

  for (const book of cached) {
    if (book.ownershipStatus === 'owned' && book.series) {
      const key = book.series.toLowerCase().trim();
      if (seenSeries.has(key)) continue;
      seenSeries.add(key);

      const sameSeries = cached.filter((b) => b.series?.toLowerCase().trim() === key);
      const maxNum = sameSeries.reduce((max, b) => {
        const n = parseInt(b.seriesNumber || '0', 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);
      const nextNum = String((maxNum || 1) + 1);

      samples.push({
        seriesUri: book.seriesId || book.series,
        seriesTitle: book.series,
        seriesNumber: nextNum,
        coverUrl: book.coverUrl,
        isbn13: book.isbn13,
        volumeTitle: `${book.series} — Tome ${nextNum} (Simulation)`
      });
      if (samples.length >= 3) break;
    }
  }

  // Compléter avec des classiques BD pour tester plusieurs lignes et la pagination
  const fallbackPool = [
    {
      seriesUri: 'demo:asterix',
      seriesTitle: 'Astérix',
      seriesNumber: '41',
      volumeTitle: 'Astérix en Lusitanie (Simulation)',
      isbn13: '9782012101524'
    },
    {
      seriesUri: 'demo:thorgal',
      seriesTitle: 'Thorgal',
      seriesNumber: '42',
      volumeTitle: 'Ozurr le Varègue (Simulation)',
      isbn13: '9782803613625'
    },
    {
      seriesUri: 'demo:blacksad',
      seriesTitle: 'Blacksad',
      seriesNumber: '8',
      volumeTitle: 'Alors, tout tombe — Partie 3 (Simulation)',
      isbn13: '9782205054194'
    },
    {
      seriesUri: 'demo:tintin',
      seriesTitle: 'Les Aventures de Tintin',
      seriesNumber: '25',
      volumeTitle: 'L’Alph-Art — Édition spéciale (Simulation)',
      isbn13: '9782203001107'
    },
    {
      seriesUri: 'demo:luckyluke',
      seriesTitle: 'Lucky Luke',
      seriesNumber: '84',
      volumeTitle: 'Un cow-boy sous pression (Simulation)',
      isbn13: '9782884714938'
    }
  ];

  for (const fallback of fallbackPool) {
    if (samples.length >= 5) break;
    if (!seenSeries.has(fallback.seriesTitle.toLowerCase())) {
      samples.push(fallback);
    }
  }

  seriesReleaseService.simulateDemoAlerts(samples);
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle text="Mes Nouveautés" level="h2" />

    <div class="releases-toolbar">
      <button
        type="button"
        class="wireframe-btn releases-tool-btn"
        :disabled="isChecking || isOffline"
        @click="seriesReleaseService.checkNewReleasesOnOpen(true)"
      >
        {{ isChecking ? 'Vérification en cours...' : 'Vérifier les sorties' }}
      </button>
      <button
        type="button"
        class="wireframe-btn releases-tool-btn"
        @click="triggerSimulation"
      >
        Simuler plusieurs sorties
      </button>
      <button
        v-if="alerts.length > 0"
        type="button"
        class="wireframe-btn releases-tool-btn"
        @click="seriesReleaseService.dismissAlert()"
      >
        Tout masquer
      </button>
    </div>

    <BaseBanner v-if="infoBanner" type="success" :message="infoBanner" />

    <BaseLoading v-if="isChecking && releaseBooks.length === 0" />

    <template v-else>
      <WireframePagination
        :items="releaseBooks"
        :searchKeys="['title', 'series']"
        :hasSelectAll="true"
        :selectAllValue="isAllSelected"
        :selectedCount="selectedIds.length"
        v-model:currentPage="currentPage"
        v-model:pageSize="pageSize"
        v-model:searchQuery="searchQuery"
        @update:selectAllValue="handleToggleAll"
        @update:filteredItems="(val) => saveBookNavigationOrder(val.map((b: HumanizedBook) => b.uri), 'releases')"
        @update:processedItems="(val) => displayedBooks = val"
      >
        <div v-if="displayedBooks.length === 0">
          <BaseBanner
            type="error"
            message="Aucune nouvelle sortie détectée pour vos séries commencées. Cliquez sur « Simuler plusieurs sorties » pour tester la mise en page."
          />
        </div>

        <WireframeTable v-else>
          <BookMiniCard
            v-for="livre in displayedBooks"
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
          context="unowned"
          @execute="dispatchBatchAction"
          @clear="selectedIds = []"
        />
      </WireframePagination>
    </template>
  </div>
</template>

<style scoped>
.releases-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: var(--spacing-md);
}

.releases-tool-btn {
  width: auto !important;
  flex: 1 1 auto;
  min-width: 150px;
  font-size: 0.84rem;
}
</style>
