// src/services/inventory.service.ts
import { databaseService } from './database.service';

export const inventoryService = {
  async loadLibrary(uri: string): Promise<number> {
    console.group(`[INVENTORY] Chargement de la bibliothèque pour ${uri}`);
    console.log("Appel API (via proxy) en cours...");
    
    try {
      // Retour à ton appel proxy qui gère correctement l'authentification
      const res = await fetch(`/api/inventory/list?uri=${encodeURIComponent(uri)}`);
      const data = await res.json();

      if (!res.ok) {
        console.error("Échec de l'API :", data);
        console.groupEnd();
        throw new Error(data.error || "Impossible de charger l'inventaire");
      }

      const items = data.items || [];
      const itemList = Array.isArray(items) ? items : Object.values(items);
      
      const urisToSync: string[] = [];
      itemList.forEach((item: any) => {
        if (item.entity) {
          urisToSync.push(item.entity);
        }
      });

      console.log(`Données brutes reçues : ${itemList.length} items physiques.`);
      
      // CRUCIAL : On synchronise la base de données locale au lieu du Set en RAM
      await databaseService.syncRegistry('inventory', urisToSync);
      console.log(`[INVENTORY] Registre synchronisé avec succès : ${urisToSync.length} éléments.`);
      
      console.groupEnd();
      return urisToSync.length;
    } catch (error) {
      console.error("[INVENTORY] Erreur fatale :", error);
      console.groupEnd();
      throw error;
    }
  },

  /**
   * Vérification intelligente : possède-t-on cette URI OU une édition de cette œuvre ?
   */
  async isUriOwned(uri: string, workUri?: string): Promise<boolean> {
    // 1. Check direct de l'URI (Edition)
    const directMatch = await databaseService.isUriInRegistry('inventory', uri);
    if (directMatch) return true;

    // 2. Check par l'œuvre (Work)
    const targetWork = workUri || uri;
    if (targetWork.startsWith('wd:') || targetWork.startsWith('inv:')) {
      const other = await databaseService.getOtherOwnedEdition(targetWork, uri);
      return !!other;
    }

    return false;
  },

  async addToLibrary(uri: string): Promise<boolean> {
    const res = await fetch('/api/inventory/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || data.message || "Erreur lors de l'ajout à l'inventaire");
    }

    // On met à jour la base locale immédiatement
    await databaseService.addRegistryEntry('inventory', uri);
    
    return true;
  },

  async addBulkToLibrary(uris: string[]): Promise<boolean> {
    const res = await fetch('/api/inventory/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      console.error("[DEBUG BULK ERROR]", data);
      throw new Error(data.status_verbose || data.error || "Erreur inconnue du serveur");
    }

    // Ajout massif dans le cache local
    for (const uri of uris) {
      await databaseService.addRegistryEntry('inventory', uri);
    }
    return true;
  }
};