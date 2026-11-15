<template>
  <div class="public-share-page">
    <div v-if="loading" class="state-card">Chargement de la bibliothèque partagée...</div>

    <div v-else-if="errorMsg" class="state-card error-card">
      <h2>Lien invalide ou indisponible</h2>
      <p>{{ errorMsg }}</p>
      <button type="button" class="action-btn primary" @click="router.push('/login')">
        Accéder à l'application
      </button>
    </div>

    <template v-else-if="library">
      <!-- Barre d'action contextuelle (connecté vs visiteur) -->
      <div class="invite-banner">
        <template v-if="isLoggedIn">
          <div class="banner-text">
            <strong>Connecté en tant que {{ currentUsername || 'Membre' }}</strong>
            <span v-if="isOwnLibrary"> — Vous consultez votre propre vitrine publique.</span>
            <span v-else> — Ajoutez cette bibliothèque à votre page Amis pour la retrouver facilement.</span>
          </div>
          <div class="banner-actions">
            <button
              v-if="!isOwnLibrary && !addedAsFriend"
              type="button"
              class="action-btn success"
              :disabled="addingFriend"
              @click="handleAddFriend"
            >
              {{ addingFriend ? 'Ajout...' : '👥 Ajouter à mes Amis' }}
            </button>
            <button
              v-if="addedAsFriend"
              type="button"
              class="action-btn success"
              @click="router.push('/friends')"
            >
              ✓ Ajouté — Voir mes Amis →
            </button>
            <button type="button" class="action-btn" @click="router.push('/dashboard')">
              🏠 Mon tableau de bord
            </button>
          </div>
        </template>

        <template v-else>
          <div class="banner-text">
            <strong>📖 Découvrez l'application Biblio</strong>
            <span> — Consultez les albums et la wishlist ci-dessous, ou créez votre compte personnel pour suivre cet ami dans votre onglet Amis.</span>
          </div>
          <div class="banner-actions">
            <button
              v-if="canInstallPwa"
              type="button"
              class="action-btn"
              @click="handleInstall"
            >
              📲 Installer l'app
            </button>
            <button type="button" class="action-btn success" @click="goToCreateAccount">
              🚀 Créer mon compte &amp; suivre cet ami
            </button>
          </div>
          <p v-if="iosHint" class="ios-hint">
            Sur iPhone/iPad : appuyez sur Partager ⬆️ puis « Sur l'écran d'accueil » pour installer l'app.
          </p>
        </template>

        <p v-if="friendStatusMsg" class="friend-status">{{ friendStatusMsg }}</p>
      </div>

      <SharedLibraryBrowser :library="library" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { sessionStore } from '../../state/session';
import { userService, type PublicSharePayload } from '../../core/services/user.service';
import { canInstallPwa, isAppInstalled, isIosDevice, promptPwaInstall } from '../../core/utils/pwa-install.util';
import SharedLibraryBrowser from '../components/SharedLibraryBrowser.vue';

const route = useRoute();
const router = useRouter();

const loading = ref(true);
const errorMsg = ref('');
const library = ref<PublicSharePayload | null>(null);
const addingFriend = ref(false);
const addedAsFriend = ref(false);
const friendStatusMsg = ref('');

const cleanToken = computed(() => String(route.params.token || '').trim());
const isLoggedIn = computed(() => Boolean(sessionStore.state.user?.uri || sessionStore.getUserUri()));
const currentUsername = computed(() => sessionStore.state.user?.username || '');
const isOwnLibrary = computed(
  () => Boolean(library.value && sessionStore.state.user?.libraryId && library.value.libraryId === sessionStore.state.user.libraryId)
);
const iosHint = computed(() => isIosDevice() && !isAppInstalled.value && !canInstallPwa.value);

const loadShare = async () => {
  loading.value = true;
  errorMsg.value = '';
  addedAsFriend.value = false;
  friendStatusMsg.value = '';
  sessionStore.restoreSessionFromLocalStorage();

  if (!cleanToken.value) {
    errorMsg.value = 'Jeton de partage manquant.';
    loading.value = false;
    return;
  }

  try {
    library.value = await userService.fetchPublicLibrary(cleanToken.value);
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Impossible de charger cette bibliothèque.';
  } finally {
    loading.value = false;
  }
};

const handleAddFriend = async () => {
  if (!cleanToken.value) return;
  addingFriend.value = true;
  friendStatusMsg.value = '';
  try {
    const res = await userService.addFriend(cleanToken.value);
    if (!res.ok) {
      friendStatusMsg.value = res.error || "Impossible d'ajouter cet ami.";
    } else {
      addedAsFriend.value = true;
      friendStatusMsg.value = `${library.value?.libraryName || 'Bibliothèque'} ajoutée à votre page Amis !`;
    }
  } finally {
    addingFriend.value = false;
  }
};

const handleInstall = async () => {
  await promptPwaInstall();
};

const goToCreateAccount = () => {
  router.push({ path: '/login', query: { friend: cleanToken.value } });
};

onMounted(loadShare);
watch(() => route.params.token, loadShare);
</script>

<style scoped>
.public-share-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.state-card {
  border: 2.5px solid #111827;
  background: #fff;
  padding: 1.5rem;
  text-align: center;
  box-shadow: 4px 4px 0 #111827;
}

.error-card {
  background: #fef2f2;
  color: #991b1b;
}

.invite-banner {
  border: 2px solid #111827;
  background: #fffbeb;
  padding: 0.8rem 0.9rem;
  box-shadow: 3px 3px 0 #111827;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.banner-text {
  font-size: 0.86rem;
  color: #1f2937;
  line-height: 1.4;
}

.banner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.action-btn {
  border: 2px solid #111827;
  background: #fff;
  padding: 0.48rem 0.85rem;
  font-weight: 800;
  font-size: 0.84rem;
  cursor: pointer;
}

.action-btn.primary {
  background: #4f46e5;
  color: #fff;
}

.action-btn.success {
  background: #059669;
  color: #fff;
}

.action-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ios-hint {
  margin: 0;
  font-size: 0.76rem;
  color: #6b7280;
}

.friend-status {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 800;
  color: #065f46;
}
</style>
