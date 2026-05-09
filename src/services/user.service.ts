// src/services/user.service.ts
import { sessionStore } from '../state/session';

export const userService = {
  async fetchProfile() {
    const res = await fetch('/api/user/get');
    
    // Protection contre les réponses non-JSON (erreurs Vercel)
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await res.text();
      throw new Error(`Réponse non-JSON reçue : ${text.substring(0, 30)}...`);
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Impossible de charger le profil");
    
    sessionStore.setUser(data);
    return sessionStore.state.user;
  }
};