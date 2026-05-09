// src/services/auth.service.ts
import { sessionStore } from '../state/session';

export const authService = {
  async login(username: string, password: string) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    // On vérifie si la réponse est bien du JSON
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await res.text();
      throw new Error(`Le serveur a renvoyé du HTML au lieu de JSON. Début : ${text.substring(0, 20)}`);
    }

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || data.message || 'Échec de connexion');
    }

    sessionStore.setUser(data);
    return data;
  }
};