// src/services/user.service.ts
import { sessionStore } from '../state/session';

export const userService = {
  async fetchProfile() {
    console.log('[FRONT] Appel /api/user/get...');
    const res = await fetch('/api/user/get');
    const data = await res.json();

    if (!res.ok) {
      console.error('[FRONT] Erreur Profil Detaillee :', data);
      // On affiche le message de debug s'il existe
      const errorMsg = data.debug || data.error || "Erreur session";
      throw new Error(errorMsg);
    }
    
    sessionStore.setUser(data);
    return sessionStore.state.user;
  }
};