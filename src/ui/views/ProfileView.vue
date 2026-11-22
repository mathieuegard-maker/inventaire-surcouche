<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import StatsView from './StatsView.vue';
import { userService } from '../../core/services/user.service';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';
import { sessionStore } from '../../state/session';

const route = useRoute();
const router = useRouter();

type ProfileTab = 'account' | 'stats' | 'genres' | 'notifications';

const activeTab = computed<ProfileTab>(() => {
  const q = String(route.query.tab || '').toLowerCase();
  if (q === 'stats') return 'stats';
  if (q === 'genres') return 'genres';
  if (q === 'notifications') return 'notifications';
  return 'account';
});

const defaultGenres = ref<string[]>([]);
const newDefaultGenre = ref('');
const savingGenres = ref(false);
const genresFeedback = ref('');
const genresError = ref('');

const handleAddDefaultGenre = async () => {
  const clean = newDefaultGenre.value.trim();
  if (!clean || savingGenres.value) return;
  savingGenres.value = true;
  genresError.value = '';
  genresFeedback.value = '';
  try {
    const res = await userService.updateDefaultGenres('add', clean);
    defaultGenres.value = res.genres;
    newDefaultGenre.value = '';
    genresFeedback.value = `« ${clean} » ajouté à vos genres par défaut.`;
  } catch (e: unknown) {
    genresError.value = e instanceof Error ? e.message : "Impossible d'ajouter ce genre.";
  } finally {
    savingGenres.value = false;
  }
};

const handleRemoveDefaultGenre = async (genre: string) => {
  if (savingGenres.value) return;
  savingGenres.value = true;
  genresError.value = '';
  genresFeedback.value = '';
  try {
    const res = await userService.updateDefaultGenres('remove', genre);
    defaultGenres.value = res.genres;
  } catch (e: unknown) {
    genresError.value = e instanceof Error ? e.message : 'Impossible de retirer ce genre.';
  } finally {
    savingGenres.value = false;
  }
};

const handleResetDefaultGenres = async () => {
  if (savingGenres.value) return;
  savingGenres.value = true;
  genresError.value = '';
  genresFeedback.value = '';
  try {
    const res = await userService.updateDefaultGenres('reset');
    defaultGenres.value = res.genres;
    genresFeedback.value = 'Liste des genres par défaut réinitialisée.';
  } catch (e: unknown) {
    genresError.value = e instanceof Error ? e.message : 'Impossible de réinitialiser les genres.';
  } finally {
    savingGenres.value = false;
  }
};

const setProfileTab = (tab: ProfileTab) => {
  if (activeTab.value === tab) return;
  router.replace({ path: '/profile', query: tab === 'account' ? {} : { tab } });
};

const username = ref(sessionStore.state.user?.username || '');
const recoveryEmail = ref(sessionStore.state.user?.recoveryEmail || '');
const initialUsername = ref(username.value);
const initialRecoveryEmail = ref(recoveryEmail.value);
const isAdmin = ref(Boolean(sessionStore.state.user?.isAdmin));
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
const digestChannel = ref<'push' | 'email' | 'both'>('push');
const hasPushSubscription = ref(false);
const vapidPublicKey = ref<string | null>(null);
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
    const [profile, prefs, genrePrefs] = await Promise.all([
      userService.fetchProfile(),
      userService.getNotificationPrefs().catch(() => null),
      userService.fetchDefaultGenres().catch(() => null)
    ]);
    if (genrePrefs?.genres) {
      defaultGenres.value = genrePrefs.genres;
    }
    if (profile) {
      username.value = profile.username || '';
      recoveryEmail.value = profile.recoveryEmail || '';
      initialUsername.value = username.value;
      initialRecoveryEmail.value = recoveryEmail.value;
      isAdmin.value = Boolean(profile.isAdmin);
    }
    if (prefs) {
      digestFrequency.value = prefs.digestFrequency;
      digestHour.value = prefs.digestHour;
      digestWeekday.value = prefs.digestWeekday;
      digestDayOfMonth.value = prefs.digestDayOfMonth;
      digestTimezone.value = prefs.digestTimezone || digestTimezone.value;
      digestChannel.value = prefs.digestChannel;
      vapidPublicKey.value = prefs.vapidPublicKey;
    }
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.pushManager) {
        const existingSub = await reg.pushManager.getSubscription();
        hasPushSubscription.value = Boolean(existingSub);
      } else if (prefs) {
        hasPushSubscription.value = prefs.hasPushSubscription;
      }
    } else if (prefs) {
      hasPushSubscription.value = prefs.hasPushSubscription;
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
    let pushWarning = '';

    if (digestFrequency.value !== 'off' && digestChannel.value !== 'email') {
      if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
        pushWarning = ' (Push non supporté sur ce navigateur ; sur iPhone, installez d’abord l’app sur l’écran d’accueil).';
      } else if (!vapidPublicKey.value) {
        pushWarning = ' (Clé VAPID serveur non configurée).';
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          pushWarning = ' (Permission Push refusée sur cet appareil).';
        } else {
          const reg = await navigator.serviceWorker.getRegistration();
          if (!reg?.pushManager) {
            pushWarning = ' (Service Worker non actif sur cet appareil).';
          } else {
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
              sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey.value)
              });
            }
            await userService.subscribeWebPush(sub.toJSON());
            hasPushSubscription.value = true;
          }
        }
      }
    } else if (digestFrequency.value === 'off' && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) {
        await userService.unsubscribeWebPush(sub.endpoint);
        await sub.unsubscribe();
        hasPushSubscription.value = false;
      }
    }

    await userService.saveNotificationPrefs({
      digestFrequency: digestFrequency.value,
      digestHour: Number(digestHour.value),
      digestWeekday: Number(digestWeekday.value),
      digestDayOfMonth: Number(digestDayOfMonth.value),
      digestTimezone: digestTimezone.value,
      digestChannel: digestChannel.value
    });

    if (pushWarning) {
      notifError.value = `Préférences enregistrées${pushWarning}`;
    } else {
      notifMsg.value =
        digestFrequency.value !== 'off' && digestChannel.value !== 'email'
          ? 'Préférences enregistrées et notifications Push activées sur cet appareil.'
          : 'Préférences de notification enregistrées.';
    }
  } catch (e: unknown) {
    notifError.value = e instanceof Error ? e.message : 'Erreur lors de la sauvegarde.';
  } finally {
    savingNotif.value = false;
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
  const sensitiveAccountChange =
    username.value.trim() !== initialUsername.value.trim() ||
    recoveryEmail.value.trim().toLowerCase() !== initialRecoveryEmail.value.trim().toLowerCase();

  if ((newPassword.value || sensitiveAccountChange) && !currentPassword.value) {
    errorMsg.value = 'Veuillez saisir votre mot de passe actuel pour confirmer la modification.';
    return;
  }
  if (newPassword.value) {
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
      ...(currentPassword.value ? { currentPassword: currentPassword.value } : {}),
      ...(newPassword.value ? { newPassword: newPassword.value } : {})
    });
    initialUsername.value = username.value.trim();
    initialRecoveryEmail.value = recoveryEmail.value.trim();
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

const showDeleteAccountModal = ref(false);
const deleteAccountPassword = ref('');
const deletingAccount = ref(false);
const deleteAccountError = ref('');

const handleConfirmDeleteAccount = async () => {
  if (!deleteAccountPassword.value || deletingAccount.value) return;
  deletingAccount.value = true;
  deleteAccountError.value = '';
  try {
    await connectionService.deleteAccount(deleteAccountPassword.value);
    showDeleteAccountModal.value = false;
    router.push('/login');
  } catch (e: unknown) {
    deleteAccountError.value = e instanceof Error ? e.message : 'Erreur lors de la suppression du compte.';
  } finally {
    deletingAccount.value = false;
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <div class="profile-hub">
      <BaseTitle text="Mon Profil" level="h2" />

      <div class="profile-subnav" role="tablist" aria-label="Sections Mon Profil">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'account'"
          :class="['profile-subnav-tab', { active: activeTab === 'account' }]"
          @click="setProfileTab('account')"
        >
          Compte &amp; Sécurité
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'stats'"
          :class="['profile-subnav-tab', { active: activeTab === 'stats' }]"
          @click="setProfileTab('stats')"
        >
          Statistiques
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'genres'"
          :class="['profile-subnav-tab', { active: activeTab === 'genres' }]"
          @click="setProfileTab('genres')"
        >
          Genres par défaut
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'notifications'"
          :class="['profile-subnav-tab', { active: activeTab === 'notifications' }]"
          @click="setProfileTab('notifications')"
        >
          Notifications
        </button>
        <button
          v-if="isAdmin"
          type="button"
          class="profile-subnav-tab admin-tab"
          @click="router.push('/admin')"
        >
          Administration
        </button>
      </div>

      <div v-if="activeTab === 'stats'" class="profile-stats-wrap">
        <StatsView :embedded="true" />
      </div>

      <div v-else-if="loading" class="profile-card">
        <p class="loading-text">Chargement du profil...</p>
      </div>

      <div v-else-if="activeTab === 'account'" class="profile-card">
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

        <button
          type="button"
          class="wireframe-btn delete-account-trigger"
          @click="showDeleteAccountModal = true; deleteAccountPassword = ''; deleteAccountError = ''"
        >
          Supprimer définitivement mon compte
        </button>
      </div>

      <div v-else-if="activeTab === 'genres'" class="profile-card">
        <h3 class="notif-title">Mes genres par défaut</h3>
        <p class="notif-sub">
          Personnalisez les genres proposés par défaut lorsque vous modifiez une fiche ou classez un lot de livres. Ces préférences sont propres à votre compte.
        </p>

        <form class="genre-add-form" @submit.prevent="handleAddDefaultGenre">
          <input
            v-model="newDefaultGenre"
            type="text"
            class="ds-input"
            placeholder="Nouveau genre (ex: Comics, Polar historique...)"
            :disabled="savingGenres"
          />
          <button
            type="submit"
            class="wireframe-btn primary genre-add-submit"
            :disabled="savingGenres || !newDefaultGenre.trim()"
          >
            + Ajouter
          </button>
        </form>

        <p v-if="genresError" class="error-msg">{{ genresError }}</p>
        <p v-if="genresFeedback" class="success-msg">{{ genresFeedback }}</p>

        <div class="profile-genres-list">
          <span v-for="genre in defaultGenres" :key="genre" class="profile-genre-chip">
            {{ genre }}
            <button
              type="button"
              class="profile-genre-remove"
              :disabled="savingGenres"
              title="Retirer de mes genres par défaut"
              @click="handleRemoveDefaultGenre(genre)"
            >
              ×
            </button>
          </span>
        </div>

        <hr class="section-sep logout-sep" />
        <button
          type="button"
          class="wireframe-btn save-btn"
          :disabled="savingGenres"
          @click="handleResetDefaultGenres"
        >
          Réinitialiser la liste standard
        </button>
      </div>

      <div v-else-if="activeTab === 'notifications'" class="profile-card">
        <h3 class="notif-title">Notifications des nouveautés</h3>
        <p class="notif-sub">
          Recevez une alerte lorsque de nouveaux tomes paraissent dans les séries dont vous possédez au moins un tome.
        </p>

        <form class="profile-form" @submit.prevent="handleSaveNotifs">
          <div class="field">
            <label for="notif-freq">Fréquence des notifications</label>
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
                <option value="push">Notification Push (application)</option>
                <option value="email">E-mail</option>
                <option value="both">Notification Push + E-mail</option>
              </select>
            </div>

            <p v-if="digestChannel !== 'email'" class="notif-sub">
              {{
                hasPushSubscription
                  ? 'Notifications Push déjà actives sur cet appareil.'
                  : 'L’enregistrement activera automatiquement les notifications Push sur cet appareil.'
              }}
            </p>
          </template>

          <p v-if="notifError" class="error-msg">{{ notifError }}</p>
          <p v-if="notifMsg" class="success-msg">{{ notifMsg }}</p>

          <button type="submit" class="wireframe-btn primary save-btn" :disabled="savingNotif">
            {{ savingNotif ? 'Enregistrement...' : 'Enregistrer les préférences' }}
          </button>
        </form>
      </div>
    </div>

    <!-- Modale de suppression définitive de compte -->
    <Teleport to="body">
      <div v-if="showDeleteAccountModal" class="modal-overlay" @click.self="showDeleteAccountModal = false">
        <div class="modal-box" role="dialog" aria-modal="true" aria-label="Supprimer mon compte">
          <h2>Supprimer mon compte</h2>
          <p class="modal-text">
            Cette action est <strong>irréversible</strong>. Elle supprime votre compte, vos statuts de lecture, vos notes personnelles et vos préférences :
          </p>
          <ul class="delete-account-rules">
            <li>Si vous êtes <strong>seul</strong> dans votre bibliothèque, votre collection, wishlist et prêts seront supprimés.</li>
            <li>Si vous partagez un <strong>foyer</strong> avec d’autres membres, la bibliothèque du foyer reste intacte pour eux.</li>
            <li>Le catalogue central commun des livres n’est jamais affecté.</li>
          </ul>
          <div class="field">
            <label for="delete-account-pwd">Confirmez avec votre mot de passe actuel</label>
            <input
              id="delete-account-pwd"
              v-model="deleteAccountPassword"
              type="password"
              autocomplete="current-password"
              placeholder="Votre mot de passe"
              @keydown.enter.prevent="handleConfirmDeleteAccount"
            />
          </div>
          <p v-if="deleteAccountError" class="error-msg">{{ deleteAccountError }}</p>
          <div class="modal-actions">
            <button
              type="button"
              class="btn-danger"
              :disabled="deletingAccount || !deleteAccountPassword"
              @click="handleConfirmDeleteAccount"
            >
              {{ deletingAccount ? 'Suppression...' : 'Supprimer définitivement' }}
            </button>
            <button
              type="button"
              class="btn-close"
              :disabled="deletingAccount"
              @click="showDeleteAccountModal = false"
            >
              Annuler
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.profile-hub {
  width: 100%;
  max-width: 960px;
  margin: 0 auto 2rem;
}

.profile-subnav {
  display: flex;
  gap: 0.5rem;
  margin: 0.5rem 0 1rem;
  flex-wrap: wrap;
}

.profile-subnav-tab {
  min-block-size: 40px;
  padding: 0.45rem 1rem;
  border-radius: 999px;
  border: 1px solid var(--color-border, #e2e8f0);
  background: var(--color-surface, #fff);
  color: var(--color-text-muted, #475569);
  font-weight: 700;
  font-size: 0.9rem;
  cursor: pointer;
}

.profile-subnav-tab.active {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #fff;
}

.profile-subnav-tab.admin-tab {
  margin-left: auto;
  border-color: #c7d2fe;
  background: #eef2ff;
  color: #3730a3;
}

.profile-stats-wrap {
  width: 100%;
}

.profile-card {
  max-width: 560px;
  margin: 0.75rem auto;
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

.genre-add-form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.genre-add-form .ds-input {
  flex: 1 1 200px;
}

.genre-add-submit {
  width: auto !important;
  padding: 0 1rem;
  white-space: nowrap;
}

.profile-genres-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.6rem;
}

.profile-genre-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: #f1f5f9;
  color: #0f172a;
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  padding: 0.28rem 0.65rem;
  font-size: 0.82rem;
  font-weight: 600;
}

.profile-genre-remove {
  background: none;
  border: none;
  color: #64748b;
  font-weight: 800;
  cursor: pointer;
  padding: 0 2px;
  font-size: 0.95rem;
  line-height: 1;
}

.profile-genre-remove:hover {
  color: #dc2626;
}

.delete-account-trigger {
  margin-top: 0.6rem;
  width: 100%;
  min-block-size: 40px;
  background: transparent;
  border-color: #fca5a5;
  color: #b91c1c;
  font-size: 0.85rem;
  font-weight: 700;
}

.delete-account-rules {
  margin: 0 0 0.75rem;
  padding-left: 1.15rem;
  font-size: 0.84rem;
  line-height: 1.45;
  color: #475569;
}
</style>
