// src/state/session.ts
export interface SessionUser {
  uri: string;
  username: string;
  recoveryEmail?: string | null;
  isAdmin?: boolean;
  libraryId?: string;
  libraryName?: string;
  inviteCode?: string;
  publicReadonlyToken?: string;
  sessionToken?: string;
}

export const sessionStore = {
  state: {
    user: null as SessionUser | null,
  },

  setUser(data: any) {
    const u = data.user || data;
    const finalUri = u.uri || u.id || u._id || u.acct || '';

    this.state.user = {
      uri: finalUri,
      username: u.username || u.label || u.name || 'Utilisateur',
      recoveryEmail: u.recoveryEmail !== undefined ? u.recoveryEmail : this.state.user?.recoveryEmail ?? null,
      isAdmin: u.isAdmin !== undefined ? Boolean(u.isAdmin) : Boolean(this.state.user?.isAdmin),
      libraryId: u.libraryId,
      libraryName: u.libraryName,
      inviteCode: u.inviteCode,
      publicReadonlyToken: u.publicReadonlyToken,
      sessionToken: u.sessionToken || this.state.user?.sessionToken,
    };

    if (typeof localStorage !== 'undefined' && finalUri) {
      localStorage.setItem('inventaire_session', JSON.stringify(this.state.user));
    }
  },

  restoreSessionFromLocalStorage(): boolean {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('inventaire_session');
      if (saved) {
        try {
          this.state.user = JSON.parse(saved);
          return true;
        } catch (e) {
          console.error('[DEBUG] Échec de la restauration de la session depuis localStorage :', e);
        }
      }
    }
    return false;
  },

  getUserUri() {
    return this.state.user?.uri;
  },

  clearSession() {
    this.state.user = null;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('inventaire_session');
    }
  }
};
