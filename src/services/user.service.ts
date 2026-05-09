// src/services/user.service.ts
import { sessionStore } from '../state/session';

export const userService = {
  async fetchProfile() {
    const res = await fetch('/api/user/get');
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Session invalide");
    }
    const data = await res.json();
    sessionStore.setUser(data);
    return sessionStore.state.user;
  }
};