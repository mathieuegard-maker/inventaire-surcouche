// src/services/user.service.ts
import { sessionStore } from '../state/session';

export const userService = {
  async fetchProfile() {
    const res = await fetch('/api/user/get', {
      credentials: 'include' // Force l'envoi des cookies 
    });
    
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Session non reconnue par le serveur");
    }
    
    sessionStore.setUser(data);
    return sessionStore.state.user;
  }
};