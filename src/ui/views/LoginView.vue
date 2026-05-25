<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import WelcomeModal from '../components/WelcomeModal.vue';
import BaseInput from '../components/BaseInput.vue';
import BaseButton from '../components/BaseButton.vue';
import BaseTitle from '../components/BaseTitle.vue';
import { TEXTS } from '../locales/fr';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';

const router = useRouter();
const showWelcome = ref(false);

const username = ref('');
const password = ref('');
const showPassword = ref(false); // Gestion réactive de la visibilité du mot de passe
const isLoading = ref(false);
const errorMessage = ref('');

onMounted(() => {
  const hasSeenWelcome = localStorage.getItem('has_seen_welcome');
  if (!hasSeenWelcome) {
    showWelcome.value = true;
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
    const isConnected = await connectionService.login(username.value, password.value);
    if (isConnected) {
      router.push('/dashboard');
    } else {
      errorMessage.value = "Identifiants invalides ou compte inconnu.";
    }
  } catch (error) {
    console.error("[VUE] Échec de l'action de connexion :", error);
    errorMessage.value = "Impossible de joindre le serveur de synchronisation.";
  } finally {
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="login-container">
    <div class="login-card">
      <BaseTitle :text="TEXTS.login.title" level="h2" />
      
      <div v-if="errorMessage" class="error-banner">
        {{ errorMessage }}
      </div>
      
      <form @submit.prevent="handleLogin" class="login-form">
        <div class="form-group">
          <label class="form-label">{{ TEXTS.login.usernameLabel }}</label>
          <BaseInput 
            v-model="username"
            type="text" 
            :placeholder="TEXTS.login.usernamePlaceholder" 
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
          <input 
            id="toggle-password"
            type="checkbox" 
            v-model="showPassword"
            class="wireframe-checkbox"
          />
          <label for="toggle-password" class="checkbox-label">
            {{ TEXTS.login.showPasswordLabel }}
          </label>
        </div>

        <div class="login-notice-box">
          <p class="notice-text">{{ TEXTS.login.noticeText }}</p>
          <a href="https://inventaire.io" target="_blank" rel="noopener noreferrer" class="notice-link">
            [ {{ TEXTS.login.noticeLink }} ]
          </a>
        </div>

        <BaseButton 
          type="submit" 
          :disabled="isLoading"
        >
          {{ isLoading ? TEXTS.login.loading : TEXTS.login.submitButton }}
        </BaseButton>
      </form>
    </div>

    <WelcomeModal :show="showWelcome" @close="handleCloseWelcome" />
  </div>
</template>