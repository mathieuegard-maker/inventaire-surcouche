// src/state/session.ts
export const sessionStore = {
  state: {
    user: null as { uri: string; username: string } | null,
  },
  
  setUser(data: any) {
    // Extraction de l'objet (parfois dans .user, parfois à la racine)
    const u = data.user || data;
    
    // LOG DE DÉBOGAGE : Affiche les clés disponibles dans la console du navigateur
    console.log('[DEBUG] Clés reçues de l’API :', Object.keys(u));
    console.log('[DEBUG] Objet complet :', u);

    // Recherche exhaustive de l'identifiant selon la doc [cite: 163, 263, 672]
    const finalUri = u.uri || u.id || u._id || u.acct || '';

    this.state.user = {
      uri: finalUri,
      username: u.username || u.label || u.name || 'Utilisateur',
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
          console.log('[DEBUG] Session restaurée depuis localStorage :', this.state.user);
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