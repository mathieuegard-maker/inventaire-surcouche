// src/core/services/user.service.ts
import { sessionStore } from '../../state/session';
import { fetchWithTimeout } from '../../state/connection';

export const userService = {
  /**
   * Récupère le profil de l'utilisateur actuellement connecté (cookie ou URI de bibliothèque en repli)
   */
  async fetchProfile() {
    const savedUri = sessionStore.getUserUri() || '';
    const query = savedUri ? `&uri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/gateway?action=user-get${query}`);
    const data = await res.json();

    if (!res.ok) {
      const error = new Error(data.error || 'Session invalide') as any;
      error.status = res.status;
      throw error;
    }

    sessionStore.setUser(data);
    return sessionStore.state.user;
  },

  /**
   * Authentification ou création de compte V2 autonome sur Cloudflare D1
   * Supporte optionnellement un code d'invitation famille (`inviteCode`)
   */
  async login(username: string, password: string, inviteCode?: string): Promise<boolean> {
    const res = await fetchWithTimeout('/api/gateway?action=auth-login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password, ...(inviteCode ? { inviteCode } : {}) })
    });

    const data = await res.json();

    if (!res.ok) {
      return false;
    }

    if (data) {
      sessionStore.setUser(data);
    }

    return true;
  },

  /**
   * Rejoint une bibliothèque familiale existante via son code d'invitation (ex: FAM-XXXXXX)
   */
  async joinFamilyLibrary(inviteCode: string): Promise<{ ok: boolean; error?: string }> {
    const userUri = sessionStore.getUserUri();
    const res = await fetchWithTimeout('/api/gateway?action=family-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteCode: inviteCode.trim().toUpperCase(), userUri })
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error || 'Code famille invalide.' };
    }
    if (sessionStore.state.user) {
      sessionStore.setUser({
        ...sessionStore.state.user,
        uri: data.uri,
        libraryId: data.libraryId,
        inviteCode: data.inviteCode,
        publicReadonlyToken: data.publicReadonlyToken
      });
    }
    return { ok: true };
  }
};
