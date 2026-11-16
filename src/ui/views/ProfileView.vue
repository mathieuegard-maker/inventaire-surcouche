<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import { userService } from '../../core/services/user.service';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';
import { sessionStore } from '../../state/session';

const router = useRouter();

const username = ref(sessionStore.state.user?.username || '');
const recoveryEmail = ref(sessionStore.state.user?.recoveryEmail || '');
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');

const loading = ref(true);
const saving = ref(false);
const errorMsg = ref('');
const successMsg = ref('');

onMounted(async () => {
  try {
    const profile = await userService.fetchProfile();
    if (profile) {
      username.value = profile.username || '';
      recoveryEmail.value = profile.recoveryEmail || '';
    }
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Impossible de charger le profil.';
  } finally {
    loading.value = false;
  }
});

const handleSave = async () => {
  errorMsg.value = '';
  successMsg.value = '';

  if (!username.value.trim()) {
    errorMsg.value = "Le nom d'utilisateur est obligatoire.";
    return;
  }
  if (!recoveryEmail.value.trim()) {
    errorMsg.value = "L'adresse e-mail de récupération est obligatoire.";
    return;
  }
  if (newPassword.value) {
    if (!currentPassword.value) {
      errorMsg.value = 'Veuillez saisir votre mot de passe actuel pour le modifier.';
      return;
    }
    if (newPassword.value !== confirmPassword.value) {
      errorMsg.value = 'Les deux nouveaux mots de passe ne correspondent pas.';
      return;
    }
    if (newPassword.value.length < 4) {
      errorMsg.value = 'Le nouveau mot de passe doit contenir au moins 4 caractères.';
      return;
    }
  }

  saving.value = true;
  try {
    await userService.updateProfile({
      username: username.value.trim(),
      recoveryEmail: recoveryEmail.value.trim(),
      ...(newPassword.value
        ? {
            currentPassword: currentPassword.value,
            newPassword: newPassword.value
          }
        : {})
    });
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    successMsg.value = 'Profil mis à jour avec succès.';
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur lors de la sauvegarde.';
  } finally {
    saving.value = false;
  }
};

const loggingOut = ref(false);
const handleLogout = async () => {
  loggingOut.value = true;
  try {
    await connectionService.logout();
    router.push('/login');
  } finally {
    loggingOut.value = false;
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle text="Mon Profil" level="h2" />

    <div v-if="loading" class="profile-card">
      <p class="loading-text">Chargement du profil...</p>
    </div>

    <div v-else class="profile-card">
      <div v-if="!recoveryEmail" class="warning-banner">
        Aucune adresse e-mail de récupération enregistrée : ajoutez-en une dès maintenant pour pouvoir réinitialiser votre mot de passe en cas d'oubli.
      </div>

      <form class="profile-form" @submit.prevent="handleSave">
        <div class="field">
          <label for="profile-username">Nom d'utilisateur</label>
          <input
            id="profile-username"
            v-model="username"
            type="text"
            required
            autocomplete="username"
          />
        </div>

        <div class="field">
          <label for="profile-email">Adresse e-mail de récupération (obligatoire)</label>
          <input
            id="profile-email"
            v-model="recoveryEmail"
            type="email"
            required
            autocomplete="email"
            placeholder="exemple@domaine.fr"
          />
        </div>

        <hr class="section-sep" />
        <p class="section-hint">Changer de mot de passe (optionnel)</p>

        <div class="field">
          <label for="profile-current-password">Mot de passe actuel</label>
          <input
            id="profile-current-password"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            placeholder="Laissez vide si inchangé"
          />
        </div>

        <div class="field">
          <label for="profile-new-password">Nouveau mot de passe</label>
          <input
            id="profile-new-password"
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            placeholder="Minimum 4 caractères"
          />
        </div>

        <div class="field">
          <label for="profile-confirm-password">Confirmer le nouveau mot de passe</label>
          <input
            id="profile-confirm-password"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            placeholder="Retapez le nouveau mot de passe"
          />
        </div>

        <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
        <p v-if="successMsg" class="success-msg">{{ successMsg }}</p>

        <button type="submit" class="wireframe-btn primary save-btn" :disabled="saving">
          {{ saving ? 'Enregistrement...' : 'Enregistrer les modifications' }}
        </button>
      </form>

      <hr class="section-sep logout-sep" />
      <button
        type="button"
        class="wireframe-btn danger logout-btn"
        :disabled="loggingOut"
        @click="handleLogout"
      >
        {{ loggingOut ? 'Déconnexion...' : 'Se déconnecter' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.profile-card {
  max-width: 520px;
  margin: 1rem auto;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  padding: 1.5rem;
  box-shadow: var(--shadow-sm);
}

.warning-banner {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.88rem;
  font-weight: 500;
}

.profile-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.field label {
  font-size: 0.86rem;
  font-weight: 600;
}

.field input {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 8px;
  min-block-size: 42px;
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
}

.section-sep {
  border: none;
  border-top: 1px solid var(--color-border, #e2e8f0);
  margin: 0.4rem 0;
}

.section-hint {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 600;
  color: #475569;
}

.error-msg {
  margin: 0;
  background: #fee2e2;
  color: #991b1b;
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
  font-size: 0.86rem;
  font-weight: 600;
}

.success-msg {
  margin: 0;
  background: #dcfce7;
  color: #166534;
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
  font-size: 0.86rem;
  font-weight: 600;
}

.save-btn,
.logout-btn {
  min-block-size: 44px;
  font-weight: 600;
  width: 100%;
}

.logout-sep {
  margin: 1.25rem 0 1rem;
}

.logout-btn {
  background: #fee2e2;
  color: #991b1b;
  border-color: #fecaca;
}

.loading-text {
  margin: 0;
  color: #64748b;
}
</style>
