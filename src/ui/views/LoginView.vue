<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import WelcomeModal from '../components/WelcomeModal.vue';
import BaseInput from '../components/BaseInput.vue';
import BaseButton from '../components/BaseButton.vue';
import { TEXTS } from '../locales/fr';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';

const router = useRouter();
const showWelcome = ref(false);

const username = ref('');
const password = ref('');
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
      <h2>{{ TEXTS.login.title }}</h2>
      
      <div v-if="errorMessage" class="error-banner">
        {{ errorMessage }}
      </div>
      
      <form @submit.prevent="handleLogin" class="login-form">
        <BaseInput 
          v-model="username"
          type="text" 
          :placeholder="TEXTS.login.usernamePlaceholder" 
          :disabled="isLoading"
          required
        />
        <BaseInput 
          v-model="password"
          type="password" 
          :placeholder="TEXTS.login.passwordPlaceholder" 
          :disabled="isLoading"
          required
        />
        <BaseButton 
          type="submit" 
          variantClass="btn-submit" 
          :disabled="isLoading"
        >
          {{ isLoading ? TEXTS.login.loading : TEXTS.login.submitButton }}
        </BaseButton>
      </form>
    </div>

    <WelcomeModal :show="showWelcome" @close="handleCloseWelcome" />
  </div>
</template>