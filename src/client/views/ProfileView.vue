<!-- src/client/views/ProfileView.vue -->
<!-- Mon Profil (V2.6 mobile-first) : Déconnexion en haut à côté du titre, onglets séparés
     (Identité & Sécurité, Apparence, Mes genres avec tri tactile SortableJS, Statistiques, Notifications). -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Sortable from 'sortablejs';
import {
  BarChart3,
  Bell,
  Copy,
  Download,
  GripVertical,
  LogOut,
  Mail,
  Palette,
  RotateCcw,
  ScanBarcode,
  Shield,
  Tags,
  Trash2,
  User
} from '@lucide/vue';
import BaseModal from '../components/base/BaseModal.vue';
import ContactModal from '../components/contact/ContactModal.vue';
import CollectionImportPanel from '../components/import/CollectionImportPanel.vue';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { apiRequest, ApiClientError } from '../api/client';
import { t } from '../../shared/locales';
import type {
  NotificationChannel,
  NotificationFrequency,
  ThemeId
} from '../../shared/types/domain.types';

type ProfileTab = 'account' | 'appearance' | 'genres' | 'stats' | 'notifications';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const uiStore = useUiStore();

const validTabs: ProfileTab[] = ['account', 'appearance', 'genres', 'stats', 'notifications'];

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

// ==================== IDENTITÉ & SÉCURITÉ ====================
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

// ==================== APPARENCE (THÈMES) ====================
interface ThemeChoiceItem {
  id: ThemeId;
  label: string;
  desc: string;
}

const proThemeOptions = computed<ThemeChoiceItem[]>(() => [
  { id: 'librairie', label: t('profile.themeLibrairie'), desc: t('profile.themeLibrairieDesc') },
  { id: 'studio', label: t('profile.themeStudio'), desc: t('profile.themeStudioDesc') },
  { id: 'atelier-bd', label: t('profile.themeAtelierBd'), desc: t('profile.themeAtelierBdDesc') },
  { id: 'nocturne', label: t('profile.themeNocturne'), desc: t('profile.themeNocturneDesc') }
]);

const classicThemeOptions = computed<ThemeChoiceItem[]>(() => [
  { id: 'editorial-light', label: t('profile.themeLight'), desc: t('profile.themeLightDesc') },
  { id: 'dark', label: t('profile.themeDark'), desc: t('profile.themeDarkDesc') },
  { id: 'warm', label: t('profile.themeWarm'), desc: t('profile.themeWarmDesc') }
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

// ==================== MES GENRES (AVEC RÉORDONNANCEMENT TACTILE SORTABLEJS) ====================
const newGenreInput = ref('');
const genresBusy = ref(false);
const genresListRef = ref<HTMLElement | null>(null);
let genresSortable: Sortable | null = null;

function destroyGenresSortable(): void {
  if (genresSortable) {
    genresSortable.destroy();
    genresSortable = null;
  }
}

function initGenresSortable(): void {
  destroyGenresSortable();
  if (activeTab.value !== 'genres' || !genresListRef.value) return;

  genresSortable = Sortable.create(genresListRef.value, {
    animation: 180,
    delay: 200,
    delayOnTouchOnly: true,
    touchStartThreshold: 6,
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    swapThreshold: 0.65,
    ghostClass: 'genre-chip--ghost',
    chosenClass: 'genre-chip--chosen',
    fallbackClass: 'genre-chip--dragging',
    filter: '.ds-chip__remove',
    preventOnFilter: false,
    onEnd: (evt) => {
      const oldIdx = evt.oldIndex;
      const newIdx = evt.newIndex;
      if (oldIdx === undefined || newIdx === undefined || oldIdx === newIdx) return;
      const current = [...(authStore.profile?.defaultGenres ?? [])];
      if (oldIdx < 0 || oldIdx >= current.length || newIdx < 0 || newIdx >= current.length) return;
      const [moved] = current.splice(oldIdx, 1);
      current.splice(newIdx, 0, moved);
      void persistGenresOrder(current);
    }
  });
}

async function persistGenresOrder(nextOrder: string[]): Promise<void> {
  if (authStore.profile) {
    authStore.profile = { ...authStore.profile, defaultGenres: nextOrder };
  }
  genresBusy.value = true;
  try {
    await authStore.reorderDefaultGenres(nextOrder);
    uiStore.pushToast(t('profile.genresReorderedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    genresBusy.value = false;
  }
}

watch(
  [activeTab, genresListRef],
  async ([tab]) => {
    if (tab === 'genres') {
      await nextTick();
      initGenresSortable();
    } else {
      destroyGenresSortable();
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  destroyGenresSortable();
});

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

// ==================== DÉCONNEXION, CONTACT & SUPPRESSION DE COMPTE ====================
const contactModalOpen = ref(false);
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
  void router.push('/admin');
}

function handleOpenQuickCheck(): void {
  void router.push('/check');
}

async function copyQuickCheckUrl(): Promise<void> {
  if (typeof window === 'undefined') return;
  const url = `${window.location.origin}/check`;
  try {
    await navigator.clipboard.writeText(url);
    uiStore.pushToast(t('profile.quickShortcutUrlCopied'), 'success');
  } catch {
    uiStore.pushToast(t('app.retry'), 'warning');
  }
}

// ==================== STATISTIQUES & EXPORT CSV/JSON ====================
interface RankedStatItem {
  label: string;
  count: number;
}

interface LibraryStatsData {
  periodDays: number | null;
  kpis: {
    ownedCount: number;
    coveredVolumesCount?: number;
    wishedCount: number;
    lentCount: number;
    seriesCount: number;
    addedInPeriodCount: number;
    totalPages: number;
  };
  reading: {
    readCount: number;
    readingCount: number;
    toReadCount: number;
    abandonedCount: number;
    ratedCount: number;
    averageRating: number | null;
  };
  tops: {
    genres: RankedStatItem[];
    authors: RankedStatItem[];
    series: RankedStatItem[];
    publishers: RankedStatItem[];
  };
  activeLoans: Array<{
    bookId: string;
    title: string;
    borrowerName: string;
    loanedAt: string;
  }>;
}

const statsPeriod = ref<string>('30');
const statsLoading = ref(false);
const statsData = ref<LibraryStatsData | null>(null);

async function loadStats(): Promise<void> {
  statsLoading.value = true;
  try {
    const query = statsPeriod.value === 'all' ? '' : `?periodDays=${encodeURIComponent(statsPeriod.value)}`;
    const res = await apiRequest<{ ok: true; stats: LibraryStatsData }>(`/api/stats${query}`);
    statsData.value = res.stats;
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    statsLoading.value = false;
  }
}

function triggerExport(format: 'csv' | 'json'): void {
  window.location.href = `/api/me/export?format=${format}`;
}

function navigateToCollectionFilter(q: string): void {
  void router.push({ path: '/collection', query: { q } });
}

function navigateToCollectionGenre(genre: string): void {
  void router.push({ path: '/collection', query: { genre } });
}

function navigateToAuthor(authorName: string): void {
  void router.push(`/author/${encodeURIComponent(authorName)}`);
}

// ==================== NOTIFICATIONS & WEB PUSH VAPID ====================
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
    } else if (tab === 'stats') {
      void loadStats();
    }
  },
  { immediate: true }
);

watch(statsPeriod, () => {
  if (activeTab.value === 'stats') {
    void loadStats();
  }
});

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
    <div class="ds-page-head profile-page-head">
      <h1>{{ t('profile.title') }}</h1>
      <button type="button" class="ds-btn ds-btn--sm profile-logout-btn" @click="handleLogout">
        <LogOut :size="15" aria-hidden="true" />
        {{ t('auth.logoutBtn') }}
      </button>
    </div>

    <div class="profile-tabs-grid" role="tablist">
      <button
        type="button"
        role="tab"
        class="profile-tab-btn"
        :class="{ 'profile-tab-btn--active': activeTab === 'account' }"
        :aria-selected="activeTab === 'account'"
        @click="selectTab('account')"
      >
        <User :size="16" aria-hidden="true" />
        <span>{{ t('profile.tabAccount') }}</span>
      </button>

      <button
        type="button"
        role="tab"
        class="profile-tab-btn"
        :class="{ 'profile-tab-btn--active': activeTab === 'appearance' }"
        :aria-selected="activeTab === 'appearance'"
        @click="selectTab('appearance')"
      >
        <Palette :size="16" aria-hidden="true" />
        <span>{{ t('profile.tabAppearance') }}</span>
      </button>

      <button
        type="button"
        role="tab"
        class="profile-tab-btn"
        :class="{ 'profile-tab-btn--active': activeTab === 'genres' }"
        :aria-selected="activeTab === 'genres'"
        @click="selectTab('genres')"
      >
        <Tags :size="16" aria-hidden="true" />
        <span>{{ t('profile.tabGenres') }}</span>
      </button>

      <button
        type="button"
        role="tab"
        class="profile-tab-btn"
        :class="{ 'profile-tab-btn--active': activeTab === 'stats' }"
        :aria-selected="activeTab === 'stats'"
        @click="selectTab('stats')"
      >
        <BarChart3 :size="16" aria-hidden="true" />
        <span>{{ t('profile.tabStats') }}</span>
      </button>

      <button
        type="button"
        role="tab"
        class="profile-tab-btn"
        :class="{ 'profile-tab-btn--active': activeTab === 'notifications' }"
        :aria-selected="activeTab === 'notifications'"
        @click="selectTab('notifications')"
      >
        <Bell :size="16" aria-hidden="true" />
        <span>{{ t('profile.tabNotifications') }}</span>
      </button>
    </div>

    <!-- ==================== ONGLET 1 : IDENTITÉ & SÉCURITÉ ==================== -->
    <div v-if="activeTab === 'account'" class="ds-stack">
      <div class="ds-card ds-stack">
        <div>
          <h2 class="profile-section-title">{{ t('profile.identitySectionTitle') }}</h2>
          <p class="ds-text-muted">{{ t('profile.identityHint') }}</p>
        </div>

        <div v-if="profileError" class="ds-banner ds-banner--danger" role="alert">
          {{ profileError }}
        </div>

        <form class="ds-stack--sm" @submit.prevent="handleSaveProfile">
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

      <div v-if="authStore.isAdmin" class="ds-card ds-row ds-row--between">
        <div class="ds-row">
          <Shield :size="18" aria-hidden="true" />
          <strong>{{ t('nav.admin') }}</strong>
        </div>
        <button type="button" class="ds-btn ds-btn--soft ds-btn--sm" @click="handleAdminClick">
          {{ t('nav.admin') }}
        </button>
      </div>

      <div class="ds-card ds-stack">
        <div class="ds-row">
          <ScanBarcode :size="18" aria-hidden="true" />
          <h2>{{ t('profile.quickShortcutTitle') }}</h2>
        </div>
        <p class="ds-text-muted">{{ t('profile.quickShortcutDesc') }}</p>

        <div class="ds-stack--sm">
          <div class="ds-panel quick-shortcut-step">
            <strong>{{ t('profile.quickShortcutMethod1Title') }}</strong>
            <p class="ds-text-muted">{{ t('profile.quickShortcutMethod1Steps') }}</p>
          </div>
          <div class="ds-panel quick-shortcut-step">
            <strong>{{ t('profile.quickShortcutMethod2Title') }}</strong>
            <p class="ds-text-muted">{{ t('profile.quickShortcutMethod2Steps') }}</p>
          </div>
          <div class="ds-panel quick-shortcut-step">
            <strong>{{ t('profile.quickShortcutMethod3Title') }}</strong>
            <p class="ds-text-muted">{{ t('profile.quickShortcutMethod3Steps') }}</p>
          </div>
        </div>

        <div class="ds-row">
          <button type="button" class="ds-btn ds-btn--primary ds-btn--sm" @click="handleOpenQuickCheck">
            <ScanBarcode :size="15" aria-hidden="true" />
            {{ t('profile.quickShortcutTestBtn') }}
          </button>
          <button type="button" class="ds-btn ds-btn--sm" @click="copyQuickCheckUrl">
            <Copy :size="15" aria-hidden="true" />
            {{ t('profile.quickShortcutCopyUrlBtn') }}
          </button>
        </div>
      </div>

      <div class="ds-card ds-stack">
        <h2>{{ t('profile.exportTitle') }}</h2>
        <p class="ds-text-muted">{{ t('profile.exportDesc') }}</p>
        <div class="ds-row">
          <button type="button" class="ds-btn" @click="triggerExport('csv')">
            <Download :size="15" aria-hidden="true" />
            {{ t('profile.exportCsvBtn') }}
          </button>
          <button type="button" class="ds-btn" @click="triggerExport('json')">
            <Download :size="15" aria-hidden="true" />
            {{ t('profile.exportJsonBtn') }}
          </button>
        </div>
      </div>

      <CollectionImportPanel id-prefix="prof-import" />

      <div class="ds-card ds-stack">
        <div class="ds-row">
          <Mail :size="18" aria-hidden="true" />
          <h2>{{ t('contact.profileCardTitle') }}</h2>
        </div>
        <p class="ds-text-muted">{{ t('contact.profileCardDesc') }}</p>
        <div class="ds-row">
          <button type="button" class="ds-btn" @click="contactModalOpen = true">
            <Mail :size="15" aria-hidden="true" />
            {{ t('contact.openBtn') }}
          </button>
        </div>
      </div>

      <div class="ds-card ds-stack">
        <h2>{{ t('profile.dangerZoneTitle') }}</h2>
        <div class="ds-row">
          <button type="button" class="ds-btn ds-btn--danger" @click="openDeleteModal">
            <Trash2 :size="15" aria-hidden="true" />
            {{ t('auth.deleteAccountBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== ONGLET 2 : APPARENCE ==================== -->
    <div v-else-if="activeTab === 'appearance'" class="ds-stack">
      <div class="ds-card ds-stack">
        <h2>{{ t('profile.themeProGroupTitle') }}</h2>
        <div class="theme-cards-grid">
          <button
            v-for="themeOpt in proThemeOptions"
            :key="themeOpt.id"
            type="button"
            class="theme-card"
            :class="{ 'theme-card--active': authStore.activeTheme === themeOpt.id }"
            @click="handleSelectTheme(themeOpt.id)"
          >
            <span class="theme-card__preview" :data-theme="themeOpt.id" aria-hidden="true">
              <span class="theme-card__mini-card">
                <span class="theme-card__mini-title">Aa</span>
                <span class="theme-card__mini-lines">
                  <span class="theme-card__line" />
                  <span class="theme-card__line theme-card__line--short" />
                </span>
                <span class="theme-card__dot" />
              </span>
            </span>
            <strong class="theme-card__name">{{ themeOpt.label }}</strong>
            <span class="theme-card__desc">{{ themeOpt.desc }}</span>
          </button>
        </div>
      </div>

      <div class="ds-card ds-stack">
        <h2>{{ t('profile.themeClassicGroupTitle') }}</h2>
        <div class="theme-cards-grid">
          <button
            v-for="themeOpt in classicThemeOptions"
            :key="themeOpt.id"
            type="button"
            class="theme-card"
            :class="{ 'theme-card--active': authStore.activeTheme === themeOpt.id }"
            @click="handleSelectTheme(themeOpt.id)"
          >
            <span class="theme-card__preview" :data-theme="themeOpt.id" aria-hidden="true">
              <span class="theme-card__mini-card">
                <span class="theme-card__mini-title">Aa</span>
                <span class="theme-card__mini-lines">
                  <span class="theme-card__line" />
                  <span class="theme-card__line theme-card__line--short" />
                </span>
                <span class="theme-card__dot" />
              </span>
            </span>
            <strong class="theme-card__name">{{ themeOpt.label }}</strong>
            <span class="theme-card__desc">{{ themeOpt.desc }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== ONGLET 3 : MES GENRES (SORTABLEJS) ==================== -->
    <div v-else-if="activeTab === 'genres'" class="ds-card ds-stack">
      <div class="ds-row ds-row--between">
        <h2>{{ t('profile.tabGenres') }}</h2>
        <button type="button" class="ds-btn ds-btn--sm" :disabled="genresBusy" @click="handleResetGenres">
          <RotateCcw :size="14" aria-hidden="true" />
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

      <p class="ds-text-muted genres-hint">{{ t('profile.genresReorderHint') }}</p>

      <div ref="genresListRef" class="ds-chips genres-sortable-list">
        <span
          v-for="genre in authStore.profile?.defaultGenres ?? []"
          :key="genre"
          class="ds-chip genre-chip"
        >
          <GripVertical :size="14" class="genre-chip__grip" aria-hidden="true" />
          <span>{{ genre }}</span>
          <button
            type="button"
            class="ds-chip__remove"
            :aria-label="t('app.delete')"
            :disabled="genresBusy"
            @click.stop="handleRemoveGenre(genre)"
          >
            ×
          </button>
        </span>
      </div>
    </div>

    <!-- ==================== ONGLET 4 : STATISTIQUES ==================== -->
    <div v-else-if="activeTab === 'stats'" class="ds-stack">
      <div class="ds-card ds-row ds-row--between stats-toolbar">
        <h2>{{ t('profile.tabStats') }}</h2>
        <div class="ds-row">
          <select v-model="statsPeriod" class="ds-input stats-period-select">
            <option value="30">{{ t('profile.statsPeriod30') }}</option>
            <option value="90">{{ t('profile.statsPeriod90') }}</option>
            <option value="365">{{ t('profile.statsPeriod365') }}</option>
            <option value="all">{{ t('profile.statsPeriodAll') }}</option>
          </select>
          <button type="button" class="ds-btn ds-btn--sm" @click="triggerExport('csv')">
            {{ t('profile.exportCsvBtn') }}
          </button>
          <button type="button" class="ds-btn ds-btn--sm" @click="triggerExport('json')">
            {{ t('profile.exportJsonBtn') }}
          </button>
        </div>
      </div>

      <p v-if="statsLoading && !statsData" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>

      <template v-else-if="statsData">
        <div class="stats-kpi-grid">
          <router-link to="/collection" class="ds-card stats-kpi-card">
            <span class="ds-text-muted">{{ t('profile.statsKpiOwned') }}</span>
            <strong class="stats-kpi-value">{{ statsData.kpis.ownedCount }}</strong>
            <small
              v-if="statsData.kpis.coveredVolumesCount && statsData.kpis.coveredVolumesCount > statsData.kpis.ownedCount"
              class="ds-text-muted"
            >
              {{ t('profile.statsKpiCoveredSub', { count: statsData.kpis.coveredVolumesCount }) }}
            </small>
          </router-link>
          <router-link to="/wishlist" class="ds-card stats-kpi-card">
            <span class="ds-text-muted">{{ t('profile.statsKpiWish') }}</span>
            <strong class="stats-kpi-value">{{ statsData.kpis.wishedCount }}</strong>
          </router-link>
          <router-link to="/loans" class="ds-card stats-kpi-card">
            <span class="ds-text-muted">{{ t('profile.statsKpiLent') }}</span>
            <strong class="stats-kpi-value">{{ statsData.kpis.lentCount }}</strong>
          </router-link>
          <router-link :to="{ path: '/collection', query: { mode: 'series' } }" class="ds-card stats-kpi-card">
            <span class="ds-text-muted">{{ t('profile.statsKpiSeries') }}</span>
            <strong class="stats-kpi-value">{{ statsData.kpis.seriesCount }}</strong>
          </router-link>
        </div>

        <div class="ds-card ds-row ds-row--between stats-meta-bar">
          <span>{{ t('profile.statsAddedInPeriod', { count: statsData.kpis.addedInPeriodCount }) }}</span>
          <span>{{ t('profile.statsTotalPages', { count: statsData.kpis.totalPages }) }}</span>
        </div>

        <div class="ds-card ds-stack">
          <h3>{{ t('profile.statsReadingTitle') }}</h3>
          <div class="ds-chips">
            <span class="ds-chip">{{ t('book.readingRead') }} : {{ statsData.reading.readCount }}</span>
            <span class="ds-chip">{{ t('book.readingInProgress') }} : {{ statsData.reading.readingCount }}</span>
            <span class="ds-chip">{{ t('book.readingToRead') }} : {{ statsData.reading.toReadCount }}</span>
            <span class="ds-chip">{{ t('book.readingAbandoned') }} : {{ statsData.reading.abandonedCount }}</span>
          </div>
          <p class="ds-text-muted">
            {{
              statsData.reading.averageRating !== null
                ? t('profile.statsAvgRating', {
                    avg: statsData.reading.averageRating,
                    count: statsData.reading.ratedCount
                  })
                : t('profile.statsNoRating')
            }}
          </p>
        </div>

        <div class="ds-grid-2">
          <div class="ds-card ds-stack">
            <h3>{{ t('profile.statsTopGenres') }}</h3>
            <p v-if="statsData.tops.genres.length === 0" class="ds-text-muted">{{ t('profile.statsEmptySection') }}</p>
            <div v-else class="ds-stack--sm">
              <button
                v-for="item in statsData.tops.genres"
                :key="item.label"
                type="button"
                class="ds-panel ds-row ds-row--between stats-rank-btn"
                @click="navigateToCollectionGenre(item.label)"
              >
                <span>{{ item.label }}</span>
                <span class="ds-badge">{{ item.count }}</span>
              </button>
            </div>
          </div>

          <div class="ds-card ds-stack">
            <h3>{{ t('profile.statsTopAuthors') }}</h3>
            <p v-if="statsData.tops.authors.length === 0" class="ds-text-muted">{{ t('profile.statsEmptySection') }}</p>
            <div v-else class="ds-stack--sm">
              <button
                v-for="item in statsData.tops.authors"
                :key="item.label"
                type="button"
                class="ds-panel ds-row ds-row--between stats-rank-btn"
                @click="navigateToAuthor(item.label)"
              >
                <span>{{ item.label }}</span>
                <span class="ds-badge">{{ item.count }}</span>
              </button>
            </div>
          </div>

          <div class="ds-card ds-stack">
            <h3>{{ t('profile.statsTopSeries') }}</h3>
            <p v-if="statsData.tops.series.length === 0" class="ds-text-muted">{{ t('profile.statsEmptySection') }}</p>
            <div v-else class="ds-stack--sm">
              <button
                v-for="item in statsData.tops.series"
                :key="item.label"
                type="button"
                class="ds-panel ds-row ds-row--between stats-rank-btn"
                @click="navigateToCollectionFilter(item.label)"
              >
                <span>{{ item.label }}</span>
                <span class="ds-badge">{{ item.count }}</span>
              </button>
            </div>
          </div>

          <div class="ds-card ds-stack">
            <h3>{{ t('profile.statsTopPublishers') }}</h3>
            <p v-if="statsData.tops.publishers.length === 0" class="ds-text-muted">{{ t('profile.statsEmptySection') }}</p>
            <div v-else class="ds-stack--sm">
              <button
                v-for="item in statsData.tops.publishers"
                :key="item.label"
                type="button"
                class="ds-panel ds-row ds-row--between stats-rank-btn"
                @click="navigateToCollectionFilter(item.label)"
              >
                <span>{{ item.label }}</span>
                <span class="ds-badge">{{ item.count }}</span>
              </button>
            </div>
          </div>
        </div>

        <div v-if="statsData.activeLoans.length > 0" class="ds-card ds-stack">
          <h3>{{ t('profile.statsActiveLoansTitle', { count: statsData.activeLoans.length }) }}</h3>
          <div class="ds-stack--sm">
            <router-link
              v-for="loan in statsData.activeLoans"
              :key="loan.bookId"
              :to="`/book/${loan.bookId}`"
              class="ds-panel ds-row ds-row--between stats-rank-btn"
            >
              <span>{{ loan.title }}</span>
              <span class="ds-badge">{{ t('loans.lentTo', { name: loan.borrowerName }) }}</span>
            </router-link>
          </div>
        </div>
      </template>
    </div>

    <!-- ==================== ONGLET 5 : NOTIFICATIONS ==================== -->
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
      max-width="460px"
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

    <ContactModal :open="contactModalOpen" @close="contactModalOpen = false" />
  </section>
</template>

<style scoped>
.profile-page-head {
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--space-2);
}

.profile-logout-btn {
  flex-shrink: 0;
  white-space: nowrap;
}

.profile-tabs-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.profile-tab-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-block-size: 40px;
  padding: 0.45rem 0.85rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.profile-tab-btn:hover {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}

.profile-tab-btn--active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-accent);
}

.profile-tab-btn--active:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: var(--text-on-accent);
}

.profile-section-title {
  margin-bottom: var(--space-1);
}

.profile-actions-end {
  justify-content: flex-end;
}

.quick-shortcut-step {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.quick-shortcut-step p {
  margin: 0;
  font-size: 0.84rem;
  line-height: 1.45;
}

.theme-cards-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3);
}

@media (min-width: 600px) {
  .theme-cards-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.theme-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  border: 2px solid var(--border-subtle);
  background: var(--bg-subtle);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, background-color 0.15s ease, transform 0.1s ease;
}

.theme-card:hover {
  border-color: var(--accent-border);
}

.theme-card--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.theme-card__preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 10px;
  border-radius: var(--radius-md);
  background: var(--bg-page);
  border: 1px solid var(--border-subtle);
}

.theme-card__mini-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  border: 1.5px solid var(--border-subtle);
  box-shadow: var(--shadow-sm);
}

.theme-card__mini-title {
  font-family: var(--font-heading);
  font-weight: 700;
  font-size: 1rem;
  color: var(--text-primary);
  flex-shrink: 0;
}

.theme-card__mini-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-inline-size: 0;
}

.theme-card__dot {
  width: 24px;
  height: 16px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  flex-shrink: 0;
}

.theme-card__line {
  width: 100%;
  height: 7px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.theme-card__line--short {
  width: 62%;
}

.theme-card__name {
  font-size: 0.95rem;
  color: var(--text-primary);
}

.theme-card__desc {
  font-size: 0.81rem;
  line-height: 1.38;
  color: var(--text-secondary);
}

.genres-input {
  flex: 1;
  min-width: 180px;
}

.genres-hint {
  font-size: 0.85rem;
  margin: 0;
}

.genres-sortable-list {
  gap: var(--space-2);
}

.genre-chip {
  cursor: grab;
  user-select: none;
  touch-action: manipulation;
  padding: 0.4rem 0.65rem;
  min-block-size: 38px;
}

.genre-chip__grip {
  color: var(--text-muted);
  flex-shrink: 0;
}

.genre-chip--ghost {
  opacity: 0.35;
  border-style: dashed;
  border-color: var(--accent);
}

.genre-chip--chosen {
  cursor: grabbing;
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: var(--shadow-md);
}

.genre-chip--dragging {
  opacity: 0.96;
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: var(--shadow-lg);
  transform: scale(1.04);
}

.stats-toolbar {
  flex-wrap: wrap;
  gap: var(--space-3);
}

.stats-period-select {
  width: auto;
}

.stats-kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

@media (min-width: 640px) {
  .stats-kpi-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.stats-kpi-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  text-decoration: none;
  color: var(--text-primary);
}

.stats-kpi-value {
  font-size: 1.75rem;
  color: var(--accent);
}

.stats-meta-bar {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.stats-rank-btn {
  width: 100%;
  cursor: pointer;
  color: var(--text-primary);
  text-decoration: none;
  text-align: left;
}
</style>
