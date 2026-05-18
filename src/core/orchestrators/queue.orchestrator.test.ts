// src/core/orchestrators/queue.orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueService } from './queue.orchestrator';
import { databaseService } from '../database/database.service';
import { loanService } from '../services/loan.service';
//import { inventoryService } from '../services/inventory.service';
//import { wishlistService } from '../services/wishlist.service';

// --- 1. MOCKING DES SERVICES ET DE LA BASE DE DONNÉES ---
vi.mock('../database/database.service', () => ({
  databaseService: {
    savePendingAction: vi.fn(),
    getPendingActions: vi.fn(),
    deletePendingAction: vi.fn(),
    deleteLoan: vi.fn(),
    saveLoan: vi.fn(),
    removeRegistryEntry: vi.fn()
  }
}));

vi.mock('../services/loan.service', () => ({
  loanService: {
    lend: vi.fn(),
    returnBook: vi.fn()
  }
}));

vi.mock('../services/inventory.service', () => ({
  inventoryService: {
    addToLibrary: vi.fn()
  }
}));

vi.mock('../services/wishlist.service', () => ({
  wishlistService: {
    addToWishlist: vi.fn()
  }
}));

describe('Queue Orchestrator (Optimistic UI)', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
    queueService.isProcessing = false;
  });

  it('Étape 1 : Doit enregistrer une action localement et lancer le traitement', async () => {
    // Arrange
    // On isole l'espion dans une variable
    const processSpy = vi.spyOn(queueService, 'processQueue').mockImplementation(async () => {});
    vi.mocked(databaseService.savePendingAction).mockResolvedValue(1);

    // Act
    await queueService.enqueueAction('LEND', 'wd:Q123', { friendName: 'Jean' });

    // Assert
    expect(databaseService.savePendingAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'LEND',
      uri: 'wd:Q123',
      status: 'pending'
    }));
    expect(processSpy).toHaveBeenCalled(); 

    // NETTOYAGE CRUCIAL : On rend à la fonction son vrai comportement pour les autres tests
    processSpy.mockRestore();
  });

  it('Étape 2A : Doit traiter une action avec succès et la purger de la file', async () => {
    // Arrange
    const fakeAction = { id: 1, action: 'LEND', uri: 'wd:Q123', payload: { friendName: 'Jean' } };
    vi.mocked(databaseService.getPendingActions).mockResolvedValue([fakeAction as any]);
    vi.mocked(loanService.lend).mockResolvedValue(true); // Le serveur répond OUI

    // Act
    await queueService.processQueue();

    // Assert
    expect(loanService.lend).toHaveBeenCalledWith('wd:Q123', 'Jean');
    expect(databaseService.deletePendingAction).toHaveBeenCalledWith(1); // Action purgée
  });

  it('Étape 2B : Doit conserver l\'action en cas de "Soft Fail" (ex: perte de réseau dans la cave)', async () => {
    // Arrange
    const fakeAction = { id: 2, action: 'LEND', uri: 'wd:Q123', payload: { friendName: 'Jean' } };
    vi.mocked(databaseService.getPendingActions).mockResolvedValue([fakeAction as any]);
    vi.mocked(loanService.lend).mockResolvedValue(false); // Le réseau échoue silencieusement

    // Act
    await queueService.processQueue();

    // Assert
    expect(loanService.lend).toHaveBeenCalled();
    // CRUCIAL : On ne supprime PAS l'action, elle sera retentée plus tard
    expect(databaseService.deletePendingAction).not.toHaveBeenCalled();
  });

  it('Étape 3 : Doit déclencher un Rollback local en cas de "Hard Fail" (ex: refus définitif du serveur)', async () => {
    // Arrange
    const fakeAction = { id: 3, action: 'LEND', uri: 'wd:Q123', payload: { friendName: 'Jean' } };
    vi.mocked(databaseService.getPendingActions).mockResolvedValue([fakeAction as any]);
    // Simulation d'une API qui explose (livre inexistant côté serveur)
    vi.mocked(loanService.lend).mockRejectedValue(new Error('Livre introuvable sur le serveur web'));

    // Act
    await queueService.processQueue();

    // Assert
    // 1. Le Rollback doit avoir supprimé le faux prêt local pour se réaligner avec la réalité
    expect(databaseService.deleteLoan).toHaveBeenCalledWith('wd:Q123'); 
    // 2. L'action est purgée pour ne pas boucler indéfiniment sur une erreur fatale
    expect(databaseService.deletePendingAction).toHaveBeenCalledWith(3);
  });
});