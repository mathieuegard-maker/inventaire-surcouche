// src/core/services/loan.service.ts
import { databaseService } from '../database/database.service';

export const loanService = {
  userUri: null as string | null,
  shelfId: null as string | null,
  shelfName: 'Prêts',
  // Cache en mémoire pour éviter les re-téléchargements inutiles
  cachedInventoryMap: null as Record<string, string> | null,

  async safeFetch(url: string, options?: RequestInit): Promise<any> {
    console.log(`[LOAN DEBUG] 🚀 fetch: ${options?.method || 'GET'} ${url}`);
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      if (!response.ok) {
        console.error(`[LOAN DEBUG] ❌ Erreur API:`, text.substring(0, 250));
        throw new Error(`HTTP Error ${response.status}`);
      }
      return JSON.parse(text);
    } catch (error) {
      console.error(`[LOAN DEBUG] 💥 Exception:`, error);
      throw error;
    }
  },

  /**
   * Construit ou récupère le dictionnaire des IDs physiques de l'inventaire
   */
  async getInventoryMap(): Promise<Record<string, string>> {
    if (this.cachedInventoryMap) {
       console.log(`[LOAN SERVICE] Utilisation du cache mémoire pour l'inventaire`);
       return this.cachedInventoryMap;
    }
    
    if (!this.userUri) return {};
    
    try {
      const res = await fetch(`/api/gateway?action=inventory-list&uri=${encodeURIComponent(this.userUri)}`);
      const data = await res.json();
      const items = data.items || [];
      const itemList = Array.isArray(items) ? items : Object.values(items);
      
      const map: Record<string, string> = {};
      for (const item of itemList) {
        const id = item._id || item.id;
        const entity = (typeof item.entity === 'string') ? item.entity : (item.entity?.uri || item.uri);
        if (id && entity) map[id] = entity;
      }
      
      this.cachedInventoryMap = map; // Sauvegarde en mémoire
      return map;
    } catch (e) {
      console.error("[LOAN SERVICE] Erreur récupération dictionnaire:", e);
      return {};
    }
  },

  /**
   * OPTIMISATION : Trouve l'ID physique sans faire de nouvel appel réseau
   */
  async getInventoryItemId(entityUri: string): Promise<string | null> {
    if (!this.userUri) return null;
    
    // On utilise la map construite (qui sera piochée dans le cache si elle existe déjà)
    const map = await this.getInventoryMap();
    
    // Recherche inversée : trouver la clé (ID physique) à partir de la valeur (URI logique)
    const itemId = Object.keys(map).find(key => map[key] === entityUri);
    
    if (!itemId) {
        console.warn(`[LOAN SERVICE] Impossible de trouver l'exemplaire physique pour ${entityUri}`);
    }
    
    return itemId || null;
  },

  async initializeShelf(): Promise<string | null> {
    if (this.shelfId) return this.shelfId;
    if (!this.userUri) return null;
    
    try {
      const data = await this.safeFetch(`/api/gateway?action=shelves&path=by-owners&owners=${encodeURIComponent(this.userUri)}`);
      let shelvesArray = Array.isArray(data.shelves) ? data.shelves : (data.shelves ? Object.values(data.shelves) : (Array.isArray(data) ? data : Object.values(data)));
      let shelf = shelvesArray.find((s: any) => s && s.name === this.shelfName);

      if (!shelf) {
        const createData = await this.safeFetch('/api/gateway?action=shelves', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.shelfName, description: 'Carnet de prêts local Epiqoi' })
        });
        shelf = createData.shelf || createData;
      }

      this.shelfId = shelf._id || shelf.id;
      return this.shelfId;
    } catch (error) {
      console.error("[LOAN SERVICE] Erreur d'initialisation:", error);
      return null;
    }
  },

  async sync(userUri: string, preloadedInventoryItems?: any[]): Promise<void> {
    console.group("[LOAN SERVICE] Synchronisation des prêts");
    this.userUri = userUri;
    
    try {
      const shelfId = await this.initializeShelf();
      if (!shelfId) throw new Error("Étagère introuvable.");

      const data = await this.safeFetch(`/api/gateway?action=shelves&path=by-ids&ids=${encodeURIComponent(shelfId)}&with-items-ids=true`);
      let shelvesArray = Array.isArray(data.shelves) ? data.shelves : (data.shelves ? Object.values(data.shelves) : (Array.isArray(data) ? data : Object.values(data)));
      const shelf = shelvesArray.find((s: any) => s && (s._id === shelfId || s.id === shelfId)) || shelvesArray[0];

      const items = shelf?.items || [];
      const distantItemIds: string[] = items.map((item: any) => item._id || item.id || item).filter(Boolean);
      const localLoans = await databaseService.getAllLoans();
      
      if (preloadedInventoryItems && preloadedInventoryItems.length > 0) {
        console.log(`[LOAN SERVICE] Remplissage du cache avec ${preloadedInventoryItems.length} items pré-chargés`);
        this.cachedInventoryMap = preloadedInventoryItems.reduce((acc, item) => {
          const id = item._id || item.id;
          const entity = (typeof item.entity === 'string') ? item.entity : (item.entity?.uri || item.uri);
          if (id && entity) acc[id] = entity;
          return acc;
        }, {} as Record<string, string>);
      }
      
      const inventoryMap = await this.getInventoryMap();
      
      console.log(`[LOAN DEBUG] IDs physiques sur l'étagère :`, distantItemIds);

      for (const localLoan of localLoans) {
        const isStillOnShelf = distantItemIds.includes(localLoan.itemId!) || distantItemIds.some(dId => inventoryMap[dId] === localLoan.uri);
        
        if (!isStillOnShelf) {
          console.log(`[LOAN SERVICE] Retour détecté pour ${localLoan.uri}. Suppression locale.`);
          await databaseService.deleteLoan(localLoan.uri);
        }
      }

      for (const distantId of distantItemIds) {
        const isKnownLocally = localLoans.some(l => l.itemId === distantId || l.uri === inventoryMap[distantId]);
        if (!isKnownLocally) {
          const entityUri = inventoryMap[distantId] || distantId;
          console.log(`[LOAN SERVICE] Prêt web détecté (${entityUri}). Ajout local.`);
          await databaseService.saveLoan({
            uri: entityUri,
            friendName: 'Inconnu (Ajout web)',
            loanDate: Date.now(),
            itemId: distantId
          });
        }
      }
      console.log("[LOAN SERVICE] Synchronisation terminée avec succès.");
    } catch (error) {
      console.error("[LOAN SERVICE] Erreur:", error);
    } finally {
      console.groupEnd();
    }
  },

  async lend(uri: string, friendName: string): Promise<boolean> {
    try {
      const shelfId = await this.initializeShelf();
      if (!shelfId) throw new Error("Étagère non initialisée");

      // Appelle désormais la méthode optimisée qui pioche dans le cache
      const itemId = await this.getInventoryItemId(uri);
      if (!itemId) throw new Error(`Exemplaire physique introuvable pour ${uri}`);

      await this.safeFetch('/api/gateway?action=shelves&path=add-items', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: shelfId, items: [itemId] }) 
      });

      await databaseService.saveLoan({ 
        uri, 
        friendName, 
        loanDate: Date.now(),
        itemId 
      });

      console.log(`[LOAN SERVICE] Livre ${uri} prêté à ${friendName}`);
      return true;
    } catch (error) {
      console.error("[LOAN SERVICE] Erreur prêt:", error);
      return false;
    }
  },

  async returnBook(uri: string): Promise<boolean> {
    try {
      const shelfId = await this.initializeShelf();
      if (!shelfId) throw new Error("Étagère non initialisée");

      const localLoan = await databaseService.getLoan(uri);
      // Appelle désormais la méthode optimisée qui pioche dans le cache
      const itemId = localLoan?.itemId || await this.getInventoryItemId(uri);
      if (!itemId) throw new Error(`Exemplaire physique introuvable pour ${uri}`);

      await this.safeFetch('/api/gateway?action=shelves&path=remove-items', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: shelfId, items: [itemId] })
      });

      await databaseService.deleteLoan(uri);
      console.log(`[LOAN SERVICE] Livre ${uri} rendu.`);
      return true;
    } catch (error) {
      console.error("[LOAN SERVICE] Erreur retour:", error);
      return false;
    }
  }
};