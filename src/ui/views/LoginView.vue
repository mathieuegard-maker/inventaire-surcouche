<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">📚 Biblio Collection</h1>
      <p class="login-subtitle">Connectez-vous ou créez un compte instantanément</p>

      <!-- Bouton d'installation PWA si disponible -->
      <div v-if="canInstallPwa" class="pwa-install-box">
        <p class="pwa-text">Installez l'application sur votre appareil pour scanner et consulter hors ligne.</p>
        <button type="button" class="pwa-btn" @click="handleInstallPwa">
          📲 Installer l'application
        </button>
      </div>
      <p v-else-if="showIosTip" class="ios-install-tip">
        📲 Sur iPhone/iPad : touchez <strong>Partager ⬆️</strong> puis <strong>« Sur l'écran d'accueil »</strong>.
      </p>

      <!-- Bannière d'invitation Famille -->
      <div v-if="inviteCodeFromUrl" class="invite-box family-invite">
        <div class="invite-title">👨‍👩‍👧‍👦 Invitation Foyer détectée (<code>{{ inviteCodeFromUrl }}</code>)</div>
        <label class="sync-check">
          <input v-model="syncFamily" type="checkbox" />
          <span><strong>Synchroniser avec la famille</strong> (partager la même bibliothèque en lecture &amp; écriture)</span>
        </label>
        <p v-if="!syncFamily" class="invite-note">
          Décoché : vous créerez une bibliothèque personnelle indépendante.
        </p>
      </div>

      <!-- Bannière d'invitation Vitrine Amis -->
      <div v-if="friendTokenFromUrl" class="invite-box friend-invite">
        <div class="invite-title">👀 Invitation Ami détectée (<code>{{ friendTokenFromUrl }}</code>)</div>
        <label class="sync-check">
          <input v-model="followFriend" type="checkbox" />
          <span><strong>Suivre cette bibliothèque dans ma page Amis</strong> (tout en gardant ma propre collection séparée)</span>
        </label>
      </div>

      <form class="login-form" @submit.prevent="handleSubmit">
        <div class="field">
          <label for="username">Identifiant (Prénom ou Pseudo)</label>
          <input
            id="username"
            v-model="username"
            type="text"
            required
            autocomplete="username"
            placeholder="Ex: Camille"
          />
        </div>

        <div class="field">
          <label for="password">Mot de passe</label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
            placeholder="Votre mot de passe"
          />
        </div>

        <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>

        <button type="submit" class="submit-btn" :disabled="submitting">
          {{ submitting ? 'Connexion en cours...' : 'Se connecter / Créer mon compte' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';
import { canInstallPwa, isAppInstalled, isIosDevice, promptPwaInstall } from '../../core/utils/pwa-install.util';

const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const submitting = ref(false);
const errorMsg = ref('');
const syncFamily = ref(true);
const followFriend = ref(true);

const inviteCodeFromUrl = computed(() => {
  const raw = route.query.invite;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : '';
});

const friendTokenFromUrl = computed(() => {
  const raw = route.query.friend;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : '';
});

const showIosTip = computed(() => isIosDevice() && !isAppInstalled.value && !canInstallPwa.value);

watch(inviteCodeFromUrl, (val) => {
  if (val) syncFamily.value = true;
});

watch(friendTokenFromUrl, (val) => {
  if (val) followFriend.value = true;
});

const handleInstallPwa = async () => {
  await promptPwaInstall();
};

const handleSubmit = async () => {
  if (!username.value.trim() || !password.value) return;
  submitting.value = true;
  errorMsg.value = '';

  const effectiveInvite = inviteCodeFromUrl.value && syncFamily.value ? inviteCodeFromUrl.value : undefined;
  const effectiveFriend = friendTokenFromUrl.value && followFriend.value ? friendTokenFromUrl.value : undefined;

  try {
    const ok = await connectionService.login(
      username.value.trim(),
      password.value,
      effectiveInvite,
      effectiveFriend
    );

    if (!ok) {
      errorMsg.value = 'Identifiant ou mot de passe incorrect.';
      return;
    }

    if (effectiveFriend && !effectiveInvite) {
      router.push('/friends');
    } else {
      router.push('/dashboard');
    }
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur réseau lors de la connexion.';
  } finally {
    submitting.value = false;
  }
};
</script>

<style scoped>
.login-page {
  min-height: 85vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.login-card {
  width: 100%;
  max-width: 430px;
  border: 2.5px solid #111827;
  background: #ffffff;
  box-shadow: 6px 6px 0 #111827;
  padding: 1.5rem;
}

.login-title {
  margin: 0 0 0.25rem;
  font-size: 1.45rem;
}

.login-subtitle {
  margin: 0 0 1rem;
  font-size: 0.88rem;
  color: #4b5563;
}

.pwa-install-box {
  border: 2px solid #0284c7;
  background: #f0f9ff;
  padding: 0.7rem;
  margin-bottom: 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.pwa-text {
  margin: 0;
  font-size: 0.8rem;
  color: #0c4a6e;
}

.pwa-btn {
  border: 2px solid #111827;
  background: #0284c7;
  color: #fff;
  font-weight: 800;
  padding: 0.45rem 0.75rem;
  cursor: pointer;
}

.ios-install-tip {
  font-size: 0.78rem;
  color: #374151;
  background: #f3f4f6;
  border: 1.5px solid #d1d5db;
  padding: 0.5rem 0.65rem;
  margin: 0 0 0.9rem;
}

.invite-box {
  border: 2px solid #111827;
  padding: 0.75rem;
  margin-bottom: 0.9rem;
  font-size: 0.84rem;
}

.family-invite {
  background: #eef2ff;
  border-color: #4f46e5;
}

.friend-invite {
  background: #ecfdf5;
  border-color: #059669;
}

.invite-title {
  font-weight: 800;
  margin-bottom: 0.45rem;
}

.sync-check {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  cursor: pointer;
  line-height: 1.35;
}

.sync-check input {
  margin-top: 0.2rem;
  width: 16px;
  height: 16px;
}

.invite-note {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  color: #4b5563;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.field label {
  font-size: 0.84rem;
  font-weight: 800;
}

.field input {
  border: 2px solid #111827;
  padding: 0.55rem 0.7rem;
  font-size: 0.95rem;
}

.error-msg {
  margin: 0;
  background: #fee2e2;
  color: #991b1b;
  padding: 0.5rem;
  font-size: 0.84rem;
  font-weight: 700;
}

.submit-btn {
  border: 2px solid #111827;
  background: #4f46e5;
  color: #fff;
  font-weight: 900;
  font-size: 0.95rem;
  padding: 0.65rem 1rem;
  cursor: pointer;
  box-shadow: 3px 3px 0 #111827;
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
