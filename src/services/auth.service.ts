// src/services/auth.service.ts
import { sessionStore } from '../state/session';

export const authService = {
  async login(username: string, password: string) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      // Si on a l'erreur "raw", on l'affiche, sinon le message standard
      const errorMsg = data.raw ? `Erreur Serveur : ${data.raw}` : (data.message || data.error || 'Erreur inconnue');
      throw new Error(errorMsg);
    }

    sessionStore.setUser(data);
    return data;
  }
};