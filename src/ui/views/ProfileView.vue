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

const digestFrequency = ref<'off' | 'daily' | 'weekly' | 'monthly'>('off');
const digestHour = ref(9);
const digestWeekday = ref(6);
const digestDayOfMonth = ref(1);
const digestTimezone = ref(
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Europe/Paris'
);
const digestChannel = ref<'push' | 'email' | 'both'>('email');
const hasPushSubscription = ref(false);
const vapidPublicKey = ref<string | null>(null);
const pushBusy = ref(false);
const savingNotif = ref(false);
const notifMsg = ref('');
const notifError = ref('');

const urlBase64ToUint8Array = (base64String: string) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
};

onMounted(async () => {
  try {
    const [profile, prefs] = await Promise.all([
      userService.fetchProfile(),
      userService.getNotificationPrefs().catch(() => null)
    ]);
    if (profile) {
      username.value = profile.username || '';
      recoveryEmail.value = profile.recoveryEmail || '';
    }
    if (prefs) {
      digestFrequency.value = prefs.digestFrequency;
      digestHour.value = prefs.digestHour;
      digestWeekday.value = prefs.digestWeekday;
      digestDayOfMonth.value = prefs.digestDayOfMonth;
      digestTimezone.value = prefs.digestTimezone || digestTimezone.value;
      digestChannel.value = prefs.digestChannel;
      hasPushSubscription.value = prefs.hasPushSubscription;
      vapidPublicKey.value = prefs.vapidPublicKey;
    }
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Impossible de charger le profil.';
  } finally {
    loading.value = false;
  }
});

const handleSaveNotifs = async () => {
  notifError.value = '';
  notifMsg.value = '';
  savingNotif.value = true;
  try {
    await userService.saveNotificationPrefs({
      digestFrequency: digestFrequency.value,
      digestHour: Number(digestHour.value),
      digestWeekday: Number(digestWeekday.value),
      digestDayOfMonth: Number(digestDayOfMonth.value),
      digestTimezone: digestTimezone.value,
      digestChannel: digestChannel.value
    });
    notifMsg.value = 'Préférences de notification enregistrées.';
  } catch (e: unknown) {
    notifError.value = e instanceof Error ? e.message : 'Erreur lors de la sauvegarde.';
  } finally {
    savingNotif.value = false;
  }
};

const handleEnablePush = async () => {
  notifError.value = '';
  notifMsg.value = '';
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
    notifError.value = 'Les notifications Push ne sont pas supportées sur ce navigateur (sur iPhone, installez d’abord l’app sur l’écran d’accueil).';
    return;
  }
  if (!vapidPublicKey.value) {
    notifError.value = 'Clé VAPID serveur non configurée.';
    return;
  }
  pushBusy.value = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      notifError.value = 'Permission de notification refusée.';
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey.value)
    });
    await userService.subscribeWebPush(sub.toJSON());
    hasPushSubscription.value = true;
    notifMsg.value = 'Notifications Push activées sur cet appareil.';
  } catch (e: unknown) {
    notifError.value = e instanceof Error ? e.message : "Impossible d'activer les notifications Push.";
  } finally {
    pushBusy.value = false;
  }
};

const handleDisablePush = async () => {
  notifError.value = '';
  notifMsg.value = '';
  pushBusy.value = true;
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await userService.unsubscribeWebPush(sub.endpoint);
        await sub.unsubscribe();
      } else {
        await userService.unsubscribeWebPush();
      }
    } else {
      await userService.unsubscribeWebPush();
    }
    hasPushSubscription.value = false;
    notifMsg.value = 'Notifications Push désactivées sur cet appareil.';
  } catch (e: unknown) {
    notifError.value = e instanceof Error ? e.message : 'Erreur lors de la désactivation.';
  } finally {
    pushBusy.value = false;
  }
};

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
      <h3 class="notif-title">Notifications &amp; Digest des nouveautés</h3>
      <p class="notif-sub">
        Recevez un récapitulatif des nouveaux tomes détectés dans les séries dont vous possédez au moins un tome.
      </p>

      <form class="profile-form" @submit.prevent="handleSaveNotifs">
        <div class="field">
          <label for="notif-freq">Fréquence du digest</label>
          <select id="notif-freq" v-model="digestFrequency">
            <option value="off">Désactivé</option>
            <option value="daily">Quotidien</option>
            <option value="weekly">Hebdomadaire</option>
            <option value="monthly">Mensuel</option>
          </select>
        </div>

        <template v-if="digestFrequency !== 'off'">
          <div v-if="digestFrequency === 'weekly'" class="field">
            <label for="notif-weekday">Jour de la semaine</label>
            <select id="notif-weekday" v-model.number="digestWeekday">
              <option :value="1">Lundi</option>
              <option :value="2">Mardi</option>
              <option :value="3">Mercredi</option>
              <option :value="4">Jeudi</option>
              <option :value="5">Vendredi</option>
              <option :value="6">Samedi</option>
              <option :value="0">Dimanche</option>
            </select>
          </div>

          <div v-if="digestFrequency === 'monthly'" class="field">
            <label for="notif-dom">Jour du mois</label>
            <select id="notif-dom" v-model.number="digestDayOfMonth">
              <option v-for="d in 28" :key="d" :value="d">Le {{ d }}</option>
            </select>
          </div>

          <div class="field">
            <label for="notif-hour">Heure d'envoi ({{ digestTimezone }})</label>
            <select id="notif-hour" v-model.number="digestHour">
              <option v-for="h in 24" :key="h - 1" :value="h - 1">
                {{ String(h - 1).padStart(2, '0') }}h00
              </option>
            </select>
          </div>

          <div class="field">
            <label for="notif-channel">Canal de réception</label>
            <select id="notif-channel" v-model="digestChannel">
              <option value="email">E-mail</option>
              <option value="push">Notification Push (PWA)</option>
              <option value="both">E-mail + Notification Push</option>
            </select>
          </div>

          <div v-if="digestChannel !== 'email'" class="push-box">
            <button
              v-if="!hasPushSubscription"
              type="button"
              class="wireframe-btn save-btn"
              :disabled="pushBusy"
              @click="handleEnablePush"
            >
              {{ pushBusy ? 'Activation...' : 'Activer les notifications Push sur cet appareil' }}
            </button>
            <button
              v-else
              type="button"
              class="wireframe-btn save-btn"
              :disabled="pushBusy"
              @click="handleDisablePush"
            >
              {{ pushBusy ? 'Désactivation...' : 'Désactiver les notifications Push sur cet appareil' }}
            </button>
          </div>
        </template>

        <p v-if="notifError" class="error-msg">{{ notifError }}</p>
        <p v-if="notifMsg" class="success-msg">{{ notifMsg }}</p>

        <button type="submit" class="wireframe-btn primary save-btn" :disabled="savingNotif">
          {{ savingNotif ? 'Enregistrement...' : 'Enregistrer les préférences de digest' }}
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

.field input,
.field select {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 8px;
  min-block-size: 42px;
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
  background: #fff;
}

.notif-title {
  margin: 0 0 0.25rem;
  font-size: 1.05rem;
}

.notif-sub {
  margin: 0 0 0.9rem;
  font-size: 0.84rem;
  color: #64748b;
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
