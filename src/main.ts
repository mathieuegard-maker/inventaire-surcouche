// src/main.ts
import { authService } from './services/auth.service';
import { userService } from './services/user.service';
import { itemService } from './services/item.service';

const form = document.getElementById('login-form') as HTMLFormElement;
const logs = document.getElementById('logs')!;

function addLog(msg: string, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logs.prepend(div);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = (document.getElementById('username') as HTMLInputElement).value;
  const p = (document.getElementById('password') as HTMLInputElement).value;

  addLog("Phase 1 : Authentification...");

  try {
    await authService.login(u, p);
    addLog("✓ Phase 1 OK", "success");

    addLog("Phase 2 : Récupération Profil...");
    const user = await userService.fetchProfile();
    
    // Si on arrive ici, sessionStore.setUser a été appelé
    if (!user || !user.uri) {
      console.error("Échec identification. Regardez les clés [DEBUG] au dessus.");
      throw new Error("L'identifiant (URI/ID) est introuvable dans la réponse.");
    }

    addLog(`✓ Phase 2 OK : Bonjour ${user.username}`, "success");

    addLog("Phase 3 : Chargement Livres...");
    const items = await itemService.getItems(user.uri);
    addLog(`✓ Succès : ${items.length} livres chargés.`, "success");

  } catch (err: any) {
    addLog(`ERREUR : ${err.message}`, "error");
    console.error('[CRASH]', err);
  }
});