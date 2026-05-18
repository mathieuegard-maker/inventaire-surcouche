// src/core/services/user.service.ts
import { sessionStore } from '../../state/session';

export const userService = {
  async fetchProfile() {
    const res = await fetch('/api/gateway?action=user-get');
    const data = await res.json();

    if (!res.ok) {
      console.log('[DEBUG] Détails du rejet API :', data);
      throw new Error(data.error || "Session invalide");
    }
    
    sessionStore.setUser(data);
    return sessionStore.state.user;
  }
};