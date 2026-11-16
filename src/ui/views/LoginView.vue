<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">Biblio Collection</h1>
      <p class="login-subtitle">Connectez-vous ou créez un compte instantanément</p>

      <!-- Bouton d'installation PWA si disponible -->
      <div v-if="canInstallPwa" class="pwa-install-box">
        <p class="pwa-text">Installez l'application sur votre appareil pour scanner et consulter hors ligne.</p>
        <button type="button" class="pwa-btn" @click="handleInstallPwa">
          Installer l'application
        </button>
      </div>
      <p v-else-if="showIosTip" class="ios-install-tip">
        Sur iPhone/iPad : touchez <strong>Partager</strong> puis <strong>« Sur l'écran d'accueil »</strong>.
      </p>

      <!-- Bannière d'invitation Famille -->
      <div v-if="inviteCodeFromUrl" class="invite-box family-invite">
        <div class="invite-title">Invitation Foyer détectée (<code>{{ inviteCodeFromUrl }}</code>)</div>
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
        <div class="invite-title">Invitation Ami détectée (<code>{{ friendTokenFromUrl }}</code>)</div>
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
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  background: #ffffff;
  box-shadow: var(--shadow-lg, 0 10px 15px -3px rgba(15, 23, 42, 0.1));
  padding: 1.5rem;
}

.login-title {
  margin: 0 0 0.25rem;
  font-size: 1.45rem;
  text-wrap: balance;
}

.login-subtitle {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  line-height: 1.45;
  color: #4b5563;
  text-wrap: pretty;
}

.pwa-install-box {
  border: 1px solid #bae6fd;
  border-radius: var(--radius-md, 12px);
  background: #f0f9ff;
  padding: 0.75rem;
  margin-bottom: 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.pwa-text {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: #0c4a6e;
}

.pwa-btn {
  border: 1px solid #0284c7;
  border-radius: var(--radius-sm, 8px);
  background: #0284c7;
  color: #fff;
  font-weight: 600;
  min-block-size: 38px;
  padding: 0.45rem 0.75rem;
  cursor: pointer;
}

.ios-install-tip {
  font-size: 0.8rem;
  line-height: 1.4;
  color: #374151;
  background: #f8fafc;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.55rem 0.7rem;
  margin: 0 0 0.9rem;
}

.invite-box {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  padding: 0.8rem;
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
  font-weight: 600;
}

.field input {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  min-block-size: 42px;
  padding: 0.55rem 0.75rem;
  font-size: 0.95rem;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.field input:focus {
  outline: none;
  border-color: var(--color-primary, #4f46e5);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15);
}

.error-msg {
  margin: 0;
  background: #fee2e2;
  color: #991b1b;
  border-radius: var(--radius-sm, 8px);
  padding: 0.55rem 0.75rem;
  font-size: 0.84rem;
  font-weight: 600;
}

.submit-btn {
  border: 1px solid var(--color-primary, #4f46e5);
  border-radius: var(--radius-sm, 8px);
  background: var(--color-primary, #4f46e5);
  color: #fff;
  font-weight: 600;
  font-size: 0.95rem;
  min-block-size: 44px;
  padding: 0.65rem 1rem;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: background-color 0.15s ease;
}

.submit-btn:hover:not(:disabled) {
  background: var(--color-primary-hover, #4338ca);
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
