<!-- src/client/views/LoginView.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { ApiClientError } from '../api/client';
import { t } from '../../shared/locales';

type AuthMode = 'login' | 'register' | 'forgot-step-1' | 'forgot-step-2';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const uiStore = useUiStore();

const mode = ref<AuthMode>('login');
const submitting = ref(false);
const errorMessage = ref('');
const infoMessage = ref('');

// Détection des codes d'invitation / amis dans l'URL
const inviteParam = computed(() => {
  const raw = route.query.invite;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
});
const friendParam = computed(() => {
  const raw = route.query.friend;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
});

const acceptInviteFamily = ref(true);
const acceptInviteFriend = ref(true);

// Champs Connexion
const loginIdentifier = ref('');
const loginPassword = ref('');

// Champs Inscription
const regUsername = ref('');
const regEmail = ref('');
const regPassword = ref('');
const regConfirmPassword = ref('');
const gdprAccepted = ref(false);
const showGdprDetails = ref(false);

// Champs Mot de passe oublié
const forgotIdentifier = ref('');
const forgotCode = ref('');
const forgotNewPassword = ref('');
const forgotConfirmPassword = ref('');

function switchMode(next: AuthMode): void {
  mode.value = next;
  errorMessage.value = '';
  if (next !== 'forgot-step-2') {
    infoMessage.value = '';
  }
}

function getInviteCodes(): { inviteCode?: string; friendToken?: string } {
  return {
    inviteCode: inviteParam.value && acceptInviteFamily.value ? inviteParam.value : undefined,
    friendToken: friendParam.value && acceptInviteFriend.value ? friendParam.value : undefined
  };
}

function extractError(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return t('app.retry');
}

async function handleLogin(): Promise<void> {
  errorMessage.value = '';
  submitting.value = true;
  try {
    await authStore.login({
      identifier: loginIdentifier.value.trim(),
      password: loginPassword.value,
      ...getInviteCodes()
    });
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    await router.replace(redirect);
  } catch (err) {
    errorMessage.value = extractError(err);
  } finally {
    submitting.value = false;
  }
}

async function handleRegister(): Promise<void> {
  errorMessage.value = '';
  if (regPassword.value !== regConfirmPassword.value) {
    errorMessage.value = t('auth.passwordMismatch');
    return;
  }
  if (!gdprAccepted.value) {
    errorMessage.value = t('auth.gdprAcceptLabel');
    return;
  }

  submitting.value = true;
  try {
    await authStore.register({
      username: regUsername.value.trim(),
      email: regEmail.value.trim(),
      password: regPassword.value,
      gdprAccepted: true,
      ...getInviteCodes()
    });
    await router.replace('/dashboard');
  } catch (err) {
    errorMessage.value = extractError(err);
  } finally {
    submitting.value = false;
  }
}

async function handleForgotStep1(): Promise<void> {
  errorMessage.value = '';
  submitting.value = true;
  try {
    const res = await authStore.requestPasswordReset(forgotIdentifier.value.trim());
    infoMessage.value = t('auth.resetCodeSent', { email: res.maskedEmail });
    switchMode('forgot-step-2');
  } catch (err) {
    errorMessage.value = extractError(err);
  } finally {
    submitting.value = false;
  }
}

async function handleForgotStep2(): Promise<void> {
  errorMessage.value = '';
  if (forgotNewPassword.value !== forgotConfirmPassword.value) {
    errorMessage.value = t('auth.passwordMismatch');
    return;
  }

  submitting.value = true;
  try {
    await authStore.resetPassword({
      identifier: forgotIdentifier.value.trim(),
      code: forgotCode.value.trim(),
      newPassword: forgotNewPassword.value
    });
    uiStore.pushToast(t('auth.resetSuccess'), 'success');
    loginIdentifier.value = forgotIdentifier.value.trim();
    loginPassword.value = '';
    forgotCode.value = '';
    forgotNewPassword.value = '';
    forgotConfirmPassword.value = '';
    switchMode('login');
  } catch (err) {
    errorMessage.value = extractError(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="auth-container ds-stack">
    <div class="auth-header">
      <h1 class="auth-title">{{ t('app.title') }}</h1>
      <p class="ds-text-muted">{{ t('auth.loginSubtitle') }}</p>
    </div>

    <div v-if="uiStore.canInstallPwa" class="ds-panel ds-row ds-row--between">
      <span>{{ t('auth.installPwaBtn') }}</span>
      <button type="button" class="ds-btn ds-btn--primary ds-btn--sm" @click="uiStore.triggerPwaInstall()">
        {{ t('auth.installPwaBtn') }}
      </button>
    </div>

    <div v-else-if="uiStore.isIosStandaloneNeeded" class="ds-banner ds-banner--warning">
      {{ t('auth.iosInstallTip') }}
    </div>

    <div class="ds-card">
      <div v-if="mode === 'login' || mode === 'register'" class="ds-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="ds-tab"
          :class="{ 'ds-tab--active': mode === 'login' }"
          :aria-selected="mode === 'login'"
          @click="switchMode('login')"
        >
          {{ t('auth.loginTab') }}
        </button>
        <button
          type="button"
          role="tab"
          class="ds-tab"
          :class="{ 'ds-tab--active': mode === 'register' }"
          :aria-selected="mode === 'register'"
          @click="switchMode('register')"
        >
          {{ t('auth.registerTab') }}
        </button>
      </div>

      <div v-if="(inviteParam || friendParam) && (mode === 'login' || mode === 'register')" class="ds-panel auth-invite">
        <p class="auth-invite__title">{{ t('auth.inviteDetectedBanner') }}</p>
        <label v-if="inviteParam" class="ds-checkbox">
          <input v-model="acceptInviteFamily" type="checkbox" />
          <span>{{ t('auth.inviteFamilyCheckbox') }}</span>
        </label>
        <label v-if="friendParam" class="ds-checkbox">
          <input v-model="acceptInviteFriend" type="checkbox" />
          <span>{{ t('auth.inviteFriendCheckbox') }}</span>
        </label>
      </div>

      <div v-if="errorMessage" class="ds-banner ds-banner--danger" role="alert">
        {{ errorMessage }}
      </div>

      <div v-if="infoMessage" class="ds-banner ds-banner--success">
        {{ infoMessage }}
      </div>

      <!-- Connexion -->
      <form v-if="mode === 'login'" @submit.prevent="handleLogin">
        <div class="ds-field">
          <label class="ds-label" for="login-identifier">{{ t('auth.identifierLabel') }}</label>
          <input
            id="login-identifier"
            v-model="loginIdentifier"
            type="text"
            class="ds-input"
            autocomplete="username"
            required
          />
        </div>

        <div class="ds-field">
          <label class="ds-label" for="login-password">{{ t('auth.passwordLabel') }}</label>
          <input
            id="login-password"
            v-model="loginPassword"
            type="password"
            class="ds-input"
            autocomplete="current-password"
            required
          />
        </div>

        <div class="ds-row ds-row--between">
          <button
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm"
            @click="switchMode('forgot-step-1')"
          >
            {{ t('auth.forgotPasswordLink') }}
          </button>
          <button type="submit" class="ds-btn ds-btn--primary" :disabled="submitting">
            {{ submitting ? t('app.loading') : t('auth.submitLogin') }}
          </button>
        </div>
      </form>

      <!-- Inscription -->
      <form v-else-if="mode === 'register'" @submit.prevent="handleRegister">
        <div class="ds-field">
          <label class="ds-label" for="reg-username">{{ t('auth.usernameLabel') }}</label>
          <input
            id="reg-username"
            v-model="regUsername"
            type="text"
            class="ds-input"
            autocomplete="username"
            minlength="2"
            required
          />
        </div>

        <div class="ds-field">
          <label class="ds-label" for="reg-email">{{ t('auth.emailLabel') }}</label>
          <input
            id="reg-email"
            v-model="regEmail"
            type="email"
            class="ds-input"
            autocomplete="email"
            required
          />
        </div>

        <div class="ds-field">
          <label class="ds-label" for="reg-password">{{ t('auth.passwordLabel') }}</label>
          <input
            id="reg-password"
            v-model="regPassword"
            type="password"
            class="ds-input"
            autocomplete="new-password"
            minlength="8"
            required
          />
        </div>

        <div class="ds-field">
          <label class="ds-label" for="reg-confirm">{{ t('auth.confirmPasswordLabel') }}</label>
          <input
            id="reg-confirm"
            v-model="regConfirmPassword"
            type="password"
            class="ds-input"
            autocomplete="new-password"
            minlength="8"
            required
          />
        </div>

        <div class="ds-field">
          <label class="ds-checkbox">
            <input v-model="gdprAccepted" type="checkbox" required />
            <span>{{ t('auth.gdprAcceptLabel') }}</span>
          </label>
          <button
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm auth-gdpr-toggle"
            @click="showGdprDetails = !showGdprDetails"
          >
            {{ showGdprDetails ? t('auth.gdprHideInfo') : t('auth.gdprMoreInfo') }}
          </button>
          <p v-if="showGdprDetails" class="ds-panel ds-text-muted">
            {{ t('auth.gdprDetails') }}
          </p>
        </div>

        <div class="ds-row auth-actions-end">
          <button type="submit" class="ds-btn ds-btn--primary" :disabled="submitting">
            {{ submitting ? t('app.loading') : t('auth.submitRegister') }}
          </button>
        </div>
      </form>

      <!-- Mot de passe oublié — Étape 1 -->
      <form v-else-if="mode === 'forgot-step-1'" @submit.prevent="handleForgotStep1">
        <h2 class="auth-section-title">{{ t('auth.forgotStep1Title') }}</h2>
        <div class="ds-field">
          <label class="ds-label" for="forgot-identifier">{{ t('auth.forgotIdentifierLabel') }}</label>
          <input
            id="forgot-identifier"
            v-model="forgotIdentifier"
            type="text"
            class="ds-input"
            required
          />
        </div>

        <div class="ds-row ds-row--between">
          <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="switchMode('login')">
            {{ t('auth.backToLogin') }}
          </button>
          <button type="submit" class="ds-btn ds-btn--primary" :disabled="submitting">
            {{ submitting ? t('app.loading') : t('auth.forgotSendCode') }}
          </button>
        </div>
      </form>

      <!-- Mot de passe oublié — Étape 2 -->
      <form v-else @submit.prevent="handleForgotStep2">
        <h2 class="auth-section-title">{{ t('auth.forgotStep1Title') }}</h2>

        <div class="ds-field">
          <label class="ds-label" for="forgot-code">{{ t('auth.forgotCodeLabel') }}</label>
          <input
            id="forgot-code"
            v-model="forgotCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            class="ds-input"
            required
          />
        </div>

        <div class="ds-field">
          <label class="ds-label" for="forgot-new-pwd">{{ t('auth.newPasswordLabel') }}</label>
          <input
            id="forgot-new-pwd"
            v-model="forgotNewPassword"
            type="password"
            class="ds-input"
            autocomplete="new-password"
            minlength="8"
            required
          />
        </div>

        <div class="ds-field">
          <label class="ds-label" for="forgot-confirm-pwd">{{ t('auth.confirmPasswordLabel') }}</label>
          <input
            id="forgot-confirm-pwd"
            v-model="forgotConfirmPassword"
            type="password"
            class="ds-input"
            autocomplete="new-password"
            minlength="8"
            required
          />
        </div>

        <div class="ds-row ds-row--between">
          <button type="button" class="ds-btn ds-btn--ghost ds-btn--sm" @click="switchMode('login')">
            {{ t('auth.backToLogin') }}
          </button>
          <button type="submit" class="ds-btn ds-btn--primary" :disabled="submitting">
            {{ submitting ? t('app.loading') : t('auth.forgotConfirmBtn') }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.auth-header {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.auth-title {
  font-size: 1.6rem;
}

.auth-section-title {
  font-size: 1.1rem;
  margin-bottom: var(--space-4);
}

.auth-invite {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.auth-invite__title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
}

.auth-gdpr-toggle {
  align-self: flex-start;
  padding-left: 0;
}

.auth-actions-end {
  justify-content: flex-end;
}
</style>
