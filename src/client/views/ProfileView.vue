<!-- src/client/views/ProfileView.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseModal from '../components/base/BaseModal.vue';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { apiRequest, ApiClientError } from '../api/client';
import { t } from '../../shared/locales';
import type { NotificationChannel, NotificationFrequency, ThemeId } from '../../shared/types/domain.types';

type ProfileTab = 'account' | 'stats' | 'genres' | 'notifications';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const uiStore = useUiStore();

const validTabs: ProfileTab[] = ['account', 'stats', 'genres', 'notifications'];

function resolveInitialTab(): ProfileTab {
  const raw = typeof route.query.tab === 'string' ? route.query.tab : 'account';
  return validTabs.includes(raw as ProfileTab) ? (raw as ProfileTab) : 'account';
}

const activeTab = ref<ProfileTab>(resolveInitialTab());

watch(
  () => route.query.tab,
  () => {
    activeTab.value = resolveInitialTab();
  }
);

function selectTab(tab: ProfileTab): void {
  activeTab.value = tab;
  void router.replace({ path: '/profile', query: tab === 'account' ? {} : { tab } });
}

// Formulaire identité
const username = ref(authStore.profile?.user.username ?? '');
const email = ref(authStore.profile?.user.email ?? '');
const currentPassword = ref('');
const newPassword = ref('');
const confirmNewPassword = ref('');
const savingProfile = ref(false);
const profileError = ref('');

watch(
  () => authStore.profile,
  (p) => {
    if (p) {
      username.value = p.user.username;
      email.value = p.user.email;
    }
  },
  { immediate: true }
);

// Thèmes
const themeOptions = computed<Array<{ id: ThemeId; label: string }>>(() => [
  { id: 'editorial-light', label: t('profile.themeLight') },
  { id: 'dark', label: t('profile.themeDark') },
  { id: 'warm', label: t('profile.themeWarm') }
]);

async function handleSelectTheme(theme: ThemeId): Promise<void> {
  authStore.applyTheme(theme);
  try {
    await authStore.updateProfile({ theme });
    uiStore.pushToast(t('profile.themeUpdated'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}

async function handleSaveProfile(): Promise<void> {
  profileError.value = '';
  if (newPassword.value && newPassword.value !== confirmNewPassword.value) {
    profileError.value = t('auth.passwordMismatch');
    return;
  }

  savingProfile.value = true;
  try {
    await authStore.updateProfile({
      username: username.value.trim(),
      email: email.value.trim(),
      currentPassword: currentPassword.value || undefined,
      newPassword: newPassword.value || undefined
    });
    currentPassword.value = '';
    newPassword.value = '';
    confirmNewPassword.value = '';
    uiStore.pushToast(t('profile.saved'), 'success');
  } catch (err) {
    profileError.value = err instanceof ApiClientError ? err.message : t('app.retry');
  } finally {
    savingProfile.value = false;
  }
}

// Genres par défaut
const newGenreInput = ref('');
const genresBusy = ref(false);

async function handleAddGenre(): Promise<void> {
  const clean = newGenreInput.value.trim();
  if (!clean) return;
  genresBusy.value = true;
  try {
    await authStore.updateDefaultGenres('add', clean);
    newGenreInput.value = '';
    uiStore.pushToast(t('profile.genresUpdated'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    genresBusy.value = false;
  }
}

async function handleRemoveGenre(genre: string): Promise<void> {
  genresBusy.value = true;
  try {
    await authStore.updateDefaultGenres('remove', genre);
    uiStore.pushToast(t('profile.genresUpdated'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    genresBusy.value = false;
  }
}

async function handleResetGenres(): Promise<void> {
  genresBusy.value = true;
  try {
    await authStore.updateDefaultGenres('reset');
    uiStore.pushToast(t('profile.genresResetSuccess'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    genresBusy.value = false;
  }
}

// Déconnexion & Suppression de compte
const deleteModalOpen = ref(false);
const deletePassword = ref('');
const deleteError = ref('');
const deletingAccount = ref(false);

async function handleLogout(): Promise<void> {
  await authStore.logout();
  await router.replace('/login');
}

function openDeleteModal(): void {
  deletePassword.value = '';
  deleteError.value = '';
  deleteModalOpen.value = true;
}

async function confirmDeleteAccount(): Promise<void> {
  deleteError.value = '';
  deletingAccount.value = true;
  try {
    await authStore.deleteAccount(deletePassword.value);
    deleteModalOpen.value = false;
    uiStore.pushToast(t('auth.accountDeleted'), 'info');
    await router.replace('/login');
  } catch (err) {
    deleteError.value = err instanceof ApiClientError ? err.message : t('app.retry');
  } finally {
    deletingAccount.value = false;
  }
}

function handleAdminClick(): void {
  uiStore.pushToast(t('profile.comingSoonAdmin'), 'info');
}

// Notifications & Web Push VAPID
const notifLoaded = ref(false);
const notifBusy = ref(false);
const notifFreq = ref<NotificationFrequency>('weekly');
const notifDayOfWeek = ref(6);
const notifDayOfMonth = ref(1);
const notifHour = ref(9);
const notifTimezone = ref('Europe/Paris');
const notifChannel = ref<NotificationChannel>('push');
const vapidPublicKey = ref('');
const hasPushSub = ref(false);

const weekdayOptions = computed(() => [
  { value: 0, label: t('profile.weekday0') },
  { value: 1, label: t('profile.weekday1') },
  { value: 2, label: t('profile.weekday2') },
  { value: 3, label: t('profile.weekday3') },
  { value: 4, label: t('profile.weekday4') },
  { value: 5, label: t('profile.weekday5') },
  { value: 6, label: t('profile.weekday6') }
]);

async function loadNotificationPrefs(): Promise<void> {
  if (notifLoaded.value) return;
  try {
    const res = await apiRequest<{
      ok: true;
      prefs: {
        frequency: NotificationFrequency;
        dayOfWeek: number;
        dayOfMonth: number;
        hour: number;
        timezone: string;
        channel: NotificationChannel;
        vapidPublicKey: string;
        hasPushSubscription: boolean;
      };
    }>('/api/notifications/prefs');
    notifFreq.value = res.prefs.frequency;
    notifDayOfWeek.value = res.prefs.dayOfWeek;
    notifDayOfMonth.value = res.prefs.dayOfMonth;
    notifHour.value = res.prefs.hour;
    notifTimezone.value = res.prefs.timezone;
    notifChannel.value = res.prefs.channel;
    vapidPublicKey.value = res.prefs.vapidPublicKey;
    hasPushSub.value = res.prefs.hasPushSubscription;
    notifLoaded.value = true;
  } catch {
    // ignore
  }
}

watch(
  activeTab,
  (tab) => {
    if (tab === 'notifications') {
      void loadNotificationPrefs();
    }
  },
  { immediate: true }
);

async function saveNotificationPrefs(): Promise<void> {
  notifBusy.value = true;
  try {
    await apiRequest('/api/notifications/prefs', {
      method: 'PUT',
      body: {
        frequency: notifFreq.value,
        dayOfWeek: notifDayOfWeek.value,
        dayOfMonth: notifDayOfMonth.value,
        hour: notifHour.value,
        timezone: notifTimezone.value,
        channel: notifChannel.value
      }
    });
    uiStore.pushToast(t('profile.notifSavedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    notifBusy.value = false;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

async function enableWebPush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !vapidPublicKey.value) {
    uiStore.pushToast(t('profile.notifPushNotSupported'), 'warning');
    return;
  }
  notifBusy.value = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const keyBytes = urlBase64ToUint8Array(vapidPublicKey.value);
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes.buffer as ArrayBuffer
    });
    const json = sub.toJSON();
    if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
      await apiRequest('/api/notifications/push', {
        method: 'POST',
        body: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
        }
      });
      hasPushSub.value = true;
      uiStore.pushToast(t('profile.notifPushEnabledToast'), 'success');
    }
  } catch {
    uiStore.pushToast(t('profile.notifPushNotSupported'), 'warning');
  } finally {
    notifBusy.value = false;
  }
}

async function disableWebPush(): Promise<void> {
  notifBusy.value = true;
  try {
    let endpoint: string | undefined;
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe();
      }
    }
    await apiRequest('/api/notifications/push', {
      method: 'DELETE',
      body: { endpoint }
    });
    hasPushSub.value = false;
    uiStore.pushToast(t('profile.notifPushDisabledToast'), 'info');
  } finally {
    notifBusy.value = false;
  }
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-row ds-row--between">
      <h1>{{ t('profile.title') }}</h1>
      <div v-if="authStore.isAdmin" class="ds-row">
        <span class="ds-badge ds-badge--accent">{{ t('profile.adminBadge') }}</span>
        <button type="button" class="ds-btn ds-btn--sm" @click="handleAdminClick">
          {{ t('nav.admin') }}
        </button>
      </div>
    </div>

    <div class="ds-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'account' }"
        :aria-selected="activeTab === 'account'"
        @click="selectTab('account')"
      >
        {{ t('profile.tabAccount') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'genres' }"
        :aria-selected="activeTab === 'genres'"
        @click="selectTab('genres')"
      >
        {{ t('profile.tabGenres') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'stats' }"
        :aria-selected="activeTab === 'stats'"
        @click="selectTab('stats')"
      >
        {{ t('profile.tabStats') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'notifications' }"
        :aria-selected="activeTab === 'notifications'"
        @click="selectTab('notifications')"
      >
        {{ t('profile.tabNotifications') }}
      </button>
    </div>

    <!-- Onglet Compte & Thème -->
    <div v-if="activeTab === 'account'" class="ds-stack">
      <div class="ds-card ds-stack">
        <h2>{{ t('profile.themeLabel') }}</h2>
        <div class="ds-grid-3">
          <button
            v-for="themeOpt in themeOptions"
            :key="themeOpt.id"
            type="button"
            class="theme-card"
            :class="{ 'theme-card--active': authStore.activeTheme === themeOpt.id }"
            @click="handleSelectTheme(themeOpt.id)"
          >
            <span>{{ themeOpt.label }}</span>
          </button>
        </div>
      </div>

      <div class="ds-card">
        <h2 class="profile-section-title">{{ t('profile.identitySectionTitle') }}</h2>
        <p class="ds-text-muted profile-hint">{{ t('profile.identityHint') }}</p>

        <div v-if="profileError" class="ds-banner ds-banner--danger" role="alert">
          {{ profileError }}
        </div>

        <form @submit.prevent="handleSaveProfile">
          <div class="ds-grid-2">
            <div class="ds-field">
              <label class="ds-label" for="prof-username">{{ t('auth.usernameLabel') }}</label>
              <input id="prof-username" v-model="username" type="text" class="ds-input" required />
            </div>

            <div class="ds-field">
              <label class="ds-label" for="prof-email">{{ t('auth.emailLabel') }}</label>
              <input id="prof-email" v-model="email" type="email" class="ds-input" required />
            </div>
          </div>

          <div class="ds-field">
            <label class="ds-label" for="prof-current-pwd">{{ t('auth.currentPasswordLabel') }}</label>
            <input
              id="prof-current-pwd"
              v-model="currentPassword"
              type="password"
              class="ds-input"
              autocomplete="current-password"
            />
          </div>

          <div class="ds-grid-2">
            <div class="ds-field">
              <label class="ds-label" for="prof-new-pwd">{{ t('auth.newPasswordLabel') }}</label>
              <input
                id="prof-new-pwd"
                v-model="newPassword"
                type="password"
                class="ds-input"
                autocomplete="new-password"
                minlength="8"
              />
            </div>

            <div class="ds-field">
              <label class="ds-label" for="prof-confirm-pwd">{{ t('auth.confirmPasswordLabel') }}</label>
              <input
                id="prof-confirm-pwd"
                v-model="confirmNewPassword"
                type="password"
                class="ds-input"
                autocomplete="new-password"
                minlength="8"
              />
            </div>
          </div>

          <div class="ds-row profile-actions-end">
            <button type="submit" class="ds-btn ds-btn--primary" :disabled="savingProfile">
              {{ savingProfile ? t('app.loading') : t('app.save') }}
            </button>
          </div>
        </form>
      </div>

      <div class="ds-card ds-stack">
        <h2>{{ t('profile.dangerZoneTitle') }}</h2>
        <div class="ds-row ds-row--between">
          <button type="button" class="ds-btn" @click="handleLogout">
            {{ t('auth.logoutBtn') }}
          </button>
          <button type="button" class="ds-btn ds-btn--danger" @click="openDeleteModal">
            {{ t('auth.deleteAccountBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Onglet Genres par défaut -->
    <div v-else-if="activeTab === 'genres'" class="ds-card ds-stack">
      <div class="ds-row ds-row--between">
        <h2>{{ t('profile.tabGenres') }}</h2>
        <button type="button" class="ds-btn ds-btn--sm" :disabled="genresBusy" @click="handleResetGenres">
          {{ t('profile.resetDefaultGenresBtn') }}
        </button>
      </div>

      <form class="ds-row" @submit.prevent="handleAddGenre">
        <input
          v-model="newGenreInput"
          type="text"
          class="ds-input genres-input"
          :placeholder="t('profile.genresAddPlaceholder')"
        />
        <button type="submit" class="ds-btn ds-btn--primary" :disabled="genresBusy || !newGenreInput.trim()">
          {{ t('profile.genresAddBtn') }}
        </button>
      </form>

      <div class="ds-chips">
        <span v-for="genre in authStore.profile?.defaultGenres ?? []" :key="genre" class="ds-chip">
          <span>{{ genre }}</span>
          <button
            type="button"
            class="ds-chip__remove"
            :aria-label="t('app.delete')"
            :disabled="genresBusy"
            @click="handleRemoveGenre(genre)"
          >
            ×
          </button>
        </span>
      </div>
    </div>

    <!-- Onglet Statistiques (Jalon 7) -->
    <div v-else-if="activeTab === 'stats'" class="ds-card ds-stack">
      <h2>{{ t('profile.tabStats') }}</h2>
      <p class="ds-text-muted">{{ t('profile.comingSoonStats') }}</p>
    </div>

    <!-- Onglet Notifications -->
    <div v-else class="ds-card ds-stack">
      <h2>{{ t('profile.tabNotifications') }}</h2>

      <form class="ds-stack" @submit.prevent="saveNotificationPrefs">
        <div class="ds-grid-2">
          <div class="ds-field">
            <label class="ds-label" for="notif-freq">{{ t('profile.notifFrequencyLabel') }}</label>
            <select id="notif-freq" v-model="notifFreq" class="ds-input">
              <option value="off">{{ t('profile.notifOff') }}</option>
              <option value="daily">{{ t('profile.notifDaily') }}</option>
              <option value="weekly">{{ t('profile.notifWeekly') }}</option>
              <option value="monthly">{{ t('profile.notifMonthly') }}</option>
            </select>
          </div>

          <div class="ds-field">
            <label class="ds-label" for="notif-channel">{{ t('profile.notifChannelLabel') }}</label>
            <select id="notif-channel" v-model="notifChannel" class="ds-input">
              <option value="push">{{ t('profile.notifChannelPush') }}</option>
              <option value="email">{{ t('profile.notifChannelEmail') }}</option>
              <option value="both">{{ t('profile.notifChannelBoth') }}</option>
            </select>
          </div>
        </div>

        <div v-if="notifFreq !== 'off'" class="ds-grid-3">
          <div v-if="notifFreq === 'weekly'" class="ds-field">
            <label class="ds-label" for="notif-dow">{{ t('profile.notifDayOfWeekLabel') }}</label>
            <select id="notif-dow" v-model.number="notifDayOfWeek" class="ds-input">
              <option v-for="w in weekdayOptions" :key="w.value" :value="w.value">{{ w.label }}</option>
            </select>
          </div>

          <div v-if="notifFreq === 'monthly'" class="ds-field">
            <label class="ds-label" for="notif-dom">{{ t('profile.notifDayOfMonthLabel') }}</label>
            <input id="notif-dom" v-model.number="notifDayOfMonth" type="number" min="1" max="28" class="ds-input" />
          </div>

          <div class="ds-field">
            <label class="ds-label" for="notif-hour">{{ t('profile.notifHourLabel') }}</label>
            <input id="notif-hour" v-model.number="notifHour" type="number" min="0" max="23" class="ds-input" />
          </div>

          <div class="ds-field">
            <label class="ds-label" for="notif-tz">{{ t('profile.notifTimezoneLabel') }}</label>
            <input id="notif-tz" v-model="notifTimezone" type="text" class="ds-input" />
          </div>
        </div>

        <div class="ds-panel ds-row ds-row--between">
          <span v-if="hasPushSub" class="ds-badge ds-badge--accent">{{ t('profile.notifPushActive') }}</span>
          <span v-else class="ds-text-muted">{{ t('profile.notifChannelPush') }}</span>

          <button
            v-if="hasPushSub"
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="notifBusy"
            @click="disableWebPush"
          >
            {{ t('profile.notifPushDisableBtn') }}
          </button>
          <button
            v-else
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="notifBusy"
            @click="enableWebPush"
          >
            {{ t('profile.notifPushEnableBtn') }}
          </button>
        </div>

        <div class="ds-row profile-actions-end">
          <button type="submit" class="ds-btn ds-btn--primary" :disabled="notifBusy">
            {{ notifBusy ? t('app.loading') : t('profile.saveNotifsBtn') }}
          </button>
        </div>
      </form>
    </div>

    <!-- Modale de confirmation de suppression définitive -->
    <BaseModal
      :open="deleteModalOpen"
      :title="t('auth.deleteAccountConfirmTitle')"
      @close="deleteModalOpen = false"
    >
      <div class="ds-stack">
        <p>{{ t('auth.deleteAccountConfirmDesc') }}</p>
        <div v-if="deleteError" class="ds-banner ds-banner--danger" role="alert">
          {{ deleteError }}
        </div>
        <div class="ds-field">
          <label class="ds-label" for="delete-account-pwd">{{ t('auth.deletePasswordPrompt') }}</label>
          <input
            id="delete-account-pwd"
            v-model="deletePassword"
            type="password"
            class="ds-input"
            autocomplete="current-password"
            required
          />
        </div>
      </div>

      <template #footer>
        <button type="button" class="ds-btn" :disabled="deletingAccount" @click="deleteModalOpen = false">
          {{ t('app.cancel') }}
        </button>
        <button
          type="button"
          class="ds-btn ds-btn--danger"
          :disabled="deletingAccount || !deletePassword"
          @click="confirmDeleteAccount"
        >
          {{ deletingAccount ? t('app.loading') : t('app.confirm') }}
        </button>
      </template>
    </BaseModal>
  </section>
</template>

<style scoped>
.profile-section-title {
  margin-bottom: var(--space-1);
}

.profile-hint {
  margin-bottom: var(--space-4);
}

.profile-actions-end {
  justify-content: flex-end;
}

.theme-card {
  padding: var(--space-4);
  border-radius: var(--radius-md);
  border: 2px solid var(--border-subtle);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.theme-card--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.genres-input {
  flex: 1;
  min-width: 200px;
}
</style>
