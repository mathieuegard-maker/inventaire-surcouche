// src/main.ts
import { authService } from './services/auth.service';
import { entityResolver } from './resolvers/entity.resolver';
import { entityHumanizer } from './resolvers/humanizer';
import { manualIsbnProvider } from './providers/manual-isbn.provider';
import { inventoryService } from './services/inventory.service';
import { wishlistService } from './services/wishlist.service';
import { databaseService } from './services/database.service';
import { connectionService } from './services/connection.service';
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

/**
 * Initialisation du module de scan une fois connecté
 */
function initApp() {
  addLog("Module d'acquisition prêt.", "success");

  manualIsbnProvider.setup('acquisition-zone', async (isbn) => {
    addLog(`Recherche ISBN : ${isbn}...`);
    console.group(`================ ACQUISITION : ${isbn} ================`);

    try {
      // --- TUNNEL LOCAL-FIRST ---
      let book = await databaseService.getBookByIsbn(isbn);
      
      if (book) {
        addLog(`✓ Trouvé instantanément en cache local !`, "success");
      } else {
        addLog(`Absent du cache, interrogation de l'API...`, "warning");
        const rawData = await entityResolver.fromIsbn(isbn);
        if (!rawData) throw new Error("Livre introuvable sur l'API");
        
        book = await entityHumanizer.humanize(rawData);
        await databaseService.saveBookToCache(book);
        addLog(`✓ Fiche téléchargée, image compressée et mise en cache.`, "success");
      }

      // --- DOUBLE CHECK (Asynchrone car interroge IndexedDB) ---
      const isOwned = await inventoryService.isUriOwned(book.uri);
      const isWished = await wishlistService.isUriWished(book.uri);
      
      let otherEdition;
      if (!isOwned && book.workUri) {
         otherEdition = await databaseService.getOtherOwnedEdition(book.workUri, book.uri);
      }

      addLog(`✓ Livre : ${book.title}`, "success");

      if (otherEdition) {
         addLog(`⚠️ ATTENTION : Vous possédez déjà cette œuvre ! (Édition : ${otherEdition.title})`, "warning");
      }

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
            
            const worksToAdd = [];
            for (const t of tomesComplets) {
               const owned = await inventoryService.isUriOwned(t.uri);
               if (!owned) worksToAdd.push(t.uri);
            }
            
            if (worksToAdd.length === 0) return addLog("Série déjà possédée.", "warning");
            
            const editionsToAdd = await entityResolver.resolveBestEditions(worksToAdd);
            await inventoryService.addBulkToLibrary(editionsToAdd);
            
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
            
            const worksToWish = [];
            for (const t of tomesComplets) {
               const owned = await inventoryService.isUriOwned(t.uri);
               const wished = await wishlistService.isUriWished(t.uri);
               if (!owned && !wished) worksToWish.push(t.uri);
            }

            if (worksToWish.length === 0) return addLog("Rien à ajouter à la Wishlist.", "warning");

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

        if (isWished) {
          const wishBadge = document.createElement('div');
          wishBadge.textContent = "⭐ Déjà dans la Wishlist";
          Object.assign(wishBadge.style, { 
            marginTop: '10px', backgroundColor: '#f39c12', color: 'white', padding: '10px', borderRadius: '4px', textAlign: 'center', fontWeight: 'bold' 
          });
          acquisitionZone.appendChild(wishBadge);
        } else {
          const btnWish = document.createElement('button');
          btnWish.textContent = `⭐ Mettre dans la Wishlist`;
          Object.assign(btnWish.style, { marginTop: '10px', backgroundColor: '#f1c40f', color: '#2c3e50', padding: '10px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer', fontWeight: 'bold' });
          btnWish.onclick = async () => {
            try {
              btnWish.disabled = true;
              const targetUri = book.workUri || book.uri;
              await wishlistService.addToWishlist(targetUri);
              addLog("✓ En Wishlist.", "success");
              btnWish.textContent = "✓ Dans la Wishlist";
            } catch (err: any) { addLog(`Erreur : ${err.message}`, "error"); btnWish.disabled = false; }
          };
          acquisitionZone.appendChild(btnWish);
        }
      }
    } catch (err: any) { addLog(`ERREUR : ${err.message}`, "error"); } finally { console.groupEnd(); }
  });
}

/**
 * Action 1 : Auto-Login (Vérification automatique au chargement)
 */
async function autoInit() {
  addLog("Vérification de la session en cours...");
  try {
    const isConnected = await connectionService.initializeApp();
    if (isConnected) {
      addLog(`Session restaurée. Bienvenue !`, "success");
      form.style.display = 'none';
      acquisitionZone.style.display = 'block';
      initApp();
    } else {
      addLog("Aucune session active. Veuillez vous connecter.");
    }
  } catch (err) {
    // Échec silencieux de l'auto-init
    console.warn("[AUTO-INIT] Non connecté.");
  }
}

// Écouteur pour la connexion manuelle via le formulaire
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = (document.getElementById('username') as HTMLInputElement).value;
  const p = (document.getElementById('password') as HTMLInputElement).value;
  
  addLog("Connexion et initialisation...");
  try {
    await authService.login(u, p);
    const isConnected = await connectionService.initializeApp();
    if (isConnected) {
      addLog(`Prêt !`, "success");
      form.style.display = 'none';
      acquisitionZone.style.display = 'block';
      initApp();
    } else {
      addLog("Échec de l'initialisation du profil.", "error");
    }
  } catch (err: any) { addLog(`ÉCHEC : ${err.message}`, "error"); }
});

// LANCEMENT AUTOMATIQUE AU DÉMARRAGE
autoInit();