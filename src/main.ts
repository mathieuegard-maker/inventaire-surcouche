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
      const rawData = await entityResolver.fromIsbn(isbn);
      const isOwned = inventoryService.isUriOwned(rawData.uri);
      
      if (isOwned) {
        addLog(`⚠️ Ce livre (${rawData.title}) est DÉJÀ dans ta collection !`, "warning");
      } else {
        addLog(`✅ Nouveau livre ! On peut l'ajouter.`, "success");
      }

      addLog("Traduction des identifiants...");
      const book = await entityHumanizer.humanize(rawData);
      
      addLog(`✓ Succès : ${book.title}`, "success");
      
      if (book.authors.length > 0) {
        addLog(`Par : ${book.authors.join(', ')}`);
      }

      if (book.series) {
        addLog(`Série : ${book.series} (Tome ${book.seriesNumber || '?'})`);
        addLog(`⏳ Recherche des autres tomes de la saga...`);
        
        const tomesComplets = await seriesResolver.getFullSeries(book.seriesId!);
        addLog(`📚 ${tomesComplets.length} tomes trouvés pour cette série.`, "info");

        // GESTION DU BOUTON BULK
        const oldBulkBtn = document.getElementById('bulk-add-btn');
        if (oldBulkBtn) oldBulkBtn.remove();

        const bulkBtn = document.createElement('button');
        bulkBtn.id = 'bulk-add-btn';
        bulkBtn.textContent = `📦 Tout ajouter (${tomesComplets.length} tomes)`;
        bulkBtn.style.marginTop = '10px';
        bulkBtn.style.backgroundColor = '#2980b9';
        bulkBtn.style.color = 'white';
        bulkBtn.style.padding = '10px';
        bulkBtn.style.border = 'none';
        bulkBtn.style.borderRadius = '4px';
        bulkBtn.style.cursor = 'pointer';
        bulkBtn.style.width = '100%';

        bulkBtn.onclick = async () => {
          try {
            bulkBtn.disabled = true;
            bulkBtn.textContent = "⏳ Résolution des éditions...";

            const worksToAdd = tomesComplets
              .map(t => t.uri)
              .filter(uri => !inventoryService.isUriOwned(uri));

            if (worksToAdd.length === 0) {
              addLog("Info : Tu possèdes déjà toute la série !", "warning");
              return;
            }

            // Appel à l'unité atomique du resolver
            const editionsToAdd = await entityResolver.resolveBestEditions(worksToAdd);

            bulkBtn.textContent = "⏳ Enregistrement...";
            await inventoryService.addBulkToLibrary(editionsToAdd);
            
            addLog(`🎉 Succès : ${editionsToAdd.length} tomes ajoutés !`, "success");
            bulkBtn.textContent = "✓ Série ajoutée";
          } catch (err: any) {
            addLog(`ERREUR BULK : ${err.message}`, "error");
            bulkBtn.disabled = false;
            bulkBtn.textContent = "❌ Réessayer l'ajout global";
          }
        };
        acquisitionZone.appendChild(bulkBtn);
      }

      // GESTION DU BOUTON AJOUT UNITAIRE
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
        btn.style.borderRadius = '4px';
        btn.style.cursor = 'pointer';
        btn.style.width = '100%';

        btn.onclick = async () => {
          try {
            btn.disabled = true;
            btn.textContent = "⏳ Ajout...";
            await inventoryService.addToLibrary(book.uri);
            addLog(`🎉 Succès : Ajouté !`, "success");
            btn.textContent = "✓ Dans la collection";
            btn.style.backgroundColor = '#7f8c8d';
          } catch (err: any) {
            addLog(`ERREUR d'ajout : ${err.message}`, "error");
            btn.disabled = false;
          }
        };
        acquisitionZone.appendChild(btn);
      }

    } catch (err: any) {
      addLog(`ERREUR : ${err.message}`, "error");
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
    if (user && user.uri) {
      addLog("Chargement de la bibliothèque...");
      await inventoryService.loadLibrary(user.uri);
      form.style.display = 'none';
      acquisitionZone.style.display = 'block';
      initApp();
    }
  } catch (err: any) {
    addLog(`ÉCHEC : ${err.message}`, "error");
  }
});