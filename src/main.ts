// src/main.ts
import { authService } from './services/auth.service';
import { userService } from './services/user.service';
import { entityResolver } from './resolvers/entity.resolver';
import { entityHumanizer } from './resolvers/humanizer';
import { manualIsbnProvider } from './providers/manual-isbn.provider';
import { inventoryService } from './services/inventory.service';

const form = document.getElementById('login-form') as HTMLFormElement;
const logs = document.getElementById('logs')!;
const acquisitionZone = document.getElementById('acquisition-zone')!;

function addLog(msg: string, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.style.padding = '5px 0';
  div.style.borderBottom = '1px solid #333';
  if (type === 'success') div.style.color = '#0f0';
  if (type === 'error') div.style.color = '#f00';
  if (type === 'warning') div.style.color = '#ffa500';
  
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logs.prepend(div);
}

function initApp() {
  addLog("Application prête. Module d'acquisition chargé.", "success");

  manualIsbnProvider.setup('acquisition-zone', async (isbn) => {
    addLog(`Action : Recherche de l'ISBN ${isbn}...`);
    console.group(`================ ACQUISITION : ${isbn} ================`);

    try {
      // --- ÉTAPE 1 : RÉCUPÉRATION BRUTE (1 SEUL APPEL RÉSEAU) ---
      console.log("--- ÉTAPE 1 : RÉCUPÉRATION DES MÉTADONNÉES ---");
      const rawData = await entityResolver.fromIsbn(isbn);
      
      // --- ÉTAPE 2 : VÉRIFICATION INVENTAIRE (Mémoire locale, ultra-rapide) ---
      console.log("--- ÉTAPE 2 : VÉRIFICATION INVENTAIRE ---");
      const isOwned = inventoryService.isUriOwned(rawData.uri);
      
      if (isOwned) {
        addLog(`⚠️ Ce livre (${rawData.title}) est DÉJÀ dans ta collection !`, "warning");
      } else {
        addLog(`✅ Nouveau livre ! On peut l'ajouter.`, "success");
      }

      // --- ÉTAPE 3 : HUMANISATION ---
      console.log("--- ÉTAPE 3 : TRADUCTION DES IDENTIFIANTS ---");
      addLog("Traduction des identifiants...");
      const book = await entityHumanizer.humanize(rawData);
      console.log("Objet FINAL :", book);

      // --- ÉTAPE 4 : AFFICHAGE LOGS ---
      addLog(`✓ Succès : ${book.title}`, "success");
      
      const creators = book.authors.length > 0 ? book.authors : book.illustrators;
      if (creators.length > 0) {
        addLog(`Par : ${creators.join(', ')}`);
      } else {
        addLog(`Auteur(s) : Non trouvés dans les claims`, "error");
      }

      if (book.series) {
        addLog(`Série : ${book.series} (Tome ${book.seriesNumber || '?'})`);
      }

    } catch (err: any) {
      addLog(`ERREUR : ${err.message}`, "error");
      console.error(err);
    } finally {
      console.groupEnd();
    }
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = (document.getElementById('username') as HTMLInputElement).value;
  const p = (document.getElementById('password') as HTMLInputElement).value;

  addLog("Tentative de connexion...");

  try {
    await authService.login(u, p);
    addLog("✓ Authentification réussie", "success");

    const user = await userService.fetchProfile();
    
    if (user && user.username && user.uri) {
      addLog(`✓ Session active pour ${user.username}`, "success");
      
      addLog("Chargement de la bibliothèque en mémoire...");
      const totalBooks = await inventoryService.loadLibrary(user.uri);
      addLog(`📚 ${totalBooks} livres chargés dans ta collection.`, "success");

      form.style.display = 'none';
      acquisitionZone.style.display = 'block';
      
      initApp();
    } else {
      throw new Error("Impossible de trouver l'URI de l'utilisateur dans le profil.");
    }
  } catch (err: any) {
    addLog(`ÉCHEC : ${err.message}`, "error");
  }
});