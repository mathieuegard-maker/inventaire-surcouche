// src/core/orchestrators/queue.orchestrator.ts
import { databaseService, type PendingAction } from '../database/database.service';
import { loanService } from '../services/loan.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import type { LendPayload, QueueActionPayload, RemoveInventoryPayload } from '../types';
import { TEXTS } from '../../ui/locales/fr';
import { connectionState } from '../../state/connection';

const MAX_BULK_CHUNK = 15;

/**
 * Utilitaire pour insérer une pause et éviter de surcharger l'API
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const queueService = {
  isProcessing: false,

  /**
   * Applique instantanément les changements dans la base de données locale
   * pour que le cache reste synchrone avec l'état de l'interface utilisateur.
   */
  async applyOptimisticUpdate(actionType: PendingAction['action'], uri: string, payload?: QueueActionPayload): Promise<void> {
    const cachedBook = await databaseService.getBookFromCache(uri);
    
    switch (actionType) {
      case 'ADD_INVENTORY':
        await databaseService.addRegistryEntry('inventory', uri);
        await databaseService.removeRegistryEntry('wishlist', uri);
        if (cachedBook?.workUri) {
          await databaseService.removeRegistryEntry('wishlist', cachedBook.workUri);
        }
        if (cachedBook) {
          cachedBook.ownershipStatus = 'owned';
          await databaseService.saveBookToCache(cachedBook);
        }
        break;
      case 'ADD_WISHLIST':
        await databaseService.addRegistryEntry('wishlist', uri);
        if (cachedBook) {
          cachedBook.ownershipStatus = 'wish';
          await databaseService.saveBookToCache(cachedBook);
        }
        break;
      case 'REMOVE_INVENTORY':
        await databaseService.removeRegistryEntry('inventory', uri);
        await databaseService.deleteLoan(uri).catch(() => {});
        if (cachedBook) {
          const isWished =
            (await databaseService.isUriInRegistry('wishlist', cachedBook.uri)) ||
            (cachedBook.workUri ? await databaseService.isUriInRegistry('wishlist', cachedBook.workUri) : false);
          cachedBook.ownershipStatus = isWished ? 'wish' : 'none';
          cachedBook.loan = undefined;
          await databaseService.saveBookToCache(cachedBook);
        }
        break;
      case 'REMOVE_WISHLIST':
        await databaseService.removeRegistryEntry('wishlist', uri);
        if (cachedBook) {
          const isOwned =
            (await databaseService.isUriInRegistry('inventory', cachedBook.uri)) ||
            (cachedBook.workUri ? await databaseService.isUriInRegistry('inventory', cachedBook.workUri) : false);
          cachedBook.ownershipStatus = isOwned ? 'owned' : 'none';
          await databaseService.saveBookToCache(cachedBook);
        }
        break;
      case 'LEND':
        // OPTIMISTIC LOAN : Écriture instantanée du prêt localement
        const lendData = payload as LendPayload;
        await databaseService.saveLoan({
          uri,
          friendName: lendData?.friendName || TEXTS.loansView?.unknownFriend || 'Inconnu',
          loanDate: Date.now()
        });
        break;
      case 'RETURN':
        // OPTIMISTIC RETURN : Retrait instantané du prêt localement
        await databaseService.deleteLoan(uri);
        break;
    }
  },

  /**
   * Étape 1 de l'Optimistic UI : Enregistre une action en base locale pour libérer l'interface
   * et tente de l'exécuter en arrière-plan.
   */
  async enqueueAction(actionType: PendingAction['action'], uri: string, payload?: QueueActionPayload): Promise<void> {
    if (connectionState.isOffline.value) {
      console.error("[QUEUE] Action d'écriture refusée : l'application est hors-ligne.");
      throw new Error("Action impossible hors-ligne");
    }

    console.group(`[QUEUE] Nouvelle action interceptée: ${actionType} sur ${uri}`);

    let effectivePayload = payload;
    if (actionType === 'REMOVE_INVENTORY' && !(payload as RemoveInventoryPayload | undefined)?.itemId) {
      const existingEntry = await databaseService.getRegistryEntry('inventory', uri);
      if (existingEntry?.itemId) {
        effectivePayload = { itemId: existingEntry.itemId };
      }
    } else if (actionType === 'RETURN' && !effectivePayload) {
      const existingLoan = await databaseService.getLoan(uri).catch(() => undefined);
      if (existingLoan?.friendName) {
        effectivePayload = { friendName: existingLoan.friendName };
      }
    }
    
    const action: PendingAction = {
      action: actionType,
      uri,
      payload: effectivePayload,
      status: 'pending',
      createdAt: Date.now()
    };

    const actionId = await databaseService.savePendingAction(action);
    console.log(`[QUEUE] Trace sauvegardée localement (ID: ${actionId})`);
    
    await this.applyOptimisticUpdate(actionType, uri, payload);
    console.log(`[QUEUE] Mise à jour optimiste appliquée en base locale pour : ${uri}`);
    
    console.groupEnd();

    // Lancement asynchrone du traitement groupé
    this.processQueue();
  },

  /**
   * Étape 2 : Dépile et exécute séquentiellement les actions en paquets (Batching)
   */
  async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    console.group(`[QUEUE] Démarrage du traitement par paquets (Anti-429)...`);

    try {
      while (true) {
        const actions = await databaseService.getPendingActions();
        
        if (actions.length === 0) {
          console.log(`[QUEUE] 🎉 Toutes les actions groupées ont été transmises au serveur.`);
          break;
        }

        const firstActionType = actions[0].action;
        const allOfType = actions.filter(a => a.action === firstActionType);
        const chunk = firstActionType === 'ADD_INVENTORY'
          ? allOfType.slice(0, MAX_BULK_CHUNK)
          : allOfType;
        const urisToProcess = chunk.map(a => a.uri);
        const batchIds = chunk.map(a => a.id).filter((id): id is number => id !== undefined);
        let rollbackTargets = chunk;

        console.log(`[QUEUE] Création d'un paquet de type [${firstActionType}] contenant ${urisToProcess.length} éléments.`);

        try {
          let success = false;

          switch (firstActionType) {
            case 'ADD_INVENTORY':
              success = await inventoryService.addBulkToLibrary(urisToProcess);
              if (success) {
                try {
                  console.log(`[QUEUE] Cascade Réseau : Nettoyage automatique de la Wishlist pour ${urisToProcess.length} éléments...`);
                  await wishlistService.removeFromWishlist(urisToProcess);
                } catch (wishCascadeError) {
                  console.error(`[QUEUE] ⚠️ Échec non-bloquant du nettoyage de la Wishlist sur le serveur :`, wishCascadeError);
                }
              }
              break;
            case 'ADD_WISHLIST':
              success = await wishlistService.addBulkToWishlist(urisToProcess);
              break;
            case 'REMOVE_INVENTORY': {
              let allOk = true;
              for (let i = 0; i < chunk.length; i++) {
                const singleAction = chunk[i];
                rollbackTargets = chunk.slice(i);
                const removePayload = singleAction.payload as RemoveInventoryPayload | undefined;
                const ok = await inventoryService.removeFromLibrary(singleAction.uri, removePayload?.itemId);
                if (ok && singleAction.id) {
                  await databaseService.deletePendingAction(singleAction.id);
                } else {
                  allOk = false;
                  break;
                }
              }
              if (!allOk) {
                console.warn(`[QUEUE] ⚠️ Échec de suppression inventaire. Pause de la synchronisation.`);
                this.isProcessing = false;
                console.groupEnd();
                return;
              }
              success = false;
              break;
            }
            case 'REMOVE_WISHLIST':
              success = await wishlistService.removeFromWishlist(urisToProcess);
              break;
            case 'LEND': {
              let allOk = true;
              for (let i = 0; i < chunk.length; i++) {
                const singleAction = chunk[i];
                rollbackTargets = chunk.slice(i);
                const lendPayload = singleAction.payload as LendPayload;
                const ok = await loanService.lend(singleAction.uri, lendPayload?.friendName || TEXTS.loansView?.unknownFriend || 'Inconnu');
                if (ok && singleAction.id) {
                  await databaseService.deletePendingAction(singleAction.id);
                } else {
                  allOk = false;
                  break; // Soft fail, on arrête ce lot pour l'instant
                }
              }
              if (!allOk) {
                console.warn(`[QUEUE] ⚠️ Échec de traitement d'un prêt. Pause de la synchronisation.`);
                this.isProcessing = false;
                console.groupEnd();
                return;
              }
              success = false; // Pour ne pas re-purger dans le bloc outer
              break;
            }
            case 'RETURN': {
              let allOk = true;
              for (let i = 0; i < chunk.length; i++) {
                const singleAction = chunk[i];
                rollbackTargets = chunk.slice(i);
                const ok = await loanService.returnBook(singleAction.uri);
                if (ok && singleAction.id) {
                  await databaseService.deletePendingAction(singleAction.id);
                } else {
                  allOk = false;
                  break;
                }
              }
              if (!allOk) {
                console.warn(`[QUEUE] ⚠️ Échec de traitement d'un retour. Pause de la synchronisation.`);
                this.isProcessing = false;
                console.groupEnd();
                return;
              }
              success = false;
              break;
            }
            default:
              console.warn(`[QUEUE] Action non gérée en paquet : ${firstActionType}`);
              success = true; 
          }

          if (success) {
            console.log(`[QUEUE] ✅ Succès du paquet réseau [${firstActionType}]. Purge brute de ${batchIds.length} tickets localement.`);
            for (const id of batchIds) {
              await databaseService.deletePendingAction(id);
            }
            await sleep(500);
          } else if (firstActionType !== 'LEND' && firstActionType !== 'RETURN' && firstActionType !== 'REMOVE_INVENTORY') {
            console.warn(`[QUEUE] ⚠️ Échec ou blocage du paquet [${firstActionType}]. Pause de la synchronisation.`);
            break; 
          }

        } catch (error: any) {
           console.error(`[QUEUE] 💥 Refus définitif du serveur pour le paquet [${firstActionType}]. Lancement des rollbacks individuels.`);
           for (const failedAction of rollbackTargets) {
             await this.rollbackAction(failedAction);
             if (failedAction.id) {
               await databaseService.deletePendingAction(failedAction.id);
             }
           }
        }
      }
    } catch (queueError) {
      console.error(`[QUEUE] Erreur critique dans la boucle de paquets :`, queueError);
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
    
    const cachedBook = await databaseService.getBookFromCache(action.uri);

    switch (action.action) {
      case 'LEND':
        await databaseService.deleteLoan(action.uri);
        break;
      case 'RETURN': {
        const restoredPayload = action.payload as LendPayload;
        await databaseService.saveLoan({
          uri: action.uri,
          friendName: restoredPayload?.friendName || TEXTS.loansView?.unknownFriendRestored || 'Inconnu (Restauration)',
          loanDate: action.createdAt
        });
        break;
      }
      case 'ADD_INVENTORY':
        await databaseService.removeRegistryEntry('inventory', action.uri);
        if (cachedBook) {
          cachedBook.ownershipStatus = 'none';
          await databaseService.saveBookToCache(cachedBook);
        }
        break;
      case 'ADD_WISHLIST':
        await databaseService.removeRegistryEntry('wishlist', action.uri);
        if (cachedBook) {
          cachedBook.ownershipStatus = 'none';
          await databaseService.saveBookToCache(cachedBook);
        }
        break;
      case 'REMOVE_INVENTORY': {
        const removePayload = action.payload as RemoveInventoryPayload | undefined;
        await databaseService.addRegistryEntry('inventory', action.uri, removePayload?.itemId);
        if (cachedBook) {
          cachedBook.ownershipStatus = 'owned';
          await databaseService.saveBookToCache(cachedBook);
        }
        break;
      }
      case 'REMOVE_WISHLIST':
        await databaseService.addRegistryEntry('wishlist', action.uri);
        if (cachedBook) {
          cachedBook.ownershipStatus = 'wish';
          await databaseService.saveBookToCache(cachedBook);
        }
        break;
    }
  }
};