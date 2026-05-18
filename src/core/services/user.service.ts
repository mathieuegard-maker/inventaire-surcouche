// src/services/user.service.ts
import { sessionStore } from '../../state/session';

export const userService = {
  async fetchProfile() {
    const res = await fetch('/api/user/get');
    const data = await res.json();

    if (!res.ok) {
      // Log détaillé pour inspecter api_response dans F12
      console.log('[DEBUG] Détails du rejet API :', data);
      throw new Error(data.error || "Session invalide");
    }
    
    sessionStore.setUser(data);
    return sessionStore.state.user;
  }
};