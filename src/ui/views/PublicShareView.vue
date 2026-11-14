<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

const isLoading = ref(true);
const errorMsg = ref('');
const libraryName = ref('Bibliothèque partagée');
const items = ref<Array<Record<string, any>>>([]);
const filterText = ref('');
const filterCategory = ref('ALL');

onMounted(async () => {
  const token = String(route.params.token || '').trim();
  if (!token) {
    errorMsg.value = 'Jeton de partage manquant.';
    isLoading.value = false;
    return;
  }
  try {
    const res = await fetch(`/api/gateway?action=public-share-get&token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) {
      errorMsg.value = data.error || 'Lien de partage introuvable.';
    } else {
      libraryName.value = data.libraryName || 'Bibliothèque partagée';
      items.value = data.items || [];
    }
  } catch {
    errorMsg.value = 'Impossible de charger la bibliothèque partagée.';
  } finally {
    isLoading.value = false;
  }
});

const filteredItems = computed(() => {
  const q = filterText.value.toLowerCase().trim();
  return items.value.filter((item) => {
    if (filterCategory.value !== 'ALL' && item.main_category !== filterCategory.value) {
      return false;
    }
    if (!q) return true;
    return String(item.title || '').toLowerCase().includes(q);
  });
});
</script>

<template>
  <div class="shared-view-container">
    <div class="shared-header">
      <div>
        <h2>📚 {{ libraryName }} (Lecture seule)</h2>
        <p>{{ items.length }} ouvrage(s) partagé(s)</p>
      </div>
      <button type="button" class="nav-btn" @click="router.push('/login')">
        Ouvrir mon application
      </button>
    </div>

    <div class="shared-filters">
      <input
        v-model="filterText"
        placeholder="Rechercher un titre dans cette collection..."
        class="search-input"
      />
      <select v-model="filterCategory" class="cat-select">
        <option value="ALL">Toutes catégories</option>
        <option value="BD">BD</option>
        <option value="Manga">Manga</option>
        <option value="Comics">Comics</option>
        <option value="Roman">Roman</option>
        <option value="Essai">Essai</option>
        <option value="Jeunesse">Jeunesse</option>
      </select>
    </div>

    <div v-if="isLoading" class="status-box">Chargement de la collection...</div>
    <div v-else-if="errorMsg" class="status-box err">{{ errorMsg }}</div>
    <div v-else-if="filteredItems.length === 0" class="status-box">
      Aucun livre trouvé pour ce filtre.
    </div>

    <div v-else class="shared-grid">
      <div v-for="(item, idx) in filteredItems" :key="idx" class="shared-card">
        <div class="card-badges">
          <span class="cat-badge">{{ item.main_category || 'Livre' }}</span>
          <span v-if="item.ownership_status === 'wishlist'" class="status-badge wish">
            💙 Wishlist
          </span>
          <span v-else-if="Number(item.is_lent) > 0" class="status-badge lent">
            🟠 Déjà prêté
          </span>
          <span v-else class="status-badge avail">
            ✅ Disponible
          </span>
        </div>
        <h4 class="book-title">
          {{ item.title || item.edition_id }}
          <span v-if="item.series_number" class="vol-pill">T.{{ item.series_number }}</span>
        </h4>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shared-view-container {
  max-width: 900px;
  margin: 0 auto;
  padding: 1rem;
}

.shared-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 2px solid #000;
  background: #fff;
  padding: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.shared-header h2 {
  margin: 0 0 0.25rem;
}

.shared-header p {
  margin: 0;
  font-size: 0.85rem;
  color: #475569;
}

.nav-btn {
  border: 2px solid #000;
  background: #4f46e5;
  color: #fff;
  padding: 0.5rem 0.85rem;
  font-weight: 700;
  cursor: pointer;
}

.shared-filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.search-input {
  flex: 1;
  min-width: 220px;
  border: 2px solid #000;
  padding: 0.5rem;
}

.cat-select {
  border: 2px solid #000;
  padding: 0.5rem;
  background: #fff;
  font-weight: 700;
}

.shared-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 0.75rem;
}

.shared-card {
  border: 2px solid #000;
  background: #fff;
  padding: 0.75rem;
}

.card-badges {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.4rem;
  font-size: 0.75rem;
  font-weight: 700;
}

.cat-badge {
  background: #f1f5f9;
  border: 1px solid #000;
  padding: 0.1rem 0.4rem;
}

.status-badge {
  padding: 0.1rem 0.4rem;
  border: 1px solid #000;
}

.status-badge.avail {
  background: #dcfce7;
  color: #14532d;
}

.status-badge.lent {
  background: #ffedd5;
  color: #7c2d12;
}

.status-badge.wish {
  background: #dbeafe;
  color: #1e3a8a;
}

.book-title {
  margin: 0;
  font-size: 0.95rem;
}

.vol-pill {
  font-size: 0.8rem;
  color: #4f46e5;
  margin-left: 0.3rem;
}

.status-box {
  border: 2px solid #000;
  background: #fff;
  padding: 1.5rem;
  text-align: center;
  font-weight: 700;
}

.status-box.err {
  background: #fee2e2;
  color: #991b1b;
}
</style>
