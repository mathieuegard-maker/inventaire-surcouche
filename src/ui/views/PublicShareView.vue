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
              {{ addingFriend ? 'Ajout...' : 'Ajouter à mes Amis' }}
            </button>
            <button
              v-if="addedAsFriend"
              type="button"
              class="action-btn success"
              @click="router.push('/friends')"
            >
              Ajouté — Voir mes Amis
            </button>
            <button type="button" class="action-btn" @click="router.push('/dashboard')">
              Mon tableau de bord
            </button>
          </div>
        </template>

        <template v-else>
          <div class="banner-text">
            <strong>Gardez cette bibliothèque dans votre poche</strong>
            <span> — Créez votre compte gratuit pour la retrouver à tout moment dans l'application (sans risquer de perdre ce lien).</span>
          </div>
          <div class="banner-actions">
            <button
              v-if="canInstallPwa"
              type="button"
              class="action-btn"
              @click="handleInstall"
            >
              Installer l'app
            </button>
            <button type="button" class="action-btn success" @click="goToCreateAccount">
              Créer mon compte &amp; suivre cette collection
            </button>
          </div>
          <p v-if="iosHint" class="ios-hint">
            Sur iPhone/iPad : appuyez sur Partager puis « Sur l'écran d'accueil » pour installer l'app.
          </p>
        </template>

        <p v-if="friendStatusMsg" class="friend-status">{{ friendStatusMsg }}</p>
      </div>

      <SharedLibraryBrowser :library="library" />

      <!-- Modale d'accueil non bloquante (Option A : aperçu + incitation forte) -->
      <div
        v-if="!isLoggedIn && showVisitorModal"
        class="visitor-modal-backdrop"
        @click.self="dismissVisitorModal"
      >
        <div class="visitor-modal" role="dialog" aria-modal="true" aria-labelledby="visitor-modal-title">
          <h3 id="visitor-modal-title" class="visitor-modal-title">
            Sauvegardez la bibliothèque de {{ library.ownerName || 'cet ami' }}
          </h3>
          <p class="visitor-modal-desc">
            Vous pouvez consulter sa collection dès maintenant. Pour ne pas perdre ce lien et la retrouver facilement dans <strong>Mes Amis</strong>, créez votre compte en 10 secondes et installez l'application !
          </p>
          <div class="visitor-modal-actions">
            <button type="button" class="action-btn success full-btn" @click="goToCreateAccount">
              Créer mon compte &amp; suivre cette collection
            </button>
            <button
              v-if="canInstallPwa"
              type="button"
              class="action-btn primary full-btn"
              @click="handleInstall"
            >
              Installer l'application sur cet appareil
            </button>
            <p v-if="iosHint" class="ios-hint">
              Sur iPhone/iPad : touchez <strong>Partager</strong> puis <strong>« Sur l'écran d'accueil »</strong>.
            </p>
            <button type="button" class="action-btn full-btn" @click="dismissVisitorModal">
              Continuer l'aperçu sans compte
            </button>
          </div>
        </div>
      </div>
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
const showVisitorModal = ref(true);

const dismissVisitorModal = () => {
  showVisitorModal.value = false;
};

const cleanToken = computed(() => String(route.params.token || '').trim());
const isLoggedIn = computed(() => Boolean(sessionStore.state.user?.uri || sessionStore.getUserUri()));
const currentUsername = computed(() => sessionStore.state.user?.username || '');
const isOwnLibrary = computed(() => {
  const user = sessionStore.state.user;
  if (!user) return false;
  if (user.publicReadonlyToken && cleanToken.value.toUpperCase() === user.publicReadonlyToken.toUpperCase()) {
    return true;
  }
  return Boolean(library.value && user.libraryId && library.value.libraryId === user.libraryId);
});
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
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  background: #fff;
  padding: 1.5rem;
  text-align: center;
  box-shadow: var(--shadow-md);
}

.error-card {
  background: #fef2f2;
  border-color: #fecaca;
  color: #991b1b;
}

.invite-banner {
  border: 1px solid #fde68a;
  border-radius: var(--radius-md, 12px);
  background: #fffbeb;
  padding: 0.85rem 1rem;
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.banner-text {
  font-size: 0.86rem;
  color: #1f2937;
  line-height: 1.45;
  text-wrap: pretty;
}

.banner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.action-btn {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  background: #fff;
  min-block-size: 38px;
  padding: 0.48rem 0.9rem;
  font-weight: 600;
  font-size: 0.84rem;
  cursor: pointer;
}

.action-btn.primary {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #fff;
}

.action-btn.success {
  background: #059669;
  border-color: #059669;
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

.visitor-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: rgba(15, 23, 42, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.visitor-modal {
  width: 100%;
  max-width: 420px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 14px);
  padding: 1.35rem;
  box-shadow: var(--shadow-lg);
}

.visitor-modal-title {
  margin: 0 0 0.5rem;
  font-size: 1.15rem;
}

.visitor-modal-desc {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  color: #475569;
  line-height: 1.45;
}

.visitor-modal-actions {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.full-btn {
  width: 100%;
  min-block-size: 42px;
}
</style>
