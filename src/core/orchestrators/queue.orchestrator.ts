// src/core/orchestrators/queue.orchestrator.ts
import { databaseService, type PendingAction } from '../database/database.service';
import { loanService } from '../services/loan.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import type { LendPayload, QueueActionPayload } from '../types';

export const queueService = {
  isProcessing: false,

  /**
   * Étape 1 de l'Optimistic UI : Enregistre une action en base locale pour libérer l'interface
   * et tente de l'exécuter en arrière-plan.
   */
  async enqueueAction(actionType: PendingAction['action'], uri: string, payload?: QueueActionPayload): Promise<void> {
    console.group(`[QUEUE] Nouvelle action interceptée: ${actionType} sur ${uri}`);
    
    const action: PendingAction = {
      action: actionType,
      uri,
      payload,
      status: 'pending',
      createdAt: Date.now()
    };

    const actionId = await databaseService.savePendingAction(action);
    console.log(`[QUEUE] Trace sauvegardée localement (ID: ${actionId})`);
    console.groupEnd();

    // Lancement "Fire and Forget" du traitement
    this.processQueue();
  },

  /**
   * Étape 2 : Dépile et exécute séquentiellement les actions en attente vers le serveur
   */
  async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const actions = await databaseService.getPendingActions();
      if (actions.length === 0) {
        this.isProcessing = false;
        return;
      }

      console.group(`[QUEUE] Démarrage du traitement de ${actions.length} actions en attente...`);

      for (const action of actions) {
        if (!action.id) continue;

        try {
          let success = false;

          // Aiguillage réseau selon le type d'action
          switch (action.action) {
            case 'LEND':
              const lendPayload = action.payload as LendPayload;
              success = await loanService.lend(action.uri, lendPayload?.friendName || 'Inconnu');
              break;
            case 'RETURN':
              success = await loanService.returnBook(action.uri);
              break;
            case 'ADD_INVENTORY':
              success = await inventoryService.addToLibrary(action.uri);
              break;
            case 'ADD_WISHLIST':
              success = await wishlistService.addToWishlist(action.uri);
              break;
            default:
              console.warn(`[QUEUE] Action non reconnue: ${action.action}`);
              success = true; // Auto-validation pour purge
          }

          if (success) {
            console.log(`[QUEUE] ✅ Succès réseau pour ${action.action} sur ${action.uri}`);
            await databaseService.deletePendingAction(action.id);
          } else {
            console.warn(`[QUEUE] ⚠️ Soft Fail pour ${action.action}. Mise en attente pour la prochaine synchronisation.`);
            // Sortie de boucle immédiate en cas de perte de réseau pour ne pas bloquer les autres
            break; 
          }

        } catch (error: any) {
           console.error(`[QUEUE] 💥 Hard Fail (Refus Serveur) pour ${action.action}:`, error);
           await this.rollbackAction(action);
           await databaseService.deletePendingAction(action.id);
        }
      }
    } finally {
      console.groupEnd();
      this.isProcessing = false;
    }
  },

  /**
   * Étape 3 (Sécurité) : Annule silencieusement l'action dans IndexedDB si le serveur la refuse définitivement.
   */
  async rollbackAction(action: PendingAction): Promise<void> {
    console.warn(`[QUEUE] ⏪ Rollback local déclenché pour ${action.action} sur ${action.uri}`);
    
    switch (action.action) {
      case 'LEND':
        // Le serveur a refusé le prêt, on l'efface de notre carnet local
        await databaseService.deleteLoan(action.uri);
        break;
      case 'RETURN':
        // Le retour a échoué, on reconstruit le prêt localement avec les bonnes données
        const restoredPayload = action.payload as LendPayload;
        await databaseService.saveLoan({
          uri: action.uri,
          friendName: restoredPayload?.friendName || 'Inconnu (Restauration)',
          loanDate: action.createdAt // On utilise la date de l'action pour combler
        });
        break;
      case 'ADD_INVENTORY':
        await databaseService.removeRegistryEntry('inventory', action.uri);
        break;
      case 'ADD_WISHLIST':
        await databaseService.removeRegistryEntry('wishlist', action.uri);
        break;
    }
    
    // NOTE ARCHITECTURE : 
    // Plus tard, nous brancherons ici un EventBus (ou Pinia) pour pousser un "Toast" visuel
    // à l'utilisateur : "La synchronisation du livre X a échoué."
  }
};