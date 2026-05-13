// src/main.ts
import { authService } from './services/auth.service';
import { connectionService } from './services/connection.service';
import { manualIsbnProvider } from './providers/manual-isbn.provider';
import { inventoryService } from './services/inventory.service';
import { wishlistService } from './services/wishlist.service';
import { searchService } from './services/search.service';
import type { SearchResponse, HumanizedBook } from './resolvers/types';

const form = document.getElementById('login-form') as HTMLFormElement;
const logs = document.getElementById('logs')!;
const acquisitionZone = document.getElementById('acquisition-zone')!;

/**
 * Console de debug visuelle (Identique à l'originale)
 */
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
 * Rendu technique : Tableau du livre principal avec STATUT
 */
function renderMainBookDebugTable(book: HumanizedBook, source: string) {
  const container = document.createElement('div');
  container.style.marginTop = '15px';
  container.innerHTML = `<h3 style="color: #3498db; font-size: 13px; margin-bottom: 5px;">📖 Livre Actuel (${source.toUpperCase()})</h3>`;

  const table = document.createElement('table');
  Object.assign(table.style, {
    width: '100%', borderCollapse: 'collapse', fontSize: '11px', color: '#ccc', border: '1px solid #444'
  });

  const imgSrc = book.localCover || book.coverUrl || '';
  
  // Calcul du texte et de la couleur du statut
  let statusText = "INCONNU";
  let statusColor = "#888";
  if (book.ownershipStatus === 'owned') { statusText = "POSSÉDÉ"; statusColor = "#0f0"; }
  else if (book.ownershipStatus === 'wish') { statusText = "EN WISHLIST"; statusColor = "#ffa500"; }

  table.innerHTML = `
    <tr style="border-bottom: 1px solid #333;">
      <td rowspan="5" style="width: 60px; padding: 5px; text-align: center; vertical-align: top;">
        ${imgSrc ? `<img src="${imgSrc}" style="width: 50px; border-radius: 2px;">` : 'N/A'}
      </td>
      <td style="padding: 5px; color: #fff; font-weight: bold;">${book.title}</td>
    </tr>
    <tr style="border-bottom: 1px solid #333;">
      <td style="padding: 5px;">Auteurs : ${book.authors.join(', ') || 'Inconnu'}</td>
    </tr>
    <tr style="border-bottom: 1px solid #333;">
      <td style="padding: 5px;">Série : ${book.series || 'Aucune'} (Tome ${book.seriesNumber || '?'})</td>
    </tr>
    <tr style="border-bottom: 1px solid #333;">
      <td style="padding: 5px;">Statut : <span style="color: ${statusColor}; font-weight: bold;">${statusText}</span></td>
    </tr>
    <tr>
      <td style="padding: 5px; font-size: 9px; color: #777;">URI : ${book.uri} | Work : ${book.workUri || 'N/A'}</td>
    </tr>
  `;

  container.appendChild(table);
  acquisitionZone.appendChild(container);
}

/**
 * Rendu technique : Tableau de debug des séries
 */
function renderSeriesDebugTable(tomes: HumanizedBook[]) {
  const container = document.createElement('div');
  container.style.marginTop = '15px';
  container.innerHTML = `<h3 style="color: #5bc31b; font-size: 13px; margin-bottom: 5px;">🛠 Debug Série (Composition)</h3>`;

  const table = document.createElement('table');
  Object.assign(table.style, {
    width: '100%', borderCollapse: 'collapse', fontSize: '10px', color: '#ccc', border: '1px solid #444'
  });

  table.innerHTML = `
    <thead>
      <tr style="background: #222; text-align: left;">
        <th style="padding: 3px; border: 1px solid #444;">Tome</th>
        <th style="padding: 3px; border: 1px solid #444;">Titre</th>
        <th style="padding: 3px; border: 1px solid #444;">Statut</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector('tbody')!;
  tomes.forEach(t => {
    const tr = document.createElement('tr');
    const statusColor = t.ownershipStatus === 'owned' ? '#0f0' : (t.ownershipStatus === 'wish' ? '#ffa500' : '#888');
    tr.innerHTML = `
      <td style="padding: 3px; border: 1px solid #444; text-align: center;">${t.seriesNumber || '?'}</td>
      <td style="padding: 3px; border: 1px solid #444;">${t.title}</td>
      <td style="padding: 3px; border: 1px solid #444; color: ${statusColor};">${t.ownershipStatus.toUpperCase()}</td>
    `;
    tbody.appendChild(tr);
  });

  container.appendChild(table);
  acquisitionZone.appendChild(container);
}

/**
 * Initialisation du module de scan
 */
function initApp() {
  addLog("Module d'acquisition prêt.", "success");

  manualIsbnProvider.setup('acquisition-zone', async (isbn) => {
    // Nettoyage de la zone
    const existing = acquisitionZone.querySelectorAll('div, button, table');
    existing.forEach(el => el.remove());

    addLog(`Recherche ISBN : ${isbn}...`);
    
    try {
      // UTILISATION DE L'ORCHESTRATEUR
      const res: SearchResponse | null = await searchService.searchByIsbn(isbn);
      
      if (!res) {
        throw new Error("Aucun résultat trouvé.");
      }

      addLog(`✓ Récupéré via : ${res.source.toUpperCase()}`, "success");
      
      // 1. Affichage du tableau principal (avec le statut intégré)
      renderMainBookDebugTable(res.mainBook, res.source);

      // 2. Alerte Double Check (Doublon d'œuvre)
      if (res.ui.alertDuplicate && res.ownership.duplicateEdition) {
        addLog(`⚠️ DOUBLON D'ŒUVRE : Vous possédez déjà "${res.ownership.duplicateEdition.title}"`, "warning");
      }

      // 3. Bouton Ajouter à la collection (si pas déjà possédé)
      if (res.ui.showAddButton) {
        const btnAdd = document.createElement('button');
        btnAdd.textContent = `➕ Ajouter à ma collection`;
        Object.assign(btnAdd.style, { marginTop: '10px', backgroundColor: '#5bc31b', color: 'white', padding: '10px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer' });
        btnAdd.onclick = async () => {
          try {
            btnAdd.disabled = true;
            await inventoryService.addToLibrary(res.mainBook.uri);
            addLog(`🎉 "${res.mainBook.title}" ajouté à l'inventaire !`, "success");
            btnAdd.textContent = "✓ Ajouté";
          } catch (e: any) { addLog(`Erreur : ${e.message}`, "error"); btnAdd.disabled = false; }
        };
        acquisitionZone.appendChild(btnAdd);
      }

      // 4. Bouton Ajouter à la Wishlist (si pas possédé et pas déjà en wish)
      if (res.ui.showWishButton) {
        const btnWish = document.createElement('button');
        btnWish.textContent = `⭐ Mettre en Wishlist`;
        Object.assign(btnWish.style, { marginTop: '5px', backgroundColor: '#f1c40f', color: '#2c3e50', padding: '10px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer', fontWeight: 'bold' });
        btnWish.onclick = async () => {
          try {
            btnWish.disabled = true;
            await wishlistService.addToWishlist(res.mainBook.workUri || res.mainBook.uri);
            addLog(`⭐ "${res.mainBook.title}" ajouté à la Wishlist.`, "success");
            btnWish.textContent = "✓ Souhaité";
          } catch (e: any) { addLog(`Erreur : ${e.message}`, "error"); btnWish.disabled = false; }
        };
        acquisitionZone.appendChild(btnWish);
      }

      // 5. Bouton d'affichage de la série
      if (res.series) {
        const btnShowSeries = document.createElement('button');
        btnShowSeries.textContent = `📚 Voir la série (${res.series.ownedCount}/${res.series.tomes.length} possédés)`;
        Object.assign(btnShowSeries.style, { marginTop: '5px', backgroundColor: '#34495e', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer' });
        btnShowSeries.onclick = () => {
          btnShowSeries.remove();
          renderSeriesDebugTable(res.series!.tomes);
        };
        acquisitionZone.appendChild(btnShowSeries);
      }

    } catch (err: any) { 
      addLog(`ERREUR : ${err.message}`, "error"); 
    }
  });
}

/**
 * Auto-Login au chargement (Identique à l'original)
 */
async function autoInit() {
  addLog("Vérification de la session...");
  try {
    const isConnected = await connectionService.initializeApp();
    if (isConnected) {
      addLog(`Session restaurée.`, "success");
      form.style.display = 'none';
      acquisitionZone.style.display = 'block';
      initApp();
    } else {
      addLog("Aucune session. Veuillez vous connecter.");
    }
  } catch (err) {
    console.warn("[AUTO-INIT] Non connecté.");
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const u = (document.getElementById('username') as HTMLInputElement).value;
  const p = (document.getElementById('password') as HTMLInputElement).value;
  addLog("Connexion...");
  try {
    await authService.login(u, p);
    if (await connectionService.initializeApp()) {
      form.style.display = 'none';
      acquisitionZone.style.display = 'block';
      initApp();
    }
  } catch (err: any) { addLog(`ÉCHEC : ${err.message}`, "error"); }
});

autoInit();