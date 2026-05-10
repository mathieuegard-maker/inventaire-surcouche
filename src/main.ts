import { authService } from './services/auth.service';
import { userService } from './services/user.service';
import { entityResolver } from './resolvers/entity.resolver';
import { entityHumanizer } from './resolvers/humanizer.ts';
import { manualIsbnProvider } from './providers/manual-isbn.provider';

const form = document.getElementById('login-form') as HTMLFormElement;
const logs = document.getElementById('logs')!;
const acquisitionZone = document.getElementById('acquisition-zone')!;

/**
 * Utilitaire de log pour l'interface
 */
function addLog(msg: string, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.style.padding = '5px 0';
  div.style.borderBottom = '1px solid #333';
  if (type === 'success') div.style.color = '#0f0';
  if (type === 'error') div.style.color = '#f00';
  
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logs.prepend(div);
}

/**
 * Initialisation de la logique métier après connexion
 */
function initApp() {
  addLog("Application prête. Module d'acquisition chargé.", "success");

  manualIsbnProvider.setup('acquisition-zone', async (isbn) => {
    addLog(`Action : Recherche de l'ISBN ${isbn}...`);

    try {
      // --- ÉTAPE 1 : RÉCUPÉRATION BRUTE ---
      const rawData = await entityResolver.fromIsbn(isbn);
      
      console.group(`[DEBUG] Acquisition ISBN: ${isbn}`);
      console.log("1. Objet RAW (Sortie du Mapper) :", rawData);

      // --- ÉTAPE 2 : HUMANISATION ---
      addLog("Traduction des identifiants...");
      const book = await entityHumanizer.humanize(rawData);
      
      console.log("2. Objet FINAL (Sortie de l'Humanizer) :", book);
      console.groupEnd();

      // --- ÉTAPE 3 : AFFICHAGE LOGS ---
      addLog(`✓ Succès : ${book.title}`, "success");
      
      // On affiche les auteurs OU les dessinateurs si les auteurs sont vides
      const creators = book.authors.length > 0 ? book.authors : book.illustrators;
      
      if (creators.length > 0) {
        addLog(`Par : ${creators.join(', ')}`);
      } else {
        addLog(`Auteur(s) : Non trouvés dans les claims`, "error");
      }

    } catch (err: any) {
      addLog(`ERREUR : ${err.message}`, "error");
      console.error(err);
    }
  });
}

/**
 * Gestion du formulaire de connexion
 */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = (document.getElementById('username') as HTMLInputElement).value;
  const p = (document.getElementById('password') as HTMLInputElement).value;

  addLog("Tentative de connexion...");

  try {
    // Étape 1 : Authentification
    await authService.login(u, p);
    addLog("✓ Authentification réussie", "success");

    // Étape 2 : Récupération du profil
    const user = await userService.fetchProfile();
    
    if (user && user.username) {
      addLog(`✓ Session active pour ${user.username}`, "success");
      
      // Interface : On bascule du login vers l'app
      form.style.display = 'none';
      acquisitionZone.style.display = 'block';
      
      initApp();
    }
  } catch (err: any) {
    addLog(`ÉCHEC : ${err.message}`, "error");
  }
});