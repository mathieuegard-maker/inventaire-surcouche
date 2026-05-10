// src/main.ts
import { authService } from './services/auth.service';
import { userService } from './services/user.service';
import { entityResolver } from './resolvers/entity.resolver';
import { entityHumanizer } from './resolvers/humanizer';
import { manualIsbnProvider } from './providers/manual-isbn.provider';
import { inventoryService } from './services/inventory.service';
import { seriesResolver } from './resolvers/series.resolver';

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
      // --- ÉTAPE 1 : RÉCUPÉRATION DES MÉTADONNÉES ---
      console.log("--- ÉTAPE 1 : RÉCUPÉRATION DES MÉTADONNÉES ---");
      const rawData = await entityResolver.fromIsbn(isbn);
      
      // --- ÉTAPE 2 : VÉRIFICATION INVENTAIRE ---
      console.log("--- ÉTAPE 2 : VÉRIFICATION INVENTAIRE ---");
      const isOwned = inventoryService.isUriOwned(rawData.uri);
      
      if (isOwned) {
        addLog(`⚠️ Ce livre (${rawData.title}) est DÉJÀ dans ta collection !`, "warning");
      } else {
        addLog(`✅ Nouveau livre ! On peut l'ajouter.`, "success");
      }

      // --- ÉTAPE 3 : TRADUCTION DES IDENTIFIANTS ---
      console.log("--- ÉTAPE 3 : TRADUCTION DES IDENTIFIANTS ---");
      addLog("Traduction des identifiants...");
      const book = await entityHumanizer.humanize(rawData);
      console.log("Objet FINAL :", book);

      // --- ÉTAPE 4 : AFFICHAGE LOGS ---
      addLog(`✓ Succès : ${book.title}`, "success");
      
      if (book.authors.length > 0) {
        addLog(`Par : ${book.authors.join(', ')}`);
      } else {
        addLog(`Auteur(s) : Non trouvés dans les claims`, "error");
      }

      if (book.series) {
        addLog(`Série : ${book.series} (Tome ${book.seriesNumber || '?'})`);

        // --- TEST ÉTAPE 2 : RÉCUPÉRATION DE LA SÉRIE COMPLÈTE ---
        console.log("--- ÉTAPE TEST : RÉCUPÉRATION DE LA SÉRIE COMPLÈTE ---");
        addLog(`⏳ Recherche des autres tomes de la saga...`);
        
        const tomesComplets = await seriesResolver.getFullSeries(book.seriesId!);
        
        console.log(`[TEST SERIE] ${tomesComplets.length} tomes récupérés et triés :`, tomesComplets);
        addLog(`📚 ${tomesComplets.length} tomes trouvés pour cette série.`, "info");
      }

      // --- ÉTAPE 5 : GESTION DE L'UI (Bouton Ajout) ---
      const oldBtn = document.getElementById('add-book-btn');
      if (oldBtn) oldBtn.remove();

      if (!isOwned) {
        const btn = document.createElement('button');
        btn.id = 'add-book-btn';
        btn.textContent = `➕ Ajouter "${book.title}" à ma collection`;
        btn.style.marginTop = '15px';
        btn.style.backgroundColor = '#5bc31b';
        btn.style.color = 'white';
        btn.style.padding = '10px';
        btn.style.border = 'none';
        btn.style.borderRadius = '5px';
        btn.style.cursor = 'pointer';
        btn.style.width = '100%';

        btn.onclick = async () => {
          try {
            btn.disabled = true;
            btn.textContent = "⏳ Ajout en cours...";
            btn.style.backgroundColor = '#f39c12';
            
            await inventoryService.addToLibrary(book.uri);
            
            addLog(`🎉 Succès : Le livre a été ajouté à ton inventaire !`, "success");
            btn.textContent = "✓ Dans la collection";
            btn.style.backgroundColor = '#7f8c8d';
            btn.style.cursor = 'default';
          } catch (err: any) {
            addLog(`ERREUR d'ajout : ${err.message}`, "error");
            btn.disabled = false;
            btn.textContent = `❌ Réessayer l'ajout`;
            btn.style.backgroundColor = '#e74c3c';
          }
        };

        acquisitionZone.appendChild(btn);
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