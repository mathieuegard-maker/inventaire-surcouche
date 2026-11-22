// src/core/services/user.service.ts
import { sessionStore } from '../../state/session';
import { fetchWithTimeout } from '../../state/connection';
import { SUGGESTED_GENRE_CHIPS } from '../utils/category-classifier.util';
import type { IndividualReadingStatus, UserBookReadingRecord } from './user-preferences.service';

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
    options?: { mode?: 'login' | 'register' | 'auto'; recoveryEmail?: string; gdprAccepted?: boolean }
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
        ...(options?.gdprAccepted ? { gdprAccepted: true } : {}),
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
  },

  // =========================================================================
  // Statuts de lecture, notes & genres par défaut (STRICTEMENT individuels)
  // =========================================================================
  getScopedReadingStorageKey(workId: string): string {
    const uid = (sessionStore.state.user?.username || sessionStore.state.user?.uri || 'anon').toLowerCase();
    return `biblio_reading_u_${uid}_${workId}`;
  },

  readLocalReadingStatus(workId: string): {
    status: IndividualReadingStatus;
    rating: number;
    personalNotes: string;
  } | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const scoped = localStorage.getItem(this.getScopedReadingStorageKey(workId));
      const raw = scoped || localStorage.getItem(`biblio_reading_${workId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const st = parsed.status === 'unread' ? 'to_read' : (parsed.status || 'none');
      return {
        status: st as IndividualReadingStatus,
        rating: Number(parsed.rating) || 0,
        personalNotes: String(parsed.personalNotes || '')
      };
    } catch {
      return null;
    }
  },

  writeLocalReadingStatus(
    workId: string,
    data: { status: IndividualReadingStatus; rating: number; personalNotes: string }
  ): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.getScopedReadingStorageKey(workId), JSON.stringify(data));
    } catch {
      // ignore quota errors
    }
  },

  async fetchReadingStatus(workId: string): Promise<UserBookReadingRecord | null> {
    const savedUri = sessionStore.getUserUri() || '';
    const qs = new URLSearchParams({ workId, ...(savedUri ? { userUri: savedUri } : {}) });
    const res = await fetchWithTimeout(`/api/v2/reading-status?${qs.toString()}`).catch(() => null);
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    const rec = (data?.record || null) as UserBookReadingRecord | null;
    if (rec) {
      this.writeLocalReadingStatus(workId, {
        status: rec.status,
        rating: rec.rating,
        personalNotes: rec.personalNotes || ''
      });
    }
    return rec;
  },

  async syncAllUserReadingStatuses(): Promise<UserBookReadingRecord[]> {
    const savedUri = sessionStore.getUserUri() || '';
    const qs = savedUri ? `?userUri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/v2/reading-status${qs}`).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => null);
    const records: UserBookReadingRecord[] = Array.isArray(data?.records) ? data.records : [];
    for (const rec of records) {
      this.writeLocalReadingStatus(rec.workId, {
        status: rec.status,
        rating: rec.rating,
        personalNotes: rec.personalNotes || ''
      });
    }
    return records;
  },

  async saveReadingStatus(params: {
    workId: string;
    status: IndividualReadingStatus;
    rating: number;
    personalNotes?: string;
  }): Promise<UserBookReadingRecord | null> {
    const clean = {
      status: params.status,
      rating: Number(params.rating) || 0,
      personalNotes: String(params.personalNotes || '').trim()
    };
    this.writeLocalReadingStatus(params.workId, clean);
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/v2/reading-status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workId: params.workId,
        status: clean.status,
        rating: clean.rating,
        personalNotes: clean.personalNotes,
        userUri: savedUri
      })
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    return (data?.record || null) as UserBookReadingRecord | null;
  },

  async fetchDefaultGenres(): Promise<{ genres: string[]; isCustomized: boolean }> {
    const savedUri = sessionStore.getUserUri() || '';
    const qs = savedUri ? `?userUri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/v2/user-genres${qs}`).catch(() => null);
    if (!res || !res.ok) {
      return { genres: [...SUGGESTED_GENRE_CHIPS], isCustomized: false };
    }
    const data = await res.json().catch(() => null);
    if (Array.isArray(data?.genres)) {
      return { genres: data.genres, isCustomized: Boolean(data.isCustomized) };
    }
    return { genres: [...SUGGESTED_GENRE_CHIPS], isCustomized: false };
  },

  async updateDefaultGenres(
    action: 'add' | 'remove' | 'reset',
    genre?: string
  ): Promise<{ genres: string[]; isCustomized: boolean }> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/v2/user-genres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, genre, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Impossible de mettre à jour les genres par défaut.');
    return {
      genres: Array.isArray(data?.genres) ? data.genres : [...SUGGESTED_GENRE_CHIPS],
      isCustomized: Boolean(data?.isCustomized)
    };
  },

  async addGenresToBooksBatch(bookUris: string[], genres: string[]): Promise<{ updatedCount: number }> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/v2/books/batch-genres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookUris, genres, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Impossible d'ajouter le genre au lot.");
    return { updatedCount: Number(data?.updatedCount) || 0 };
  },

  async markNotifOnboardingSeen(): Promise<void> {
    const savedUri = sessionStore.getUserUri() || '';
    await fetchWithTimeout('/api/gateway?action=onboarding-notif-seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userUri: savedUri })
    }).catch(() => {});
  },

  async deleteAccount(password: string): Promise<{ ok: boolean; libraryDeleted: boolean }> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=account-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Impossible de supprimer le compte.');
    }
    sessionStore.clearSession();
    return { ok: true, libraryDeleted: Boolean(data?.libraryDeleted) };
  },

  async updateAdminCatalogItem(payload: {
    uri: string;
    label: string;
    image_url?: string | null;
    main_category?: string | null;
    subgenres?: string[];
    series_number?: string | null;
    series_name?: string | null;
    authors?: string[];
    publisher?: string | null;
    publication_date?: string | null;
  }): Promise<void> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=admin-catalog-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Impossible de modifier cette fiche catalogue.');
    }
  },

  async bulkUpdateAdminCatalogItems(payload: {
    uris: string[];
    patch: {
      publisher?: string | null;
      main_category?: string | null;
      series_name?: string | null;
      authors?: string[];
      subgenres?: string[];
      publication_date?: string | null;
    };
  }): Promise<{ requestedCount: number; updatedCount: number; updatedV4Count: number }> {
    const savedUri = sessionStore.getUserUri() || '';
    const res = await fetchWithTimeout('/api/gateway?action=admin-catalog-bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, userUri: savedUri })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Impossible d’appliquer les modifications groupées.');
    }
    return {
      requestedCount: Number(data.requestedCount || payload.uris.length),
      updatedCount: Number(data.updatedCount || 0),
      updatedV4Count: Number(data.updatedV4Count || 0)
    };
  }
};
