<template>
  <div class="view-container">
    <BaseHeader />

    <div class="friends-page">
      <div class="friends-header-row">
        <BaseTitle text="👥 Mes Amis &amp; Collections suivies" level="h2" />
        <button type="button" class="wireframe-btn share-self-btn" @click="showShareModal = true">
          👀 Mon QR Code Amis
        </button>
      </div>

      <!-- Vue détaillée d'un ami sélectionné -->
      <template v-if="selectedLibrary">
        <div class="selected-bar">
          <button type="button" class="wireframe-btn" @click="selectedLibrary = null">
            ← Retour à mes amis
          </button>
          <span class="selected-hint">Consultation en lecture seule (Possédés + Wishlist)</span>
        </div>

        <SharedLibraryBrowser :library="selectedLibrary" />
      </template>

      <!-- Liste des amis suivis + ajout par code/lien -->
      <template v-else>
        <section class="add-friend-card">
          <h3 class="card-subtitle">➕ Suivre la bibliothèque d'un ami</h3>
          <p class="card-help">
            Collez le code ami (<code>PUB-...</code>) ou le lien de partage reçu d'un ami (ou scannez son QR code Amis avec l'appareil photo du téléphone).
          </p>
          <div class="add-row">
            <input
              v-model="friendInput"
              type="text"
              class="friend-input"
              placeholder="Ex: PUB-XXXXXX ou https://.../shared/PUB-XXXXXX"
              @keyup.enter="handleAddFriend"
            />
            <button
              type="button"
              class="wireframe-btn add-btn"
              :disabled="adding || !friendInput.trim()"
              @click="handleAddFriend"
            >
              {{ adding ? 'Ajout...' : 'Ajouter' }}
            </button>
          </div>
          <p v-if="statusMsg" :class="['status-banner', statusOk ? 'ok' : 'err']">{{ statusMsg }}</p>
        </section>

        <div v-if="loading" class="loading-box">Chargement de vos amis...</div>

        <div v-else-if="friends.length === 0" class="empty-friends-card">
          <p class="empty-title">Vous ne suivez encore aucune bibliothèque d'ami.</p>
          <p class="empty-desc">
            Demandez à un ami de vous montrer son QR code dans l'onglet <strong>« Vitrine Amis »</strong>, ou partagez le vôtre avec le bouton <strong>« 👀 Mon QR Code Amis »</strong> ci-dessus.
          </p>
        </div>

        <div v-else class="friends-grid">
          <article v-for="friend in friends" :key="friend.libraryId" class="friend-card">
            <div class="friend-card-head">
              <div>
                <h3 class="friend-name">{{ friend.libraryName || 'Bibliothèque ami' }}</h3>
                <p v-if="friend.ownerName" class="friend-owner">Par {{ friend.ownerName }}</p>
              </div>
              <code class="token-tag">{{ friend.shareToken }}</code>
            </div>

            <div class="friend-stats">
              <span class="stat-badge owned">📚 {{ friend.ownedCount }} possédé(s)</span>
              <span class="stat-badge wish">🎁 {{ friend.wishlistCount }} wishlist</span>
            </div>

            <div class="friend-actions">
              <button
                type="button"
                class="wireframe-btn view-btn"
                :disabled="loadingLibraryId === friend.libraryId"
                @click="openFriendLibrary(friend)"
              >
                {{ loadingLibraryId === friend.libraryId ? 'Ouverture...' : '👀 Voir sa collection' }}
              </button>
              <button
                type="button"
                class="wireframe-btn remove-btn"
                @click="handleRemoveFriend(friend)"
                title="Ne plus suivre"
              >
                ✕ Retirer
              </button>
            </div>
          </article>
        </div>
      </template>
    </div>

    <FamilyShareModal :show="showShareModal" initial-tab="friends" @close="showShareModal = false" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import FamilyShareModal from '../components/FamilyShareModal.vue';
import SharedLibraryBrowser from '../components/SharedLibraryBrowser.vue';
import {
  userService,
  type FriendLibrarySummary,
  type PublicSharePayload
} from '../../core/services/user.service';

const friends = ref<FriendLibrarySummary[]>([]);
const loading = ref(true);
const friendInput = ref('');
const adding = ref(false);
const statusMsg = ref('');
const statusOk = ref(false);
const selectedLibrary = ref<PublicSharePayload | null>(null);
const loadingLibraryId = ref<string | null>(null);
const showShareModal = ref(false);

const loadFriends = async () => {
  loading.value = true;
  try {
    friends.value = await userService.listFriends();
  } finally {
    loading.value = false;
  }
};

const handleAddFriend = async () => {
  const raw = friendInput.value.trim();
  if (!raw) return;
  adding.value = true;
  statusMsg.value = '';
  statusOk.value = false;

  try {
    const res = await userService.addFriend(raw);
    if (!res.ok) {
      statusMsg.value = res.error || "Impossible d'ajouter cet ami.";
      return;
    }
    friendInput.value = '';
    statusOk.value = true;
    statusMsg.value = `${res.friend?.libraryName || 'Bibliothèque'} ajoutée à vos amis !`;
    await loadFriends();
  } finally {
    adding.value = false;
  }
};

const openFriendLibrary = async (friend: FriendLibrarySummary) => {
  loadingLibraryId.value = friend.libraryId;
  statusMsg.value = '';
  try {
    selectedLibrary.value = await userService.fetchPublicLibrary(friend.shareToken);
  } catch (e: unknown) {
    statusOk.value = false;
    statusMsg.value = e instanceof Error ? e.message : 'Erreur lors du chargement de la bibliothèque.';
  } finally {
    loadingLibraryId.value = null;
  }
};

const handleRemoveFriend = async (friend: FriendLibrarySummary) => {
  const ok = await userService.removeFriend(friend.libraryId);
  if (ok) {
    friends.value = friends.value.filter((f) => f.libraryId !== friend.libraryId);
  }
};

onMounted(loadFriends);
</script>

<style scoped>
.friends-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 0.75rem 1rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.friends-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.share-self-btn {
  background: #ecfdf5;
  color: #065f46;
  font-weight: 800;
  padding: 0.5rem 0.85rem;
}

.selected-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.selected-hint {
  font-size: 0.82rem;
  font-weight: 700;
  color: #065f46;
}

.add-friend-card {
  border: 2px solid #111827;
  background: #f0fdf4;
  padding: 0.9rem;
  box-shadow: 3px 3px 0 #111827;
}

.card-subtitle {
  margin: 0 0 0.35rem;
  font-size: 1rem;
}

.card-help {
  margin: 0 0 0.65rem;
  font-size: 0.82rem;
  color: #374151;
}

.add-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.friend-input {
  flex: 1;
  min-width: 220px;
  border: 2px solid #111827;
  padding: 0.5rem 0.65rem;
  font-size: 0.88rem;
  background: #fff;
}

.add-btn {
  background: #059669;
  color: #fff;
  font-weight: 800;
  padding: 0.5rem 0.95rem;
}

.status-banner {
  margin: 0.55rem 0 0;
  padding: 0.45rem 0.6rem;
  font-size: 0.82rem;
  font-weight: 700;
}

.status-banner.ok {
  background: #dcfce7;
  color: #166534;
}

.status-banner.err {
  background: #fee2e2;
  color: #991b1b;
}

.loading-box,
.empty-friends-card {
  border: 2px dashed #9ca3af;
  background: #fff;
  padding: 1.4rem;
  text-align: center;
}

.empty-title {
  margin: 0 0 0.35rem;
  font-weight: 800;
  color: #111827;
}

.empty-desc {
  margin: 0;
  font-size: 0.84rem;
  color: #4b5563;
}

.friends-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
  gap: 0.85rem;
}

.friend-card {
  border: 2px solid #111827;
  background: #fff;
  padding: 0.9rem;
  box-shadow: 4px 4px 0 #111827;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.friend-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
}

.friend-name {
  margin: 0;
  font-size: 1rem;
  color: #111827;
}

.friend-owner {
  margin: 0.15rem 0 0;
  font-size: 0.8rem;
  color: #4b5563;
}

.token-tag {
  font-size: 0.72rem;
  font-weight: 800;
  background: #ecfdf5;
  border: 1px solid #059669;
  color: #065f46;
  padding: 0.12rem 0.35rem;
}

.friend-stats {
  display: flex;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.stat-badge {
  font-size: 0.76rem;
  font-weight: 800;
  padding: 0.2rem 0.45rem;
  border: 1.5px solid #111827;
}

.stat-badge.owned {
  background: #eef2ff;
}

.stat-badge.wish {
  background: #fce7f3;
}

.friend-actions {
  display: flex;
  gap: 0.45rem;
  margin-top: auto;
}

.view-btn {
  flex: 1;
  background: #111827;
  color: #fff;
  font-weight: 800;
  padding: 0.45rem 0.65rem;
}

.remove-btn {
  background: #fef2f2;
  color: #991b1b;
  font-weight: 700;
  padding: 0.45rem 0.65rem;
}
</style>
