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
import { searchService } from '../../core/orchestrators/search.orchestrator';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import {
  seriesReleaseService,
  type SeriesReleaseAlert
} from '../../core/services/series-release.service';
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
const sortMode = ref<'date_desc' | 'date_asc' | 'alpha_asc' | 'alpha_desc'>('date_desc');

onMounted(async () => {
  await seriesReleaseService.checkNewReleasesOnOpen();
});

const sortedAlerts = computed(() => {
  const list = [...alerts.value];
  const labelOf = (a: SeriesReleaseAlert) =>
    `${a.seriesTitle || ''} ${a.volumeTitle || ''}`.trim().toLowerCase();

  return list.sort((a, b) => {
    if (sortMode.value === 'date_asc') {
      return (a.detectedAt || '').localeCompare(b.detectedAt || '');
    }
    if (sortMode.value === 'alpha_asc') {
      return labelOf(a).localeCompare(labelOf(b), 'fr');
    }
    if (sortMode.value === 'alpha_desc') {
      return labelOf(b).localeCompare(labelOf(a), 'fr');
    }
    return (b.detectedAt || '').localeCompare(a.detectedAt || '');
  });
});

const releaseBooks = computed<HumanizedBook[]>(() =>
  sortedAlerts.value.map((a) => ({
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
      <select
        v-model="sortMode"
        class="wireframe-input releases-sort-select"
        aria-label="Trier les nouveautés"
      >
        <option value="date_desc">Plus récentes d’abord</option>
        <option value="date_asc">Plus anciennes d’abord</option>
        <option value="alpha_asc">Ordre alphabétique (A → Z)</option>
        <option value="alpha_desc">Ordre alphabétique (Z → A)</option>
      </select>
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
            message="Aucune nouvelle sortie détectée pour vos séries commencées."
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

.releases-tool-btn,
.releases-sort-select {
  width: auto !important;
  flex: 1 1 auto;
  min-width: 150px;
  font-size: 0.84rem;
}
</style>
