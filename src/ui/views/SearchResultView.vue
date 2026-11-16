<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import SmartSearchBar from '../components/SmartSearchBar.vue';
import { TEXTS } from '../locales/fr';
import { workUriResolver } from '../../core/resolvers/workUri.resolver';
import { imageUtil } from '../../core/utils/image.util';
import { connectionState } from '../../state/connection';
import { saveBookNavigationOrder } from '../../state/bookNavigation';
import {
  keywordSearchService,
  type GroupedKeywordSearchResult,
  type KeywordBookEntry,
  type KeywordSeriesGroup,
  type KeywordAuthorEntry
} from '../../core/services/keyword-search.service';

const route = useRoute();
const router = useRouter();

const isLoading = ref(true);
const errorMessage = ref('');
const inlineQuery = ref(String(route.query.q || ''));
const selectedCategory = ref<string>('ALL');
const selectedSection = ref<'ALL' | 'series' | 'volumes' | 'standalone' | 'authors'>('ALL');
const expandedSeriesKeys = ref<Record<string, boolean>>({});
const showAllCategories = ref(false);
const MAX_VISIBLE_CATEGORIES = 8;

const visibleCategories = computed(() =>
  showAllCategories.value ? grouped.value.categories : grouped.value.categories.slice(0, MAX_VISIBLE_CATEGORIES)
);

const grouped = ref<GroupedKeywordSearchResult>({
  categories: [],
  series: [],
  volumes: [],
  standaloneWorks: [],
  authors: []
});

const executeSemanticSearch = async () => {
  const query = String(route.query.q || '').trim();
  inlineQuery.value = query;
  if (!query) {
    errorMessage.value = TEXTS.searchResults.errorEmptyQuery;
    isLoading.value = false;
    return;
  }

  isLoading.value = true;
  errorMessage.value = '';
  selectedCategory.value = 'ALL';
  selectedSection.value = 'ALL';
  expandedSeriesKeys.value = {};

  try {
    grouped.value = await keywordSearchService.searchGrouped(query, connectionState.isOffline.value);
    if (grouped.value.series.length > 0) {
      // Ouvrir automatiquement la première série correspondante pour afficher immédiatement ses tomes
      expandedSeriesKeys.value[grouped.value.series[0].key] = true;
    }
  } catch (error) {
    console.error('[SEARCH RESULT VIEW] Échec de la recherche multi-sources :', error);
    errorMessage.value = TEXTS.searchResults.errorFetch;
  } finally {
    isLoading.value = false;
  }
};

onMounted(async () => {
  await executeSemanticSearch();
});

watch(
  () => route.query.q,
  async () => {
    await executeSemanticSearch();
  }
);

const filteredSeries = computed(() => {
  if (selectedCategory.value === 'ALL') return grouped.value.series;
  return grouped.value.series.filter((s) => s.genres.includes(selectedCategory.value));
});

const filteredVolumes = computed(() => {
  if (selectedCategory.value === 'ALL') return grouped.value.volumes;
  return grouped.value.volumes.filter((v) => v.genres.includes(selectedCategory.value));
});

const filteredStandalone = computed(() => {
  if (selectedCategory.value === 'ALL') return grouped.value.standaloneWorks;
  return grouped.value.standaloneWorks.filter((w) => w.genres.includes(selectedCategory.value));
});

// Groupement des œuvres uniques par sous-catégorie pour un affichage ordonné
const standaloneByCategory = computed(() => {
  const map = new Map<string, KeywordBookEntry[]>();
  for (const w of filteredStandalone.value) {
    const cat = w.category || 'Autre';
    const list = map.get(cat) || [];
    list.push(w);
    map.set(cat, list);
  }
  return Array.from(map.entries()).map(([category, items]) => ({ category, items }));
});

const hasAnyResult = computed(
  () =>
    grouped.value.series.length > 0 ||
    grouped.value.volumes.length > 0 ||
    grouped.value.standaloneWorks.length > 0 ||
    grouped.value.authors.length > 0
);

function handleInlineKeywords(q: string) {
  if (q.trim()) {
    router.push({ name: 'SearchResultView', query: { q: q.trim() } });
  }
}

function handleInlineIsbn(isbn: string) {
  saveBookNavigationOrder([isbn, `isbn:${isbn}`], 'direct');
  router.push(`/book/${encodeURIComponent(isbn)}`);
}

function toggleSeriesExpand(key: string) {
  expandedSeriesKeys.value = {
    ...expandedSeriesKeys.value,
    [key]: !expandedSeriesKeys.value[key]
  };
}

const handleSelectSeries = (series: KeywordSeriesGroup) => {
  if (series.uri && !series.uri.startsWith('local:')) {
    router.push({ name: 'SeriesView', params: { id: series.uri } });
  } else {
    toggleSeriesExpand(series.key);
  }
};

const handleSelectAuthor = (author: KeywordAuthorEntry) => {
  if (author.uri) {
    router.push({ name: 'AuthorView', params: { id: author.uri } });
  } else {
    router.push({ name: 'SearchResultView', query: { q: author.name } });
  }
};

const handleSelectBook = async (entry: KeywordBookEntry) => {
  if (entry.isbn13) {
    saveBookNavigationOrder([entry.isbn13, `isbn:${entry.isbn13}`], 'direct');
    router.push(`/book/${encodeURIComponent(entry.isbn13)}`);
    return;
  }
  if (!entry.uri) return;

  if (connectionState.isOffline.value) {
    saveBookNavigationOrder([entry.uri], 'direct');
    router.push(`/book/${encodeURIComponent(entry.uri)}`);
    return;
  }

  isLoading.value = true;
  try {
    const isbn = await workUriResolver.resolveIsbnFromWorkUri(entry.uri);
    if (isbn) {
      saveBookNavigationOrder([isbn, `isbn:${isbn}`], 'direct');
      router.push(`/book/${encodeURIComponent(isbn)}`);
    } else {
      saveBookNavigationOrder([entry.uri], 'direct');
      router.push(`/book/${encodeURIComponent(entry.uri)}`);
    }
  } catch {
    alert(TEXTS.searchResults.errorPivot);
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle :text="TEXTS.searchResults.title" level="h2" />

    <div style="margin-bottom: 0.75rem;">
      <SmartSearchBar
        v-model="inlineQuery"
        @isbn-detected="handleInlineIsbn"
        @keywords-detected="handleInlineKeywords"
      />
    </div>

    <BaseLoading v-if="isLoading" />

    <div v-else class="main-content-wrapper">
      <BaseBanner v-if="errorMessage" type="error" :message="errorMessage" />

      <BaseBanner
        v-if="!hasAnyResult && !errorMessage"
        type="error"
        :message="TEXTS.searchResults.emptyResults"
      />

      <template v-if="hasAnyResult">
        <!-- Filtres ordonnés par Type & Sous-catégorie / Genre -->
        <div class="search-filters-panel">
          <div class="filter-pills-row">
            <button
              type="button"
              class="filter-pill"
              :class="{ active: selectedSection === 'ALL' }"
              @click="selectedSection = 'ALL'"
            >
              Tout voir
            </button>
            <button
              v-if="grouped.series.length"
              type="button"
              class="filter-pill"
              :class="{ active: selectedSection === 'series' }"
              @click="selectedSection = 'series'"
            >
              Séries ({{ filteredSeries.length }})
            </button>
            <button
              v-if="grouped.volumes.length"
              type="button"
              class="filter-pill"
              :class="{ active: selectedSection === 'volumes' }"
              @click="selectedSection = 'volumes'"
            >
              Tomes ({{ filteredVolumes.length }})
            </button>
            <button
              v-if="grouped.standaloneWorks.length"
              type="button"
              class="filter-pill"
              :class="{ active: selectedSection === 'standalone' }"
              @click="selectedSection = 'standalone'"
            >
              Œuvres uniques ({{ filteredStandalone.length }})
            </button>
            <button
              v-if="grouped.authors.length"
              type="button"
              class="filter-pill"
              :class="{ active: selectedSection === 'authors' }"
              @click="selectedSection = 'authors'"
            >
              Auteurs ({{ grouped.authors.length }})
            </button>
          </div>

          <div v-if="grouped.categories.length > 0" class="filter-pills-row subcat-row">
            <span class="subcat-label">Sous-catégorie :</span>
            <button
              type="button"
              class="filter-pill sub"
              :class="{ active: selectedCategory === 'ALL' }"
              @click="selectedCategory = 'ALL'"
            >
              Toutes
            </button>
            <button
              v-for="cat in visibleCategories"
              :key="cat.label"
              type="button"
              class="filter-pill sub"
              :class="{ active: selectedCategory === cat.label }"
              @click="selectedCategory = cat.label"
            >
              {{ cat.label }} ({{ cat.count }})
            </button>
            <button
              v-if="grouped.categories.length > MAX_VISIBLE_CATEGORIES"
              type="button"
              class="filter-pill sub"
              @click="showAllCategories = !showAllCategories"
            >
              {{ showAllCategories ? 'Réduire' : `+${grouped.categories.length - MAX_VISIBLE_CATEGORIES} autres` }}
            </button>
          </div>
        </div>

        <!-- 1. SÉRIES -->
        <div
          v-if="(selectedSection === 'ALL' || selectedSection === 'series') && filteredSeries.length"
          class="semantic-bucket-section"
        >
          <div class="wishlist-section-header">
            Séries ({{ filteredSeries.length }})
          </div>
          <div class="wireframe-table-container">
            <div v-for="series in filteredSeries" :key="series.key" class="series-result-block">
              <div class="mini-card-row card-row-clickable" @click="handleSelectSeries(series)">
                <div class="row-cover-container row-macaron-container">
                  <span class="row-macaron-label">SÉRIE</span>
                </div>
                <div class="row-info-content">
                  <p class="row-title">
                    {{ series.name }}
                    <span class="mini-tag">{{ series.category }}</span>
                  </p>
                  <p class="row-series-meta">
                    <span v-if="series.authors.length">{{ series.authors.join(', ') }} • </span>
                    {{ series.volumes.length }} tome(s) trouvé(s)
                  </p>
                </div>
                <button
                  v-if="series.volumes.length > 0"
                  type="button"
                  class="wireframe-btn expand-tomes-btn"
                  @click.stop="toggleSeriesExpand(series.key)"
                >
                  {{ expandedSeriesKeys[series.key] ? '▴ Masquer tomes' : '▾ Voir tomes' }}
                </button>
              </div>

              <div v-if="expandedSeriesKeys[series.key] && series.volumes.length" class="nested-tomes-list">
                <div
                  v-for="vol in series.volumes"
                  :key="vol.id"
                  class="mini-card-row card-row-clickable nested-vol"
                  @click="handleSelectBook(vol)"
                >
                  <img
                    v-if="vol.coverUrl"
                    :src="imageUtil.resolveCoverUrl(vol.coverUrl)"
                    :alt="vol.title"
                    class="search-thumb"
                    @error="imageUtil.advanceCoverFallback(vol)"
                  />
                  <div v-else class="search-thumb-fallback">—</div>
                  <div class="row-info-content">
                    <p class="row-title">
                      <strong v-if="vol.seriesNumber">T.{{ vol.seriesNumber }} — </strong>
                      {{ vol.title }}
                    </p>
                    <p class="row-series-meta">
                      {{ vol.authors.join(', ') || 'Auteur inconnu' }}
                      <template v-if="vol.publisher"> • {{ vol.publisher }}</template>
                      <template v-if="vol.publishDate"> ({{ vol.publishDate }})</template>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 2. TOMES DE SÉRIES (ORDONNÉS PAR SÉRIE & NUMÉRO) -->
        <div
          v-if="(selectedSection === 'ALL' || selectedSection === 'volumes') && filteredVolumes.length"
          class="semantic-bucket-section"
        >
          <div class="wishlist-section-header">
            Tomes ({{ filteredVolumes.length }})
          </div>
          <div class="wireframe-table-container">
            <div
              v-for="vol in filteredVolumes"
              :key="vol.id"
              class="mini-card-row card-row-clickable"
              @click="handleSelectBook(vol)"
            >
              <img
                v-if="vol.coverUrl"
                :src="imageUtil.resolveCoverUrl(vol.coverUrl)"
                :alt="vol.title"
                class="search-thumb"
                @error="imageUtil.advanceCoverFallback(vol)"
              />
              <div v-else class="search-thumb-fallback">—</div>
              <div class="row-info-content">
                <p class="row-title">
                  <span class="mini-tag">{{ vol.series }}<template v-if="vol.seriesNumber"> T.{{ vol.seriesNumber }}</template></span>
                  {{ vol.title }}
                </p>
                <p class="row-series-meta">
                  {{ vol.authors.join(', ') || 'Auteur inconnu' }}
                  <template v-if="vol.publisher"> • {{ vol.publisher }}</template>
                  <template v-if="vol.publishDate"> ({{ vol.publishDate }})</template>
                </p>
                <div class="badges-inline">
                  <span v-for="g in vol.genres.slice(0, 3)" :key="g" class="genre-pill">{{ g }}</span>
                  <span v-for="src in vol.sources" :key="src" class="source-pill">{{ src }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 3. ŒUVRES UNIQUES (CLASSÉES PAR SOUS-CATÉGORIE) -->
        <div
          v-if="(selectedSection === 'ALL' || selectedSection === 'standalone') && standaloneByCategory.length"
          class="semantic-bucket-section"
        >
          <div class="wishlist-section-header">
            Œuvres uniques par sous-catégorie ({{ filteredStandalone.length }})
          </div>
          <div v-for="group in standaloneByCategory" :key="group.category" class="subcat-group-box">
            <div class="subcat-group-title">{{ group.category }} ({{ group.items.length }})</div>
            <div class="wireframe-table-container">
              <div
                v-for="work in group.items"
                :key="work.id"
                class="mini-card-row card-row-clickable"
                @click="handleSelectBook(work)"
              >
                <img
                  v-if="work.coverUrl"
                  :src="imageUtil.resolveCoverUrl(work.coverUrl)"
                  :alt="work.title"
                  class="search-thumb"
                  @error="imageUtil.advanceCoverFallback(work)"
                />
                <div v-else class="search-thumb-fallback">—</div>
                <div class="row-info-content">
                  <p class="row-title">{{ work.title }}</p>
                  <p class="row-series-meta">
                    {{ work.authors.join(', ') || 'Auteur inconnu' }}
                    <template v-if="work.publisher"> • {{ work.publisher }}</template>
                    <template v-if="work.publishDate"> ({{ work.publishDate }})</template>
                  </p>
                  <div class="badges-inline">
                    <span v-for="g in work.genres.slice(0, 4)" :key="g" class="genre-pill">{{ g }}</span>
                    <span v-for="src in work.sources" :key="src" class="source-pill">{{ src }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 4. AUTEURS -->
        <div
          v-if="(selectedSection === 'ALL' || selectedSection === 'authors') && grouped.authors.length"
          class="semantic-bucket-section"
        >
          <div class="wishlist-section-header">
            Auteurs ({{ grouped.authors.length }})
          </div>
          <div class="wireframe-table-container">
            <div
              v-for="author in grouped.authors"
              :key="author.key"
              class="mini-card-row card-row-clickable"
              @click="handleSelectAuthor(author)"
            >
              <div class="row-cover-container row-macaron-container">
                <span class="row-macaron-label">{{ TEXTS.searchResults.badgeAuthor }}</span>
              </div>
              <div class="row-info-content">
                <p class="row-title">{{ author.name }}</p>
                <p class="row-series-meta">
                  {{ author.description || `${author.matchCount} notice(s) trouvée(s)` }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.search-filters-panel {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  background: var(--color-bg-alt, #f8fafc);
  padding: 0.75rem;
  margin-bottom: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  box-shadow: var(--shadow-sm);
}

.filter-pills-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}

.subcat-label {
  font-size: 0.75rem;
  font-weight: 700;
  color: #475569;
  text-transform: uppercase;
}

.filter-pill {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 9999px;
  background: #ffffff;
  color: #0f172a;
  padding: 0.3rem 0.7rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.filter-pill.active {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #ffffff;
}

.filter-pill.sub {
  border-color: #64748b;
  font-size: 0.74rem;
}

.filter-pill.sub.active {
  background: #4338ca;
  border-color: #4338ca;
  color: #ffffff;
}

.series-result-block {
  border-bottom: 1px solid #cbd5e1;
}

.expand-tomes-btn {
  width: auto;
  padding: 0.25rem 0.55rem;
  font-size: 0.74rem;
  flex-shrink: 0;
}

.nested-tomes-list {
  padding-left: 1rem;
  background: #f8fafc;
  border-top: 1px dashed #cbd5e1;
}

.nested-vol {
  padding-top: 0.35rem;
  padding-bottom: 0.35rem;
}

.search-thumb {
  width: 38px;
  height: 54px;
  object-fit: cover;
  border: 1px solid #94a3b8;
  flex-shrink: 0;
}

.search-thumb-fallback {
  width: 38px;
  height: 54px;
  background: #e2e8f0;
  border: 1px solid #94a3b8;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  flex-shrink: 0;
}

.mini-tag {
  display: inline-block;
  background: #e0e7ff;
  color: #3730a3;
  font-size: 0.72rem;
  font-weight: 800;
  padding: 1px 6px;
  margin-right: 4px;
}

.badges-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.25rem;
}

.genre-pill {
  background: #dcfce7;
  color: #166534;
  font-size: 0.68rem;
  font-weight: 800;
  padding: 1px 5px;
}

.source-pill {
  background: #f1f5f9;
  color: #475569;
  border: 1px solid #cbd5e1;
  font-size: 0.66rem;
  font-weight: 700;
  padding: 1px 5px;
}

.subcat-group-box {
  margin-bottom: 0.75rem;
}

.subcat-group-title {
  background: #e2e8f0;
  color: #0f172a;
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
  padding: 0.3rem 0.55rem;
  border: 1.5px solid #0f172a;
  border-bottom: none;
}
</style>