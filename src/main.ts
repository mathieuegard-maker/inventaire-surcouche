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
  console.log(`%c[APP] ${msg}`, type === 'error' ? 'color: red' : 'color: blue');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = (document.getElementById('username') as HTMLInputElement).value;
  const p = (document.getElementById('password') as HTMLInputElement).value;

  addLog("Phase 1 : Login...");

  try {
    await authService.login(u, p);
    addLog("✓ Login réussi", "success");

    addLog("Phase 2 : Vérification Session...");
    const user = await userService.fetchProfile();
    
    // On vérifie que l'utilisateur ET son URI sont bien présents
    if (user && user.username && user.uri) {
      addLog(`✓ Session validée : Bonjour ${user.username}`, "success");
      
      // Phase 3 réactivée !
      addLog("Phase 3 : Chargement de l'inventaire...");
      const items = await itemService.getItems(user.uri);
      
      addLog(`✓ Succès : ${items.length} livres récupérés !`, "success");
      console.log('[DEBUG] Tes livres :', items);

    } else {
      throw new Error("L'identifiant URI est introuvable dans le profil.");
    }

  } catch (err: any) {
    addLog(`ERREUR : ${err.message}`, "error");
    if (err.message.includes('aucun cookie')) {
      addLog("ASTUCE : Vérifiez que les cookies tiers sont autorisés.", "info");
    }
  }
});