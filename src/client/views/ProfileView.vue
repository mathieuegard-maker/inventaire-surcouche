<!-- src/client/views/ProfileView.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseModal from '../components/base/BaseModal.vue';
import { useAuthStore } from '../stores/auth.store';
import { useUiStore } from '../stores/ui.store';
import { ApiClientError } from '../api/client';
import { t } from '../../shared/locales';
import type { ThemeId } from '../../shared/types/domain.types';

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

    <!-- Onglet Notifications (Jalon 6) -->
    <div v-else class="ds-card ds-stack">
      <h2>{{ t('profile.tabNotifications') }}</h2>
      <p class="ds-text-muted">{{ t('profile.comingSoonNotifs') }}</p>
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
