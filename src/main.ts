// src/main.ts
import { authService } from './services/auth.service';
import { connectionService } from './services/connection.service';
import { manualIsbnProvider } from './providers/manual-isbn.provider';
import { inventoryService } from './services/inventory.service';
import { wishlistService } from './services/wishlist.service';
import { searchService } from './services/search.service';
import { loanService } from './services/loan.service';
import type { SearchResponse, HumanizedBook } from './resolvers/types';

const form = document.getElementById('login-form') as HTMLFormElement;
const logs = document.getElementById('logs')!;
const acquisitionZone = document.getElementById('acquisition-zone')!;

/**
 * Console de debug visuelle
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
 * Rendu technique : Tableau du livre principal avec STATUT DÉTAILLÉ, PRÊT et ALERTE DOUBLON
 */
function renderMainBookDebugTable(res: SearchResponse) {
  const existing = document.getElementById('debug-table-container');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.id = 'debug-table-container';
  container.style.marginTop = '20px';

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = '14px';

  // Calcul du texte de statut de possession
  let statusHtml = '';
  if (res.ownership.isEditionOwned) {
    statusHtml = `<span style="color: green; font-weight: bold;">Possédé (Cette édition)</span>`;
  } else if (res.ownership.isWorkOwned) {
    statusHtml = `<span style="color: #27ae60; font-weight: bold;">Possédé (Autre édition)</span>`;
  } else if (res.ownership.isWished) {
    statusHtml = `<span style="color: #2980b9; font-weight: bold;">Dans la Wishlist</span>`;
  } else {
    statusHtml = `<span style="color: #c0392b;">Non possédé</span>`;
  }

  // Affichage du statut de prêt
  if (res.loan.isLent && res.loan.details) {
    const dateStr = new Date(res.loan.details.loanDate).toLocaleDateString();
    statusHtml += `<br><span style="color: #e67e22; font-weight: bold; font-size: 0.9em;">⚠️ Prêté à ${res.loan.details.friendName} (le ${dateStr})</span>`;
  }

  let duplicateAlertHtml = '';
  if (res.ui.alertDuplicate && res.ownership.duplicateEdition) {
    duplicateAlertHtml = `
      <div style="margin-top:10px; padding:10px; background-color:#fff3cd; color:#856404; border:1px solid #ffeeba; border-radius:4px;">
        <strong>⚠️ Attention :</strong> Vous possédez déjà une autre édition de cette œuvre.<br>
        <em>Édition possédée : ${res.ownership.duplicateEdition.title} (${res.ownership.duplicateEdition.isbn13 || 'Sans ISBN'})</em>
      </div>
    `;
  }

  const thead = `
    <tr style="background-color: #eee; text-align: left;">
      <th style="padding: 8px; border: 1px solid #ccc;">Couverture</th>
      <th style="padding: 8px; border: 1px solid #ccc;">Informations (Main Book)</th>
      <th style="padding: 8px; border: 1px solid #ccc;">Statut Inventaire</th>
      <th style="padding: 8px; border: 1px solid #ccc;">Actions Rapides</th>
    </tr>
  `;

  table.innerHTML = thead;
  const tr = document.createElement('tr');

  // Cellule 1 : Couverture
  const coverCell = document.createElement('td');
  coverCell.style.padding = '8px';
  coverCell.style.border = '1px solid #ccc';
  coverCell.style.width = '100px';
  coverCell.style.textAlign = 'center';
  
  const coverImg = document.createElement('img');
  coverImg.style.maxWidth = '80px';
  coverImg.style.maxHeight = '120px';
  coverImg.style.objectFit = 'contain';
  coverImg.src = res.mainBook.localCover || res.mainBook.coverUrl || 'https://via.placeholder.com/80x120?text=No+Cover';
  coverCell.appendChild(coverImg);

  // Cellule 2 : Infos
  const infoCell = document.createElement('td');
  infoCell.style.padding = '8px';
  infoCell.style.border = '1px solid #ccc';
  infoCell.innerHTML = `
    <strong>${res.mainBook.title}</strong><br>
    <span style="color: #666; font-size: 12px;">${res.mainBook.authors.join(', ')}</span><br>
    <span style="color: #888; font-size: 11px;">ISBN: ${res.mainBook.isbn13 || res.mainBook.isbn10 || 'N/A'}</span>
    ${duplicateAlertHtml}
  `;

  // Cellule 3 : Statut
  const statusCell = document.createElement('td');
  statusCell.style.padding = '8px';
  statusCell.style.border = '1px solid #ccc';
  statusCell.innerHTML = statusHtml;

  // Cellule 4 : Actions
  const actionCell = document.createElement('td');
  actionCell.style.padding = '8px';
  actionCell.style.border = '1px solid #ccc';

  // Utilitaire pour récupérer l'ISBN actuel depuis le champ de recherche pour les rafraîchissements
  const getCurrentSearchIsbn = () => {
    const input = document.getElementById('isbn-input') as HTMLInputElement;
    return input ? input.value.trim() : '';
  };

  // Bouton Ajouter Inventaire
  if (res.ui.showAddButton) {
    const btnAdd = document.createElement('button');
    btnAdd.textContent = "Ajouter (Inventaire)";
    Object.assign(btnAdd.style, { backgroundColor: '#27ae60', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer' });
    btnAdd.onclick = async () => {
      btnAdd.disabled = true;
      btnAdd.textContent = "Ajout...";
      try {
        await inventoryService.addToLibrary(res.mainBook.uri);
        addLog(`Ajouté à l'inventaire : ${res.mainBook.title}`, 'success');
        const freshRes = await searchService.searchByIsbn(getCurrentSearchIsbn());
        if (freshRes) renderMainBookDebugTable(freshRes);
      } catch (e: any) {
        addLog(`Erreur: ${e.message}`, 'error');
        btnAdd.disabled = false;
        btnAdd.textContent = "Ajouter (Inventaire)";
      }
    };
    actionCell.appendChild(btnAdd);
  }

  // Bouton Ajouter Wishlist
  if (res.ui.showWishButton) {
    const btnWish = document.createElement('button');
    btnWish.textContent = "Ajouter (Wishlist)";
    Object.assign(btnWish.style, { marginTop: '5px', backgroundColor: '#2980b9', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer' });
    btnWish.onclick = async () => {
      btnWish.disabled = true;
      btnWish.textContent = "Ajout...";
      try {
        await wishlistService.addToWishlist(res.mainBook.uri);
        addLog(`Ajouté à la wishlist : ${res.mainBook.title}`, 'success');
        const freshRes = await searchService.searchByIsbn(getCurrentSearchIsbn());
        if (freshRes) renderMainBookDebugTable(freshRes);
      } catch (e: any) {
        addLog(`Erreur: ${e.message}`, 'error');
        btnWish.disabled = false;
        btnWish.textContent = "Ajouter (Wishlist)";
      }
    };
    actionCell.appendChild(btnWish);
  }

  // Bouton Prêter
  if (res.ui.showLoanButton) {
    const btnLoan = document.createElement('button');
    btnLoan.textContent = "Prêter l'exemplaire";
    Object.assign(btnLoan.style, { marginTop: '5px', backgroundColor: '#e67e22', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer' });
    btnLoan.onclick = async () => {
      const friendName = prompt("À qui prêtez-vous ce livre ?");
      if (friendName && friendName.trim() !== '') {
        btnLoan.disabled = true;
        btnLoan.textContent = "Enregistrement...";
        const success = await loanService.lend(res.mainBook.uri, friendName.trim());
        if (success) {
          addLog(`Livre prêté à ${friendName}`, 'success');
          const freshRes = await searchService.searchByIsbn(getCurrentSearchIsbn());
          if (freshRes) renderMainBookDebugTable(freshRes);
        } else {
          addLog(`Erreur lors du prêt`, 'error');
          btnLoan.disabled = false;
          btnLoan.textContent = "Prêter l'exemplaire";
        }
      }
    };
    actionCell.appendChild(btnLoan);
  }

  // Bouton Retour
  if (res.ui.showReturnButton) {
    const btnReturn = document.createElement('button');
    btnReturn.textContent = "Marquer comme Rendu";
    Object.assign(btnReturn.style, { marginTop: '5px', backgroundColor: '#8e44ad', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', width: '100%', cursor: 'pointer' });
    btnReturn.onclick = async () => {
      if (confirm("Confirmer le retour de ce livre ?")) {
        btnReturn.disabled = true;
        btnReturn.textContent = "Enregistrement...";
        const success = await loanService.returnBook(res.mainBook.uri);
        if (success) {
          addLog(`Livre marqué comme rendu`, 'success');
          const freshRes = await searchService.searchByIsbn(getCurrentSearchIsbn());
          if (freshRes) renderMainBookDebugTable(freshRes);
        } else {
          addLog(`Erreur lors du retour`, 'error');
          btnReturn.disabled = false;
          btnReturn.textContent = "Marquer comme Rendu";
        }
      }
    };
    actionCell.appendChild(btnReturn);
  }

  tr.appendChild(coverCell);
  tr.appendChild(infoCell);
  tr.appendChild(statusCell);
  tr.appendChild(actionCell);
  table.appendChild(tr);

  container.appendChild(table);
  acquisitionZone.appendChild(container);
}

/**
 * Rendu technique : Tableau de la Série
 */
function renderSeriesDebugTable(tomes: HumanizedBook[]) {
  const existing = document.getElementById('series-table-container');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.id = 'series-table-container';
  container.style.marginTop = '20px';
  container.style.borderTop = '2px solid #ccc';
  container.style.paddingTop = '10px';

  const title = document.createElement('h3');
  title.textContent = "📚 Contexte de la Série";
  title.style.marginTop = '0';
  container.appendChild(title);

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = '12px';

  const thead = `
    <tr style="background-color: #eee; text-align: left;">
      <th style="padding: 5px; border: 1px solid #ccc;">N°</th>
      <th style="padding: 5px; border: 1px solid #ccc;">Titre du tome</th>
      <th style="padding: 5px; border: 1px solid #ccc;">Statut</th>
    </tr>
  `;
  table.innerHTML = thead;

  // Tri des tomes par numéro
  const sortedTomes = [...tomes].sort((a, b) => {
    const numA = parseInt(a.seriesNumber || '0');
    const numB = parseInt(b.seriesNumber || '0');
    return numA - numB;
  });

  sortedTomes.forEach(tome => {
    const tr = document.createElement('tr');
    
    const tdNum = document.createElement('td');
    tdNum.style.padding = '5px';
    tdNum.style.border = '1px solid #ccc';
    tdNum.textContent = tome.seriesNumber || '-';

    const tdTitle = document.createElement('td');
    tdTitle.style.padding = '5px';
    tdTitle.style.border = '1px solid #ccc';
    tdTitle.textContent = tome.title;

    const tdStatus = document.createElement('td');
    tdStatus.style.padding = '5px';
    tdStatus.style.border = '1px solid #ccc';
    
    if (tome.ownershipStatus === 'owned') {
      tdStatus.innerHTML = '<span style="color: green; font-weight: bold;">✓ Possédé</span>';
    } else if (tome.ownershipStatus === 'wish') {
      tdStatus.innerHTML = '<span style="color: #2980b9;">⭐ Wishlist</span>';
    } else {
      tdStatus.innerHTML = '<span style="color: #c0392b;">❌ Manquant</span>';
    }

    tr.appendChild(tdNum);
    tr.appendChild(tdTitle);
    tr.appendChild(tdStatus);
    table.appendChild(tr);
  });

  container.appendChild(table);
  acquisitionZone.appendChild(container);
}

/**
 * Initialisation de l'interface après connexion
 */
function initApp() {
  const section = document.createElement('div');
  section.innerHTML = `
    <h2>Test Orchestrateur & UI Flags</h2>
    <div style="display: flex; gap: 10px; margin-bottom: 20px;">
      <input type="text" id="isbn-input" placeholder="Scanner ou taper un ISBN..." style="flex-grow: 1;">
      <button id="btn-search" style="width: auto; background-color: #3498db;">Rechercher</button>
    </div>
  `;
  acquisitionZone.appendChild(section);

  const input = document.getElementById('isbn-input') as HTMLInputElement;
  const btn = document.getElementById('btn-search') as HTMLButtonElement;

  btn.addEventListener('click', async () => {
    const isbn = input.value.trim();
    if (!isbn) return;
    
    addLog(`Lancement orchestration pour : ${isbn}...`);
    try {
      const res = await searchService.searchByIsbn(isbn);
      
      if (!res) {
        addLog(`Livre introuvable.`, "error");
        return;
      }

      addLog(`Orchestration terminée (Source: ${res.source}). Rendu de l'UI en cours...`, "success");
      
      // Rendu du composant "Livre Principal"
      renderMainBookDebugTable(res);

      // Si le contexte de série est présent, on propose d'afficher les détails
      const existingSeriesTable = document.getElementById('series-table-container');
      if (existingSeriesTable) existingSeriesTable.remove();
      
      if (res.series) {
        const btnShowSeries = document.createElement('button');
        btnShowSeries.textContent = `Afficher la série (${res.series.ownedCount}/${res.series.tomes.length} possédés)`;
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
 * Auto-Login au chargement
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
      addLog("Connecté !", "success");
      initApp();
    }
  } catch (err: any) {
    addLog("Erreur: " + err.message, "error");
  }
});

autoInit();