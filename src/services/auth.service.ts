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
      // On utilise le message d'erreur spécifique renvoyé par le proxy
      throw new Error(data.error || 'Identifiants incorrects');
    }
    
    sessionStore.setUser(data);
    return data;
  }
};