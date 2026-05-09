// src/services/user.service.ts
import { sessionStore } from '../state/session';

export const userService = {
  async fetchProfile() {
    const res = await fetch('/api/user/get');
    const data = await res.json();

    if (!res.ok) {
      // Affiche l'erreur technique précise (ex: Session absente)
      throw new Error(data.error || data.message || "Erreur profil");
    }
    
    sessionStore.setUser(data);
    return sessionStore.state.user;
  }
};