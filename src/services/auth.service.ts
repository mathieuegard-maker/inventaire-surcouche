// src/services/auth.service.ts
export const authService = {
  async login(username: string, password: string) {
    console.log('[AuthService] Appel login...');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error("Identifiants incorrects");
    return await res.json();
  }
};