<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import WelcomeModal from '../components/WelcomeModal.vue';
import { TEXTS } from '../locales/fr';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';

const router = useRouter();
const showWelcome = ref(false);

// États réactifs pour le formulaire de connexion
const username = ref('');
const password = ref('');
const isLoading = ref(false);
const errorMessage = ref('');

onMounted(() => {
  // Étape 1 : On vérifie si l'utilisateur a déjà vu la modale d'onboarding
  const hasSeenWelcome = localStorage.getItem('has_seen_welcome');
  
  if (!hasSeenWelcome) {
    // Si la clé n'existe pas, c'est une première ouverture : on affiche la modale
    showWelcome.value = true;
  }
});

const handleCloseWelcome = () => {
  // Étape 2 : Quand l'utilisateur ferme la modale, on enregistre le flag
  localStorage.setItem('has_seen_welcome', 'true');
  showWelcome.value = false;
};

// Traitement de la soumission du formulaire
const handleLogin = async () => {
  if (!username.value || !password.value) return;
  
  isLoading.value = true;
  errorMessage.value = '';
  
  try {
    // Exécution via le chef d'orchestre mis à jour
    const isConnected = await connectionService.login(username.value, password.value);
    
    if (isConnected) {
      // Redirection immédiate vers le tableau de bord
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
        <input 
          v-model="username"
          type="text" 
          :placeholder="TEXTS.login.usernamePlaceholder" 
          class="form-input"
          :disabled="isLoading"
          required
        />
        <input 
          v-model="password"
          type="password" 
          :placeholder="TEXTS.login.passwordPlaceholder" 
          class="form-input"
          :disabled="isLoading"
          required
        />
        <button type="submit" class="btn-submit" :disabled="isLoading">
          {{ isLoading ? TEXTS.login.loading : TEXTS.login.submitButton }}
        </button>
      </form>
    </div>

    <WelcomeModal :show="showWelcome" @close="handleCloseWelcome" />
  </div>
</template>