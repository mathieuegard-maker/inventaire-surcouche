// src/core/services/user.service.ts
import { sessionStore } from '../../state/session';
import { fetchWithTimeout } from '../../state/connection';

export const userService = {
  /**
   * Récupère le profil de l'utilisateur actuellement connecté via le cookie de session
   */
  async fetchProfile() {
    const res = await fetchWithTimeout('/api/gateway?action=user-get');
    const data = await res.json();

    if (!res.ok) {
      console.log('[DEBUG] Détails du rejet API :', data);
      const error = new Error(data.error || "Session invalide") as any;
      error.status = res.status;
      throw error;
    }
    
    sessionStore.setUser(data);
    return sessionStore.state.user;
  },

  /**
   * Envoie une requête d'authentification au Gateway avec les identifiants requis
   */
  async login(username: string, password: string): Promise<boolean> {
    // CORRECTION : Remplacement de 'login' par 'auth-login' pour s'aligner sur le switch du Gateway
    const res = await fetchWithTimeout('/api/gateway?action=auth-login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!res.ok) {
      console.log('[DEBUG] Échec de la connexion API :', data);
      return false;
    }

    // Si le Gateway renvoie directement les données utilisateur à la connexion
    if (data) {
      sessionStore.setUser(data);
    }
    
    return true;
  }
};