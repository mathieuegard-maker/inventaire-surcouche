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

      <div class="auth-tabs" role="tablist">
        <button
          type="button"
          class="auth-tab"
          :class="{ active: authMode === 'login' }"
          @click="switchMode('login')"
        >
          Se connecter
        </button>
        <button
          type="button"
          class="auth-tab"
          :class="{ active: authMode === 'register' }"
          @click="switchMode('register')"
        >
          Créer un compte
        </button>
      </div>

      <form v-if="authMode !== 'forgot'" class="login-form" @submit.prevent="handleSubmit">
        <div class="field">
          <label for="username">Nom d'utilisateur</label>
          <input
            id="username"
            v-model="username"
            type="text"
            required
            autocomplete="username"
            placeholder="Ex: Camille"
          />
        </div>

        <div v-if="authMode === 'register'" class="field">
          <label for="recovery-email">Adresse e-mail (obligatoire pour la récupération)</label>
          <input
            id="recovery-email"
            v-model="recoveryEmail"
            type="email"
            required
            autocomplete="email"
            placeholder="Ex: camille@exemple.fr"
          />
        </div>

        <div class="field">
          <label for="password">Mot de passe</label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            :autocomplete="authMode === 'register' ? 'new-password' : 'current-password'"
            placeholder="Votre mot de passe"
          />
        </div>

        <div v-if="authMode === 'register'" class="gdpr-box">
          <label class="sync-check">
            <input v-model="gdprAccepted" type="checkbox" required />
            <span>
              J’accepte la conservation de mon compte et de ma bibliothèque sur ce serveur privé (aucune revente de données, suppression possible à tout moment dans Mon profil).
              <button type="button" class="gdpr-link" @click.prevent="showGdprInfo = !showGdprInfo">
                {{ showGdprInfo ? 'Masquer les détails' : 'En savoir plus (RGPD)' }}
              </button>
            </span>
          </label>
          <p v-if="showGdprInfo" class="gdpr-details">
            Vos données personnelles (identifiant, e-mail de récupération, bibliothèque, prêts, statut de lecture et préférences) sont hébergées sur un serveur privé dédié. Vous pouvez exporter, modifier ou supprimer définitivement votre compte à tout moment depuis « Mon profil ». Les fiches bibliographiques anonymisées du catalogue commun ne contiennent aucune donnée personnelle.
          </p>
        </div>

        <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
        <p v-if="successMsg" class="success-msg">{{ successMsg }}</p>

        <button
          type="submit"
          class="submit-btn"
          :disabled="submitting || (authMode === 'register' && !gdprAccepted)"
        >
          {{
            submitting
              ? 'Patientez...'
              : authMode === 'register'
                ? 'Créer mon compte'
                : 'Se connecter'
          }}
        </button>

        <button
          v-if="authMode === 'login'"
          type="button"
          class="link-btn"
          @click="switchMode('forgot')"
        >
          Mot de passe oublié ?
        </button>
      </form>

      <form v-else class="login-form" @submit.prevent="handleForgotSubmit">
        <div class="field">
          <label for="reset-identifier">Nom d'utilisateur ou adresse e-mail</label>
          <input
            id="reset-identifier"
            v-model="resetIdentifier"
            type="text"
            required
            :disabled="resetStep === 'confirm'"
            placeholder="Ex: mathieu egard ou email@exemple.fr"
          />
        </div>

        <template v-if="resetStep === 'confirm'">
          <div class="field">
            <label for="reset-code">Code reçu par e-mail (6 chiffres)</label>
            <input
              id="reset-code"
              v-model="resetCode"
              type="text"
              inputmode="numeric"
              required
              placeholder="123456"
            />
          </div>
          <div class="field">
            <label for="reset-new-password">Nouveau mot de passe</label>
            <input
              id="reset-new-password"
              v-model="resetNewPassword"
              type="password"
              required
              autocomplete="new-password"
              placeholder="Minimum 4 caractères"
            />
          </div>
        </template>

        <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
        <p v-if="successMsg" class="success-msg">{{ successMsg }}</p>

        <button type="submit" class="submit-btn" :disabled="submitting">
          {{
            submitting
              ? 'Envoi en cours...'
              : resetStep === 'request'
                ? 'Envoyer le code de récupération'
                : 'Valider le nouveau mot de passe'
          }}
        </button>

        <button type="button" class="link-btn" @click="switchMode('login')">
          Retour à la connexion
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';
import { userService } from '../../core/services/user.service';
import { canInstallPwa, isAppInstalled, isIosDevice, promptPwaInstall } from '../../core/utils/pwa-install.util';

const route = useRoute();
const router = useRouter();

const authMode = ref<'login' | 'register' | 'forgot'>('login');
const username = ref('');
const recoveryEmail = ref('');
const password = ref('');
const resetIdentifier = ref('');
const resetCode = ref('');
const resetNewPassword = ref('');
const resetStep = ref<'request' | 'confirm'>('request');
const submitting = ref(false);
const errorMsg = ref('');
const successMsg = ref('');
const syncFamily = ref(true);
const followFriend = ref(true);
const gdprAccepted = ref(false);
const showGdprInfo = ref(false);

const switchMode = (mode: 'login' | 'register' | 'forgot') => {
  authMode.value = mode;
  errorMsg.value = '';
  successMsg.value = '';
  if (mode === 'forgot') {
    resetStep.value = 'request';
    resetIdentifier.value = username.value.trim();
    resetCode.value = '';
    resetNewPassword.value = '';
  }
};

const inviteCodeFromUrl = computed(() => {
  const raw = route.query.invite;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : '';
});

const friendTokenFromUrl = computed(() => {
  const raw = route.query.friend;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : '';
});

const showIosTip = computed(() => isIosDevice() && !isAppInstalled.value && !canInstallPwa.value);

watch(
  inviteCodeFromUrl,
  (val) => {
    if (val) {
      syncFamily.value = true;
      if (authMode.value === 'login') authMode.value = 'register';
    }
  },
  { immediate: true }
);

watch(
  friendTokenFromUrl,
  (val) => {
    if (val) {
      followFriend.value = true;
      if (authMode.value === 'login') authMode.value = 'register';
    }
  },
  { immediate: true }
);

const handleInstallPwa = async () => {
  await promptPwaInstall();
};

const handleSubmit = async () => {
  if (!username.value.trim() || !password.value) return;
  if (authMode.value === 'register' && !recoveryEmail.value.trim()) {
    errorMsg.value = "L'adresse e-mail est obligatoire pour créer un compte.";
    return;
  }
  if (authMode.value === 'register' && !gdprAccepted.value) {
    errorMsg.value = 'Veuillez cocher la case RGPD pour créer un compte.';
    return;
  }
  submitting.value = true;
  errorMsg.value = '';
  successMsg.value = '';

  const effectiveInvite = inviteCodeFromUrl.value && syncFamily.value ? inviteCodeFromUrl.value : undefined;
  const effectiveFriend = friendTokenFromUrl.value && followFriend.value ? friendTokenFromUrl.value : undefined;
  const isRegistering = authMode.value === 'register';

  try {
    const ok = await connectionService.login(
      username.value.trim(),
      password.value,
      effectiveInvite,
      effectiveFriend,
      {
        mode: isRegistering ? 'register' : 'login',
        ...(isRegistering ? { recoveryEmail: recoveryEmail.value.trim(), gdprAccepted: true } : {})
      }
    );

    if (!ok) {
      errorMsg.value = 'Identifiant ou mot de passe incorrect.';
      return;
    }

    if (isRegistering && typeof localStorage !== 'undefined') {
      localStorage.setItem('biblio_show_notif_onboarding', '1');
    }

    if (effectiveFriend && !effectiveInvite) {
      router.push('/family?tab=friends');
    } else {
      router.push('/dashboard');
    }
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur réseau lors de la connexion.';
  } finally {
    submitting.value = false;
  }
};

const handleForgotSubmit = async () => {
  errorMsg.value = '';
  successMsg.value = '';
  submitting.value = true;
  try {
    if (resetStep.value === 'request') {
      const res = await userService.requestPasswordReset(resetIdentifier.value.trim());
      resetStep.value = 'confirm';
      successMsg.value = res.maskedEmail
        ? `Un code de réinitialisation a été envoyé à ${res.maskedEmail}.`
        : 'Un code de réinitialisation a été envoyé par e-mail.';
    } else {
      await userService.resetPassword({
        identifier: resetIdentifier.value.trim(),
        code: resetCode.value.trim(),
        newPassword: resetNewPassword.value
      });
      authMode.value = 'login';
      username.value = resetIdentifier.value.trim();
      password.value = '';
      successMsg.value = 'Mot de passe réinitialisé ! Vous pouvez maintenant vous connecter.';
    }
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur lors de la réinitialisation.';
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

.auth-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.4rem;
  margin-bottom: 1rem;
  background: #f1f5f9;
  padding: 0.25rem;
  border-radius: var(--radius-sm, 8px);
}

.auth-tab {
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 0.5rem 0.65rem;
  font-size: 0.86rem;
  font-weight: 600;
  color: #475569;
  cursor: pointer;
}

.auth-tab.active {
  background: #fff;
  color: var(--color-primary, #4f46e5);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.link-btn {
  border: none;
  background: transparent;
  color: var(--color-primary, #4f46e5);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0.25rem;
  text-align: center;
}

.link-btn:hover {
  text-decoration: underline;
}

.success-msg {
  margin: 0;
  background: #dcfce7;
  color: #166534;
  border-radius: var(--radius-sm, 8px);
  padding: 0.55rem 0.75rem;
  font-size: 0.84rem;
  font-weight: 600;
}

.gdpr-box {
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 0.65rem 0.75rem;
  font-size: 0.8rem;
  line-height: 1.4;
  color: #334155;
}

.gdpr-link {
  background: none;
  border: none;
  padding: 0;
  margin-left: 0.25rem;
  color: #4f46e5;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
  font-size: inherit;
}

.gdpr-details {
  margin: 0.5rem 0 0;
  padding-top: 0.45rem;
  border-top: 1px solid #e2e8f0;
  font-size: 0.76rem;
  color: #475569;
}
</style>
