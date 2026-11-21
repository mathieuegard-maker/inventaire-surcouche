// src/core/services/user.service.ts
import { sessionStore } from '../../state/session';
import { fetchWithTimeout } from '../../state/connection';

export interface FriendLibrarySummary {
  libraryId: string;
  libraryName: string;
  ownerName: string | null;
  shareToken: string;
  createdAt?: string;
  ownedCount: number;
  wishlistCount: number;
}

export interface LoanContact {
  name: string;
  source: 'friend_share' | 'borrower';
}

export interface SharedLibraryItem {
  edition_id: string;
  work_id?: string | null;
  ownership_status: 'owned' | 'wishlist';
  location?: string | null;
  title?: string | null;
  series_uri?: string | null;
  series_name?: string | null;
  series_number?: number | string | null;
  sort_order?: number | null;
  image_url?: string | null;
  main_category?: string | null;
  wished_by_name?: string | null;
  is_lent?: number | boolean;
  borrower_name?: string | null;
}

export interface PublicSharePayload {
  libraryId: string;
  libraryName: string;
  ownerName?: string | null;
  token?: string;
  tokenType: string;
  items: SharedLibraryItem[];
}

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
   * et/ou un jeton ami à suivre (`friendToken`)
   */
  async login(
    username: string,
    password: string,
    inviteCode?: string,
    friendToken?: string,
    options?: { mode?: 'login' | 'register' | 'auto'; recoveryEmail?: string }
  ): Promise<boolean> {
    const res = await fetchWithTimeout('/api/gateway?action=auth-login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username,
        password,
        ...(options?.mode ? { mode: options.mode } : {}),
        ...(options?.recoveryEmail ? { recoveryEmail: options.recoveryEmail } : {}),
        ...(inviteCode ? { inviteCode } : {}),
        ...(friendToken ? { friendToken } : {})
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401) return false;
      throw new Error(data?.error || 'Erreur lors de la connexion.');
    }

    if (data) {
      sessionStore.setUser(data);
    }

    return true;
  },

  async updateProfile(payload: {
    username: string;
    recoveryEmail: string;
    currentPassword?: string;
    newPassword?: string;
  }): Promise<{ username: string; recoveryEmail: string }> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=profile-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Impossible de mettre à jour le profil.');
    }
    if (sessionStore.state.user) {
      sessionStore.setUser({
        ...sessionStore.state.user,
        username: data.username,
        recoveryEmail: data.recoveryEmail
      });
    }
    return data;
  },

  async requestPasswordReset(identifier: string): Promise<{ ok: boolean; maskedEmail?: string }> {
    const res = await fetchWithTimeout('/api/gateway?action=auth-forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "Impossible d'envoyer le code de récupération.");
    }
    return data;
  },

  async resetPassword(payload: {
    identifier: string;
    code: string;
    newPassword: string;
  }): Promise<{ ok: boolean }> {
    const res = await fetchWithTimeout('/api/gateway?action=auth-reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Impossible de réinitialiser le mot de passe.');
    }
    return data;
  },

  async logout(): Promise<void> {
    try {
      await fetchWithTimeout('/api/gateway?action=auth-logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    } catch {
      // Ignore network errors on logout; local session will still be cleared
    }
    sessionStore.clearSession();
  },

  async getNotificationPrefs(): Promise<{
    digestFrequency: 'off' | 'daily' | 'weekly' | 'monthly';
    digestHour: number;
    digestWeekday: number;
    digestDayOfMonth: number;
    digestTimezone: string;
    digestChannel: 'push' | 'email' | 'both';
    lastNotifiedAt: string | null;
    hasPushSubscription: boolean;
    vapidPublicKey: string | null;
  }> {
    const savedUri = sessionStore.getUserUri() || '';
    const query = savedUri ? `&uri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/gateway?action=notif-prefs-get${query}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Impossible de charger les préférences de notification.');
    }
    return data;
  },

  async saveNotificationPrefs(prefs: {
    digestFrequency: 'off' | 'daily' | 'weekly' | 'monthly';
    digestHour: number;
    digestWeekday: number;
    digestDayOfMonth: number;
    digestTimezone: string;
    digestChannel: 'push' | 'email' | 'both';
  }): Promise<void> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=notif-prefs-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...prefs, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Impossible de sauvegarder les préférences.');
    }
  },

  async subscribeWebPush(subscription: PushSubscriptionJSON): Promise<void> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, userUri: savedUri })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || "Impossible d'enregistrer l'abonnement Push.");
    }
  },

  async unsubscribeWebPush(endpoint?: string): Promise<void> {
    const savedUri = sessionStore.getUserUri() || '';
    await fetchWithTimeout('/api/gateway?action=push-unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, userUri: savedUri })
    });
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
  },

  /**
   * Liste les bibliothèques d'amis suivies par l'utilisateur connecté
   */
  async listFriends(): Promise<FriendLibrarySummary[]> {
    const savedUri = sessionStore.getUserUri() || '';
    const query = savedUri ? `&uri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/gateway?action=friends-list${query}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.friends) ? data.friends : [];
  },

  /**
   * Ajoute un ami à partir d'un code PUB-... ou d'un lien /shared/PUB-...
   */
  async addFriend(tokenOrUrl: string): Promise<{ ok: boolean; friend?: FriendLibrarySummary; error?: string }> {
    const userUri = sessionStore.getUserUri();
    const res = await fetchWithTimeout('/api/gateway?action=friends-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenOrUrl.trim(), userUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error || 'Code ou lien ami invalide.' };
    }
    return { ok: true, friend: data.friend };
  },

  /**
   * Retire un ami de la liste suivie (révocable sans impacter la bibliothèque de l'ami)
   */
  async removeFriend(targetLibraryId: string): Promise<boolean> {
    const userUri = sessionStore.getUserUri();
    const res = await fetchWithTimeout('/api/gateway?action=friends-remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLibraryId, userUri })
    });
    return res.ok;
  },

  /**
   * Charge la vitrine lecture seule d'un ami via son jeton PUB-...
   */
  async fetchPublicLibrary(token: string): Promise<PublicSharePayload> {
    const res = await fetchWithTimeout(`/api/gateway?action=public-share-get&token=${encodeURIComponent(token.trim())}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || 'Lien de partage introuvable ou expiré.');
    }
    return data as PublicSharePayload;
  },

  /**
   * Récupère la liste des contacts de prêt (amis partagés + emprunteurs enregistrés)
   */
  async listLoanContacts(): Promise<LoanContact[]> {
    const savedUri = sessionStore.getUserUri() || '';
    const query = savedUri ? `&uri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/gateway?action=loan-contacts-list${query}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.contacts) ? data.contacts : [];
  },

  async fetchAdminOverview(): Promise<any> {
    const savedUri = sessionStore.getUserUri() || '';
    const query = savedUri ? `&uri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/gateway?action=admin-overview${query}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Accès administrateur refusé.');
    return data;
  },

  async fetchAdminCatalog(params: {
    q?: string;
    type?: string;
    filter?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: any[]; total: number; page: number; pageSize: number }> {
    const savedUri = sessionStore.getUserUri() || '';
    const qs = new URLSearchParams({
      ...(savedUri ? { uri: savedUri } : {}),
      ...(params.q ? { q: params.q } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.filter ? { filter: params.filter } : {}),
      page: String(params.page || 1),
      pageSize: String(params.pageSize || 24)
    });
    const res = await fetchWithTimeout(`/api/gateway?action=admin-catalog-list&${qs.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Impossible de charger le catalogue.');
    return data;
  },

  async fetchAdminUsers(): Promise<any[]> {
    const savedUri = sessionStore.getUserUri() || '';
    const query = savedUri ? `&uri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/gateway?action=admin-users-list${query}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Impossible de charger les comptes.');
    return data.users || [];
  },

  async resetUserAiQuota(targetUserId: string): Promise<void> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=admin-reset-user-ai-quota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Échec réinitialisation quota.');
  },

  async runAdminRehydrate(offset = 0, limit = 20): Promise<any> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=admin-rehydrate-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, limit, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Échec ré-hydratation.');
    return data;
  },

  async runAdminReleaseSweep(): Promise<{ checkedCount: number; alertsCreated: number }> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=admin-run-release-sweep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Échec vérification nouveautés.');
    return data;
  },

  async fetchAdminPipelineLogs(params: {
    status?: string;
    layer?: string;
    q?: string;
    limit?: number;
  } = {}): Promise<{ traces: any[] }> {
    const savedUri = sessionStore.getUserUri() || '';
    const qs = new URLSearchParams({
      ...(savedUri ? { uri: savedUri } : {}),
      ...(params.status && params.status !== 'all' ? { status: params.status } : {}),
      ...(params.layer && params.layer !== 'all' ? { layer: params.layer } : {}),
      ...(params.q ? { q: params.q } : {}),
      limit: String(params.limit || 120)
    });
    const res = await fetchWithTimeout(`/api/gateway?action=admin-pipeline-logs&${qs.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Impossible de charger les logs pipeline.');
    return { traces: Array.isArray(data?.traces) ? data.traces : [] };
  },

  async purgeAdminPipelineLogs(): Promise<void> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=admin-pipeline-logs-purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Échec purge des logs.');
  }
};
