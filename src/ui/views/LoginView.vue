<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import WelcomeModal from '../components/WelcomeModal.vue';
import BaseInput from '../components/BaseInput.vue';
import BaseButton from '../components/BaseButton.vue';
import BaseTitle from '../components/BaseTitle.vue';
import { TEXTS } from '../locales/fr';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';

const router = useRouter();
const route = useRoute();
const showWelcome = ref(false);

const username = ref('');
const password = ref('');
const inviteCode = ref('');
const showInviteField = ref(false);
const showPassword = ref(false);
const isLoading = ref(false);
const errorMessage = ref('');

onMounted(() => {
  const hasSeenWelcome = localStorage.getItem('has_seen_welcome');
  if (!hasSeenWelcome) {
    showWelcome.value = true;
  }
  const queryInvite = route.query.invite as string | undefined;
  if (queryInvite) {
    inviteCode.value = queryInvite.trim().toUpperCase();
    showInviteField.value = true;
  }
});

const handleCloseWelcome = () => {
  localStorage.setItem('has_seen_welcome', 'true');
  showWelcome.value = false;
};

const handleLogin = async () => {
  if (!username.value || !password.value) return;

  isLoading.value = true;
  errorMessage.value = '';

  try {
    const cleanInvite = inviteCode.value.trim() ? inviteCode.value.trim().toUpperCase() : undefined;
    const isConnected = await connectionService.login(username.value, password.value, cleanInvite);
    if (isConnected) {
      router.push('/dashboard');
    } else {
      errorMessage.value = TEXTS.login.errorInvalid || 'Identifiants invalides.';
    }
  } catch (error) {
    console.error("[VUE] Échec de l'action de connexion :", error);
    errorMessage.value = TEXTS.login.errorServer || 'Impossible de joindre le serveur de synchronisation.';
  } finally {
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="login-container">
    <div class="login-card">
      <BaseTitle text="Ma Bibliothèque Cloud" level="h2" />
      <p class="login-subtitle">
        Connectez-vous ou créez automatiquement votre compte personnel / familial.
      </p>

      <div v-if="errorMessage" class="error-banner">
        {{ errorMessage }}
      </div>

      <form @submit.prevent="handleLogin" class="login-form">
        <div class="form-group">
          <label class="form-label">Identifiant ou Prénom</label>
          <BaseInput
            v-model="username"
            type="text"
            placeholder="Ex: mathieu ou marie"
            :disabled="isLoading"
            required
          />
        </div>

        <div class="form-group">
          <label class="form-label">{{ TEXTS.login.passwordLabel }}</label>
          <BaseInput
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="TEXTS.login.passwordPlaceholder"
            :disabled="isLoading"
            required
          />
        </div>

        <div class="checkbox-group">
          <input id="toggle-password" type="checkbox" v-model="showPassword" />
          <label for="toggle-password">{{ TEXTS.login.showPassword }}</label>
        </div>

        <div class="invite-toggle">
          <button
            type="button"
            class="link-btn"
            @click="showInviteField = !showInviteField"
          >
            {{ showInviteField ? 'Masquer le code famille' : 'Rejoindre une bibliothèque familiale existante (Code)' }}
          </button>
        </div>

        <div v-if="showInviteField" class="form-group invite-box">
          <label class="form-label">Code d'invitation Famille (optionnel)</label>
          <BaseInput
            v-model="inviteCode"
            type="text"
            placeholder="Ex: FAM-8K4P2X"
            :disabled="isLoading"
          />
          <small class="invite-hint">
            Saisissez le code partagé par votre conjoint(e) ou parent pour synchroniser la même collection.
          </small>
        </div>

        <BaseButton
          type="submit"
          variant="primary"
          :disabled="isLoading || !username || !password"
        >
          {{ isLoading ? TEXTS.login.loadingButton : 'Entrer dans ma bibliothèque' }}
        </BaseButton>
      </form>
    </div>

    <WelcomeModal :show="showWelcome" @close="handleCloseWelcome" />
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 80vh;
  padding: 1rem;
}

.login-card {
  width: 100%;
  max-width: 420px;
  border: 2px solid #000;
  padding: 2rem;
  background-color: #fff;
  box-shadow: 4px 4px 0px #000;
}

.login-subtitle {
  font-size: 0.85rem;
  color: #4b5563;
  margin-top: -0.25rem;
  margin-bottom: 1rem;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  margin-top: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.form-label {
  font-weight: bold;
  font-size: 0.9rem;
}

.checkbox-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  cursor: pointer;
}

.checkbox-group input,
.checkbox-group label {
  cursor: pointer;
}

.invite-toggle {
  margin-top: -0.25rem;
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: #2563eb;
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
  text-align: left;
}

.invite-box {
  background: #f8fafc;
  border: 1px dashed #64748b;
  padding: 0.75rem;
}

.invite-hint {
  font-size: 0.78rem;
  color: #475569;
}

.error-banner {
  border: 2px solid #d32f2f;
  background-color: #ffebee;
  color: #c62828;
  padding: 0.75rem;
  font-size: 0.9rem;
  font-weight: bold;
  margin-top: 1rem;
}
</style>
