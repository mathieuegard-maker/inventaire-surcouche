<template>
  <div class="shared-browser">
    <div v-if="!hideHeader" class="browser-hero">
      <div class="hero-top">
        <div>
          <span class="readonly-pill">👀 LECTURE SEULE</span>
          <h1 class="hero-title">{{ library.libraryName || 'Bibliothèque partagée' }}</h1>
          <p v-if="library.ownerName" class="hero-owner">Par {{ library.ownerName }}</p>
        </div>
        <div class="hero-counters">
          <div class="counter-box owned">
            <span class="counter-val">{{ ownedCount }}</span>
            <span class="counter-lbl">Possédés</span>
          </div>
          <div class="counter-box wishlist">
            <span class="counter-val">{{ wishlistCount }}</span>
            <span class="counter-lbl">Wishlist</span>
          </div>
        </div>
      </div>
    </div>

    <div class="browser-controls">
      <div class="filter-tabs" role="tablist">
        <button
          type="button"
          :class="['filter-tab', { active: ownershipFilter === 'all' }]"
          @click="ownershipFilter = 'all'"
        >
          Tout ({{ library.items.length }})
        </button>
        <button
          type="button"
          :class="['filter-tab', { active: ownershipFilter === 'owned' }]"
          @click="ownershipFilter = 'owned'"
        >
          📚 Possédés ({{ ownedCount }})
        </button>
        <button
          type="button"
          :class="['filter-tab', { active: ownershipFilter === 'wishlist' }]"
          @click="ownershipFilter = 'wishlist'"
        >
          🎁 Wishlist ({{ wishlistCount }})
        </button>
      </div>

      <div class="search-row">
        <input
          v-model="searchQuery"
          type="search"
          class="search-input"
          placeholder="Rechercher un titre ou une série..."
          aria-label="Rechercher dans cette bibliothèque"
        />
        <select v-if="categories.length > 1" v-model="categoryFilter" class="cat-select" aria-label="Filtrer par catégorie">
          <option value="all">Toutes catégories</option>
          <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }}</option>
        </select>
      </div>
    </div>

    <div v-if="filteredItems.length === 0" class="empty-msg">
      Aucun album ne correspond à ce filtre dans cette bibliothèque.
    </div>

    <div v-else class="items-grid">
      <article v-for="item in filteredItems" :key="item.edition_id || item.work_id || item.title || Math.random()" class="book-card">
        <div class="cover-wrap">
          <img
            v-if="item.image_url"
            :src="item.image_url"
            :alt="item.title || 'Couverture'"
            class="cover-img"
            loading="lazy"
          />
          <div v-else class="cover-fallback">📖</div>
          <span v-if="item.main_category" class="cat-badge">{{ item.main_category }}</span>
        </div>

        <div class="book-info">
          <div v-if="item.series_name || item.series_number !== null && item.series_number !== undefined" class="series-line">
            <span v-if="item.series_name" class="series-name">{{ item.series_name }}</span>
            <span v-if="item.series_number !== null && item.series_number !== undefined && item.series_number !== ''" class="tome-num">
              T.{{ item.series_number }}
            </span>
          </div>

          <h3 class="book-title">{{ item.title || 'Titre inconnu' }}</h3>

          <div class="status-row">
            <span v-if="item.ownership_status === 'wishlist'" class="status-pill wish">🎁 Wishlist</span>
            <span v-else-if="Boolean(item.is_lent)" class="status-pill lent">📤 Déjà prêté</span>
            <span v-else class="status-pill avail">✅ Disponible</span>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PublicSharePayload } from '../../core/services/user.service';

const props = withDefaults(
  defineProps<{
    library: PublicSharePayload;
    hideHeader?: boolean;
  }>(),
  {
    hideHeader: false
  }
);

const ownershipFilter = ref<'all' | 'owned' | 'wishlist'>('all');
const searchQuery = ref('');
const categoryFilter = ref('all');

const ownedCount = computed(() => props.library.items.filter((i) => i.ownership_status !== 'wishlist').length);
const wishlistCount = computed(() => props.library.items.filter((i) => i.ownership_status === 'wishlist').length);

const categories = computed(() => {
  const set = new Set<string>();
  for (const item of props.library.items) {
    if (item.main_category) set.add(item.main_category);
  }
  return Array.from(set).sort();
});

const filteredItems = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return props.library.items.filter((item) => {
    if (ownershipFilter.value === 'owned' && item.ownership_status === 'wishlist') return false;
    if (ownershipFilter.value === 'wishlist' && item.ownership_status !== 'wishlist') return false;
    if (categoryFilter.value !== 'all' && item.main_category !== categoryFilter.value) return false;
    if (q) {
      const title = (item.title || '').toLowerCase();
      const series = (item.series_name || '').toLowerCase();
      if (!title.includes(q) && !series.includes(q)) return false;
    }
    return true;
  });
});
</script>

<style scoped>
.shared-browser {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.browser-hero {
  border: 2.5px solid #111827;
  background: #ecfdf5;
  padding: 0.9rem;
  box-shadow: 4px 4px 0 #111827;
}

.hero-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
}

.readonly-pill {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 900;
  background: #059669;
  color: #fff;
  padding: 0.18rem 0.45rem;
  margin-bottom: 0.35rem;
}

.hero-title {
  margin: 0;
  font-size: 1.25rem;
  color: #064e3b;
}

.hero-owner {
  margin: 0.15rem 0 0;
  font-size: 0.84rem;
  font-weight: 700;
  color: #047857;
}

.hero-counters {
  display: flex;
  gap: 0.5rem;
}

.counter-box {
  border: 2px solid #111827;
  background: #fff;
  padding: 0.35rem 0.65rem;
  text-align: center;
  min-width: 74px;
}

.counter-val {
  display: block;
  font-size: 1.15rem;
  font-weight: 900;
  color: #111827;
}

.counter-lbl {
  font-size: 0.7rem;
  font-weight: 700;
  color: #4b5563;
}

.browser-controls {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.filter-tabs {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.filter-tab {
  border: 2px solid #111827;
  background: #fff;
  padding: 0.42rem 0.7rem;
  font-weight: 800;
  font-size: 0.82rem;
  cursor: pointer;
}

.filter-tab.active {
  background: #111827;
  color: #fff;
}

.search-row {
  display: flex;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.search-input {
  flex: 1;
  min-width: 190px;
  border: 2px solid #111827;
  padding: 0.48rem 0.65rem;
  font-size: 0.88rem;
  background: #fff;
}

.cat-select {
  border: 2px solid #111827;
  padding: 0.48rem 0.55rem;
  font-size: 0.85rem;
  font-weight: 700;
  background: #fff;
}

.empty-msg {
  border: 2px dashed #9ca3af;
  padding: 1.25rem;
  text-align: center;
  color: #4b5563;
  font-weight: 700;
}

.items-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.75rem;
}

.book-card {
  border: 2px solid #111827;
  background: #fff;
  box-shadow: 3px 3px 0 #111827;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.cover-wrap {
  position: relative;
  aspect-ratio: 3 / 4;
  background: #f3f4f6;
  border-bottom: 2px solid #111827;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-fallback {
  font-size: 2.2rem;
}

.cat-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(17, 24, 39, 0.85);
  color: #fff;
  font-size: 0.66rem;
  font-weight: 800;
  padding: 0.12rem 0.35rem;
}

.book-info {
  padding: 0.55rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  flex: 1;
}

.series-line {
  display: flex;
  justify-content: space-between;
  gap: 0.25rem;
  font-size: 0.72rem;
  font-weight: 800;
  color: #4f46e5;
}

.series-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tome-num {
  flex-shrink: 0;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  padding: 0 0.25rem;
}

.book-title {
  margin: 0;
  font-size: 0.84rem;
  line-height: 1.25;
  color: #111827;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.status-row {
  margin-top: auto;
  padding-top: 0.25rem;
}

.status-pill {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 800;
  padding: 0.15rem 0.38rem;
  border-radius: 3px;
}

.status-pill.avail {
  background: #dcfce7;
  color: #166534;
}

.status-pill.lent {
  background: #fef3c7;
  color: #92400e;
}

.status-pill.wish {
  background: #fce7f3;
  color: #9d174d;
}
</style>
