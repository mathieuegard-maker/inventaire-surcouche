// src/core/orchestrators/connection.orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectionService } from './connection.orchestrator';
import { userService } from '../services/user.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import { loanService } from '../services/loan.service';

// --- 1. MOCKING DES SERVICES (Les Simulacres) ---
// On remplace les vrais appels réseau par de fausses fonctions que l'on contrôle
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

// On court-circuite la tâche de fond pour qu'elle ne gêne pas nos tests synchrones
vi.spyOn(connectionService, 'hydrateCacheInBackground').mockImplementation(async () => {});

// --- 2. LE CAHIER DE TESTS ---
describe('Connection Orchestrator', () => {
  
  // Avant chaque test, on remet tout à zéro pour qu'ils ne se polluent pas entre eux
  beforeEach(() => {
    vi.clearAllMocks();
    connectionService.isInitialized = false;
    connectionService.userUri = null;
  });

  it('ne doit pas démarrer si aucun utilisateur n\'est connecté', async () => {
    // Arrange : On simule une absence de profil
    vi.mocked(userService.fetchProfile).mockResolvedValue(null);

    // Act : On lance le démarrage
    const result = await connectionService.initializeApp();

    // Assert : On vérifie que c'est un échec propre
    expect(result).toBe(false);
    expect(connectionService.isInitialized).toBe(false);
  });

  it('doit démarrer même si la wishlist plante (Tolérance aux pannes)', async () => {
    // Arrange : On prépare nos fausses données
    const fakeItems = [{ id: '1', entity: 'wd:Q1' }];
    vi.mocked(userService.fetchProfile).mockResolvedValue({ uri: 'wd:User', username: 'Test' } as any);
    vi.mocked(inventoryService.loadLibrary).mockResolvedValue({ count: 1, items: fakeItems });
    
    // 🔥 On force la wishlist à planter (Simulation d'erreur réseau)
    vi.mocked(wishlistService.loadWishlist).mockRejectedValue(new Error('Serveur HS'));
    vi.mocked(loanService.sync).mockResolvedValue();

    // Act
    const result = await connectionService.initializeApp();

    // Assert : L'application DOIT avoir démarré malgré le crash de la wishlist
    expect(result).toBe(true);
    expect(connectionService.isInitialized).toBe(true);
  });

  it('doit transmettre les données d\'inventaire aux prêts (Pas de double requête réseau)', async () => {
    // Arrange
    const fakeItems = [
      { id: '1', entity: 'wd:Q1' },
      { id: '2', entity: 'wd:Q2' }
    ];
    vi.mocked(userService.fetchProfile).mockResolvedValue({ uri: 'wd:User', username: 'Test' } as any);
    vi.mocked(inventoryService.loadLibrary).mockResolvedValue({ count: 2, items: fakeItems });
    vi.mocked(wishlistService.loadWishlist).mockResolvedValue(undefined as any);
    vi.mocked(loanService.sync).mockResolvedValue();

    // Act
    await connectionService.initializeApp();

    // Assert : On vérifie que l'orchestrateur a bien passé les "fakeItems" au service de prêt
    expect(loanService.sync).toHaveBeenCalledWith('wd:User', fakeItems);
  });
});