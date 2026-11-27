// src/client/stores/auth.store.ts
// Store Pinia d'authentification, profil, foyer, thème et genres par défaut.

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { apiRequest } from '../api/client';
import { clearAllLocalCache } from '../cache/indexeddb';
import type { LibraryMemberRole, LocaleId, ThemeId } from '../../shared/types/domain.types';
import { setLocale } from '../../shared/locales';

export interface AuthProfile {
  user: {
    id: string;
    username: string;
    email: string;
    isAdmin: boolean;
    theme: ThemeId;
    locale: LocaleId;
    onboardingNotifSeen: boolean;
    createdAt: string;
  };
  library: {
    id: string;
    name: string;
    role: LibraryMemberRole;
    familyInviteCode: string;
    friendShareToken: string;
    members: Array<{
      userId: string;
      username: string;
      role: LibraryMemberRole;
      joinedAt: string;
    }>;
  };
  defaultGenres: string[];
  aiQuota: {
    monthKey: string;
    used: number;
    limit: number;
    remaining: number;
  };
  unreadAlertsCount: number;
}

const THEME_STORAGE_KEY = 'biblio_theme_v2';

export const useAuthStore = defineStore('auth', () => {
  const profile = ref<AuthProfile | null>(null);
  const isInitialized = ref(false);
  const isLoading = ref(false);

  const isAuthenticated = computed(() => profile.value !== null);
  const isAdmin = computed(() => Boolean(profile.value?.user.isAdmin));
  const activeTheme = computed<ThemeId>(() => profile.value?.user.theme ?? 'editorial-light');

  function applyTheme(theme: ThemeId): void {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage quota errors
    }
  }

  function hydrateProfile(next: AuthProfile | null): void {
    profile.value = next;
    if (next) {
      applyTheme(next.user.theme);
      setLocale(next.user.locale);
    }
  }

  async function initSession(): Promise<boolean> {
    if (isInitialized.value) return isAuthenticated.value;
    isLoading.value = true;
    try {
      const res = await apiRequest<{ ok: true; profile: AuthProfile }>('/api/me');
      hydrateProfile(res.profile);
      return true;
    } catch {
      hydrateProfile(null);
      return false;
    } finally {
      isInitialized.value = true;
      isLoading.value = false;
    }
  }

  async function register(input: {
    username: string;
    email: string;
    password: string;
    gdprAccepted: true;
    inviteCode?: string;
    friendToken?: string;
  }): Promise<AuthProfile> {
    const res = await apiRequest<{ ok: true; profile: AuthProfile }>('/api/auth/register', {
      method: 'POST',
      body: input
    });
    hydrateProfile(res.profile);
    isInitialized.value = true;
    return res.profile;
  }

  async function login(input: {
    identifier: string;
    password: string;
    inviteCode?: string;
    friendToken?: string;
  }): Promise<AuthProfile> {
    const res = await apiRequest<{ ok: true; profile: AuthProfile }>('/api/auth/login', {
      method: 'POST',
      body: input
    });
    hydrateProfile(res.profile);
    isInitialized.value = true;
    return res.profile;
  }

  async function logout(): Promise<void> {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } finally {
      await clearAllLocalCache().catch(() => undefined);
      hydrateProfile(null);
    }
  }

  async function requestPasswordReset(identifier: string): Promise<{ maskedEmail: string }> {
    const res = await apiRequest<{ ok: true; maskedEmail: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: { identifier }
    });
    return { maskedEmail: res.maskedEmail };
  }

  async function resetPassword(input: {
    identifier: string;
    code: string;
    newPassword: string;
  }): Promise<void> {
    await apiRequest('/api/auth/reset-password', {
      method: 'POST',
      body: input
    });
  }

  async function updateProfile(patch: {
    username?: string;
    email?: string;
    currentPassword?: string;
    newPassword?: string;
    theme?: ThemeId;
    locale?: LocaleId;
    onboardingNotifSeen?: boolean;
  }): Promise<AuthProfile> {
    const res = await apiRequest<{ ok: true; profile: AuthProfile }>('/api/me', {
      method: 'PATCH',
      body: patch
    });
    hydrateProfile(res.profile);
    return res.profile;
  }

  async function updateDefaultGenres(action: 'add' | 'remove' | 'reset', genre?: string): Promise<string[]> {
    const res = await apiRequest<{ ok: true; defaultGenres: string[] }>('/api/me/genres', {
      method: 'PUT',
      body: { action, genre }
    });
    if (profile.value) {
      profile.value = { ...profile.value, defaultGenres: res.defaultGenres };
    }
    return res.defaultGenres;
  }

  async function reorderDefaultGenres(genres: string[]): Promise<string[]> {
    const res = await apiRequest<{ ok: true; defaultGenres: string[] }>('/api/me/genres/reorder', {
      method: 'PUT',
      body: { genres }
    });
    if (profile.value) {
      profile.value = { ...profile.value, defaultGenres: res.defaultGenres };
    }
    return res.defaultGenres;
  }

  async function deleteAccount(password: string): Promise<void> {
    await apiRequest('/api/me', {
      method: 'DELETE',
      body: { password }
    });
    await clearAllLocalCache().catch(() => undefined);
    hydrateProfile(null);
  }

  return {
    profile,
    isInitialized,
    isLoading,
    isAuthenticated,
    isAdmin,
    activeTheme,
    applyTheme,
    hydrateProfile,
    initSession,
    register,
    login,
    logout,
    requestPasswordReset,
    resetPassword,
    updateProfile,
    updateDefaultGenres,
    reorderDefaultGenres,
    deleteAccount
  };
});
