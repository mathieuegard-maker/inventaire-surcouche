// src/core/services/loan.service.ts
import { databaseService } from '../database/database.service';
import { TEXTS } from '../../ui/locales/fr';
import { fetchWithTimeout } from '../../state/connection';

export const loanService = {
  userUri: null as string | null,
  shelfId: null as string | null,
  shelfName: 'Prêts',
  // Cache en mémoire pour éviter les re-téléchargements inutiles
  cachedInventoryMap: null as Record<string, string> | null,

  async safeFetch(url: string, options?: RequestInit): Promise<any> {
    console.log(`[LOAN DEBUG] 🚀 fetch: ${options?.method || 'GET'} ${url}`);
    try {
      const response = await fetchWithTimeout(url, options);
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
      const res = await fetchWithTimeout(`/api/gateway?action=inventory-list&uri=${encodeURIComponent(this.userUri)}`);
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

  invalidateInventoryCache() {
    this.cachedInventoryMap = null;
  },

  /**
   * OPTIMISATION : Trouve l'ID physique sans faire de nouvel appel réseau
   */
  async getInventoryItemId(entityUri: string): Promise<string | null> {
    if (!this.userUri) return null;

    // 1. Lookup direct via le registre local (si itemId déjà connu)
    const entry = await databaseService.getRegistryEntry('inventory', entityUri);
    if (entry?.itemId) {
      if (this.cachedInventoryMap) {
        this.cachedInventoryMap[entry.itemId] = entityUri;
      }
      return entry.itemId;
    }

    // 2. Sinon recherche dans la map mémoire (avec un rafraîchissement si le cache était déjà peuplé)
    const hadCache = Boolean(this.cachedInventoryMap);
    let map = await this.getInventoryMap();
    let itemId = Object.keys(map).find(key => map[key] === entityUri);

    if (!itemId && hadCache) {
      this.cachedInventoryMap = null;
      map = await this.getInventoryMap();
      itemId = Object.keys(map).find(key => map[key] === entityUri);
    }

    if (!itemId) {
      // Repli V4 : si le livre est géré par `v4_library_books` sans entrée legacy `library_items`, utiliser son URI canonique
      return entityUri;
    }

    return itemId || null;
  },

  async initializeShelf(): Promise<string | null> {
    if (this.shelfId) return this.shelfId;
    if (!this.userUri) return null;
    
    try {
      const data = await this.safeFetch(`/api/gateway?action=shelves&path=by-owners&owners=${encodeURIComponent(this.userUri)}`);
      const shelvesArray = Array.isArray(data.shelves)
        ? data.shelves
        : data.shelves
          ? Object.values(data.shelves)
          : [];
      const shelf: any = shelvesArray.find((s: any) => s && (s.name === this.shelfName || String(s.name || '').startsWith('Prêts')));
      if (shelf) {
        this.shelfId = shelf._id || shelf.id;
        return this.shelfId;
      }
      return 'shelf_default';
    } catch (error) {
      console.error("[LOAN SERVICE] Erreur d'initialisation:", error);
      return null;
    }
  },

  async sync(userUri: string, preloadedInventoryItems?: any[]): Promise<void> {
    console.group("[LOAN SERVICE] Synchronisation des prêts");
    this.userUri = userUri;
    
    try {
      const data = await this.safeFetch(`/api/gateway?action=shelves&path=by-owners&owners=${encodeURIComponent(this.userUri)}`);
      const shelvesArray: any[] = Array.isArray(data.shelves)
        ? data.shelves
        : data.shelves
          ? Object.values(data.shelves)
          : [];

      const distantLoanByItemId = new Map<string, { shelfId: string; borrowerName: string; loanDate: number }>();
      for (const s of shelvesArray) {
        if (!s) continue;
        const rawName = String(s.name || '');
        const borrower = rawName.replace(/^Prêts?\s*[-:]?\s*/i, '').trim() || TEXTS.loansView?.unknownFriendWeb || 'Inconnu';
        const parsedTs = Number(s.description);
        const loanDate = Number.isFinite(parsedTs) && parsedTs > 1000000000 ? parsedTs : Date.now();
        for (const rawItem of s.items || []) {
          const itemId = rawItem?._id || rawItem?.id || rawItem;
          if (typeof itemId === 'string' && itemId.trim()) {
            distantLoanByItemId.set(itemId.trim(), {
              shelfId: s._id || s.id,
              borrowerName: borrower,
              loanDate
            });
          }
        }
      }
      const distantItemIds = Array.from(distantLoanByItemId.keys());
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
        const isStillOnShelf =
          (localLoan.itemId && distantItemIds.includes(localLoan.itemId)) ||
          distantItemIds.includes(localLoan.uri) ||
          distantItemIds.some(dId => inventoryMap[dId] === localLoan.uri);
        
        if (!isStillOnShelf) {
          console.log(`[LOAN SERVICE] Retour détecté pour ${localLoan.uri}. Suppression locale.`);
          await databaseService.deleteLoan(localLoan.uri);
        }
      }

      for (const distantId of distantItemIds) {
        const entityUri = inventoryMap[distantId] || distantId;
        const isKnownLocally = localLoans.some(l => l.itemId === distantId || l.uri === entityUri);
        if (!isKnownLocally) {
          const meta = distantLoanByItemId.get(distantId);
          console.log(`[LOAN SERVICE] Prêt web détecté (${entityUri}). Ajout local.`);
          await databaseService.saveLoan({
            uri: entityUri,
            friendName: meta?.borrowerName || TEXTS.loansView?.unknownFriendWeb || 'Inconnu (Ajout web)',
            loanDate: meta?.loanDate || Date.now(),
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
      const itemId = (await this.getInventoryItemId(uri)) || uri;
      const loanTimestamp = Date.now();

      const createData = await this.safeFetch('/api/gateway?action=shelves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Prêts - ${friendName.trim()}`,
          description: String(loanTimestamp),
          items: [itemId]
        })
      });
      const createdShelfId = createData?.shelf?._id || createData?._id;
      if (createdShelfId) {
        this.shelfId = createdShelfId;
      }

      await databaseService.saveLoan({ 
        uri, 
        friendName: friendName.trim(), 
        loanDate: loanTimestamp,
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
      const shelfId = (await this.initializeShelf()) || 'shelf_default';
      const localLoan = await databaseService.getLoan(uri);
      const itemId = localLoan?.itemId || (await this.getInventoryItemId(uri)) || uri;

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