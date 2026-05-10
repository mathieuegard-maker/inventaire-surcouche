// src/main.ts
import { authService } from './services/auth.service';
import { userService } from './services/user.service';
import { entityResolver } from './resolvers/entity.resolver';
import { entityHumanizer } from './resolvers/humanizer';
import { manualIsbnProvider } from './providers/manual-isbn.provider';
import { inventoryService } from './services/inventory.service';
import { wishlistService } from './services/wishlist.service';
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
  addLog("Module d'acquisition prêt.", "success");

  manualIsbnProvider.setup('acquisition-zone', async (isbn) => {
    addLog(`Recherche ISBN : ${isbn}...`);
    console.group(`================ ACQUISITION : ${isbn} ================`);

    try {
      const rawData = await entityResolver.fromIsbn(isbn);
      const isOwned = inventoryService.isUriOwned(rawData.uri);
      const book = await entityHumanizer.humanize(rawData);
      
      addLog(`✓ Livre : ${book.title}`, "success");

      if (book.series) {
        addLog(`Série : ${book.series}`);
        const tomesComplets = await seriesResolver.getFullSeries(book.seriesId!);
        addLog(`📚 ${tomesComplets.length} tomes trouvés.`, "info");

        // --- BOUTON 1 : TOUT AJOUTER À LA COLLECTION (BULK) ---
        const bulkBtn = document.createElement('button');
        bulkBtn.textContent = `📦 Ajouter toute la série (${tomesComplets.length} tomes)`;
        Object.assign(bulkBtn.style, {
          marginTop: '10px', backgroundColor: '#2980b9', color: 'white',
          padding: '10px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer'
        });

        bulkBtn.onclick = async () => {
          try {
            bulkBtn.disabled = true;
            bulkBtn.textContent = "⏳ Résolution...";
            const worksToAdd = tomesComplets.map(t => t.uri).filter(uri => !inventoryService.isUriOwned(uri));
            if (worksToAdd.length === 0) return addLog("Série déjà possédée.", "warning");
            
            // Pour l'INVENTAIRE, on a besoin des EDITIONS
            const editionsToAdd = await entityResolver.resolveBestEditions(worksToAdd);
            await inventoryService.addBulkToLibrary(editionsToAdd);
            
            // On nettoie la wishlist des oeuvres qu'on vient d'ajouter
            await wishlistService.removeFromWishlist([...worksToAdd, ...editionsToAdd]);
            addLog(`🎉 ${editionsToAdd.length} tomes ajoutés à l'inventaire !`, "success");
            bulkBtn.textContent = "✓ Série ajoutée";
          } catch (err: any) { addLog(`Erreur : ${err.message}`, "error"); bulkBtn.disabled = false; }
        };
        acquisitionZone.appendChild(bulkBtn);

        // --- BOUTON 2 : TOUT METTRE EN WISHLIST (BULK) ---
        const bulkWishBtn = document.createElement('button');
        bulkWishBtn.textContent = `⭐ Toute la série en Wishlist`;
        Object.assign(bulkWishBtn.style, {
          marginTop: '5px', backgroundColor: '#f39c12', color: 'white',
          padding: '10px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer'
        });

        bulkWishBtn.onclick = async () => {
          try {
            bulkWishBtn.disabled = true;
            bulkWishBtn.textContent = "⏳ Ajout...";
            
            // On ne prend que ce qui n'est ni possédé, ni déjà souhaité (Ce sont des OEUVRES wd:)
            const worksToWish = tomesComplets.map(t => t.uri).filter(uri => 
              !inventoryService.isUriOwned(uri) && !wishlistService.isUriWished(uri)
            );

            if (worksToWish.length === 0) return addLog("Rien à ajouter à la Wishlist.", "warning");

            // Pour la WISHLIST, on envoie directement les OEUVRES (plus de résolution d'édition !)
            await wishlistService.addBulkToWishlist(worksToWish);
            
            addLog(`⭐ ${worksToWish.length} tomes mis en Wishlist !`, "success");
            bulkWishBtn.textContent = "✓ Wishlist mise à jour";
          } catch (err: any) { addLog(`Erreur : ${err.message}`, "error"); bulkWishBtn.disabled = false; }
        };
        acquisitionZone.appendChild(bulkWishBtn);
      }

      // --- BOUTONS UNITAIRES ---
      if (!isOwned) {
        const btnAdd = document.createElement('button');
        btnAdd.textContent = `➕ Ajouter à ma collection`;
        Object.assign(btnAdd.style, { marginTop: '15px', backgroundColor: '#5bc31b', color: 'white', padding: '10px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer' });
        btnAdd.onclick = async () => {
          try {
            btnAdd.disabled = true;
            await inventoryService.addToLibrary(book.uri);
            const toRemove = [book.uri]; if (book.workUri) toRemove.push(book.workUri);
            await wishlistService.removeFromWishlist(toRemove);
            addLog(`🎉 Ajouté !`, "success");
            btnAdd.textContent = "✓ Dans la collection";
            btnAdd.style.backgroundColor = '#7f8c8d';
          } catch (err: any) { addLog(`Erreur : ${err.message}`, "error"); btnAdd.disabled = false; }
        };
        acquisitionZone.appendChild(btnAdd);

        const btnWish = document.createElement('button');
        btnWish.textContent = `⭐ Mettre dans la Wishlist`;
        Object.assign(btnWish.style, { marginTop: '10px', backgroundColor: '#f1c40f', color: '#2c3e50', padding: '10px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer' });
        btnWish.onclick = async () => {
          try {
            btnWish.disabled = true;
            // On ajoute l'Oeuvre (et pas l'Edition) à la wishlist
            const targetUri = book.workUri || book.uri;
            await wishlistService.addToWishlist(targetUri);
            addLog("✓ En Wishlist.", "success");
            btnWish.textContent = "✓ Dans la Wishlist";
          } catch (err: any) { addLog(`Erreur : ${err.message}`, "error"); btnWish.disabled = false; }
        };
        acquisitionZone.appendChild(btnWish);
      }
    } catch (err: any) { addLog(`ERREUR : ${err.message}`, "error"); } finally { console.groupEnd(); }
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = (document.getElementById('username') as HTMLInputElement).value;
  const p = (document.getElementById('password') as HTMLInputElement).value;
  addLog("Connexion...");
  try {
    await authService.login(u, p);
    const user = await userService.fetchProfile();
    if (user && user.uri) {
      addLog("Synchronisation...");
      await Promise.all([
        inventoryService.loadLibrary(user.uri),
        wishlistService.loadWishlist(user.uri)
      ]);
      addLog(`Prêt !`, "success");
      form.style.display = 'none';
      acquisitionZone.style.display = 'block';
      initApp();
    }
  } catch (err: any) { addLog(`ÉCHEC : ${err.message}`, "error"); }
});