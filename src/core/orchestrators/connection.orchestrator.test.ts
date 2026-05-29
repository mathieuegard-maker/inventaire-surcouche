// src/core/orchestrators/connection.orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectionService } from './connection.orchestrator';
import { userService } from '../services/user.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import { loanService } from '../services/loan.service';
import { sessionStore } from '../../state/session';
import { connectionState } from '../../state/connection';
//import { syncOrchestrator } from './sync.orchestrator';

// --- 1. MOCKING DES SERVICES (Les Simulacres) ---
vi.mock('../services/user.service', () => ({
  userService: { fetchProfile: vi.fn() }
}));

vi.mock('../services/inventory.service', () => ({
  inventoryService: { loadLibrary: vi.fn() }
}));

vi.mock('../services/wishlist.service', () => ({
  wishlistService: { loadWishlist: vi.fn() }
}));

vi.mock('../services/loan.service', () => ({
  loanService: { sync: vi.fn() }
}));

// NOUVEAU : On mocke le syncOrchestrator car la fonction a déménagé
vi.mock('./sync.orchestrator', () => ({
  syncOrchestrator: { hydrateCacheInBackground: vi.fn() }
}));

// --- 2. LE CAHIER DE TESTS ---
describe('Connection Orchestrator', () => {
  
  beforeEach(() => {
    vi.clearAllMocks();
    connectionService.isInitialized = false;
    connectionService.userUri = null;
  });

  it('ne doit pas démarrer si aucun utilisateur n\'est connecté', async () => {
    vi.mocked(userService.fetchProfile).mockResolvedValue(null);
    const result = await connectionService.initializeApp();
    expect(result).toBe(false);
    expect(connectionService.isInitialized).toBe(false);
  });

  it('doit démarrer même si la wishlist plante (Tolérance aux pannes)', async () => {
    const fakeItems = [{ id: '1', entity: 'wd:Q1' }];
    vi.mocked(userService.fetchProfile).mockResolvedValue({ uri: 'wd:User', username: 'Test' } as any);
    vi.mocked(inventoryService.loadLibrary).mockResolvedValue({ count: 1, items: fakeItems });
    vi.mocked(wishlistService.loadWishlist).mockRejectedValue(new Error('Serveur HS'));
    vi.mocked(loanService.sync).mockResolvedValue();

    const result = await connectionService.initializeApp();

    expect(result).toBe(true);
    expect(connectionService.isInitialized).toBe(true);
  });

  it('doit transmettre les données d\'inventaire aux prêts (Pas de double requête réseau)', async () => {
    const fakeItems = [
      { id: '1', entity: 'wd:Q1' },
      { id: '2', entity: 'wd:Q2' }
    ];
    vi.mocked(userService.fetchProfile).mockResolvedValue({ uri: 'wd:User', username: 'Test' } as any);
    vi.mocked(inventoryService.loadLibrary).mockResolvedValue({ count: 2, items: fakeItems });
    vi.mocked(wishlistService.loadWishlist).mockResolvedValue(undefined as any);
    vi.mocked(loanService.sync).mockResolvedValue();

    await connectionService.initializeApp();

    expect(loanService.sync).toHaveBeenCalledWith('wd:User', fakeItems);
  });

  it('doit vider la session locale et retourner false si le profil à distance renvoie une erreur d\'authentification (ex: 401)', async () => {
    const authError = new Error('Unauthorized') as any;
    authError.status = 401;
    vi.mocked(userService.fetchProfile).mockRejectedValue(authError);
    
    const spyClear = vi.spyOn(sessionStore, 'clearSession');
    
    const result = await connectionService.initializeApp();
    
    expect(result).toBe(false);
    expect(spyClear).toHaveBeenCalled();
  });

  it('doit s\'initialiser avec un profil invité temporaire s\'il n\'y a ni cookie ni session locale mais qu\'on est hors-ligne', async () => {
    // 1. Simuler l'état hors-ligne
    connectionState.isOffline.value = true;
    
    // 2. S'assurer que la restauration locale échoue
    vi.spyOn(sessionStore, 'restoreSessionFromLocalStorage').mockReturnValue(false);
    sessionStore.state.user = null;

    const result = await connectionService.initializeApp();

    expect(result).toBe(true);
    expect(connectionService.userUri).toBe('wd:offline_guest');
    
    // Rétablir l'état par défaut après le test
    connectionState.isOffline.value = false;
  });

  describe('checkSessionOnReconnection', () => {
    it('doit retourner true et mettre à jour le userUri si fetchProfile réussit', async () => {
      vi.mocked(userService.fetchProfile).mockResolvedValue({ uri: 'wd:UserOnline', username: 'OnlineUser' } as any);
      
      const result = await connectionService.checkSessionOnReconnection();
      
      expect(result).toBe(true);
      expect(connectionService.userUri).toBe('wd:UserOnline');
    });

    it('doit appeler clearSession et retourner false si fetchProfile échoue', async () => {
      vi.mocked(userService.fetchProfile).mockRejectedValue(new Error('Unauthorized'));
      const spyClear = vi.spyOn(sessionStore, 'clearSession');
      
      const result = await connectionService.checkSessionOnReconnection();
      
      expect(result).toBe(false);
      expect(spyClear).toHaveBeenCalled();
    });
  });
});