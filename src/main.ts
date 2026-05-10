// src/main.ts
import { authService } from './services/auth.service';
import { userService } from './services/user.service';
import { entityResolver } from './resolvers/entity.resolver';
import { manualIsbnProvider } from './providers/manual-isbn.provider';

const form = document.getElementById('login-form') as HTMLFormElement;
const logs = document.getElementById('logs')!;

function addLog(msg: string, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logs.prepend(div);
}

// Initialisation de la zone d'acquisition une fois connecté
function initAcquisitionModules() {
  addLog("Modules d'acquisition prêts.", "success");
  
  // On configure le provider manuel
  // Il va envoyer l'ISBN au Resolver quand on clique sur le bouton
  manualIsbnProvider.setup('acquisition-zone', async (isbn) => {
    addLog(`Recherche de l'ISBN : ${isbn}...`);
    
    try {
      const bookData = await entityResolver.fromIsbn(isbn);
      
      // Visualisation en console et en dur dans les logs
      console.table(bookData);
      addLog(`✓ Trouvé : ${bookData.title} (${bookData.authors.join(', ')})`, "success");
      
    } catch (err: any) {
      addLog(`ERREUR : ${err.message}`, "error");
    }
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = (document.getElementById('username') as HTMLInputElement).value;
  const p = (document.getElementById('password') as HTMLInputElement).value;

  addLog("Phase 1 : Login...");
  try {
    await authService.login(u, p);
    addLog("✓ Login réussi", "success");

    addLog("Phase 2 : Profil...");
    const user = await userService.fetchProfile();
    
    if (user && user.username) {
      addLog(`✓ Bienvenue ${user.username}`, "success");
      
      // On cache le formulaire de login et on affiche la zone d'acquisition
      form.style.display = 'none';
      initAcquisitionModules();
    }
  } catch (err: any) {
    addLog(`ERREUR : ${err.message}`, "error");
  }
});