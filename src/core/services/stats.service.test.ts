// src/core/services/stats.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { statsService } from './stats.service';
import { databaseService } from '../database/database.service';

// --- MOCKING ---
vi.mock('../database/database.service', () => ({
  databaseService: {
    getAllRegistryEntries: vi.fn(),
    getAllLoans: vi.fn(),
    getAllCachedBooks: vi.fn()
  }
}));

describe('Stats Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('doit calculer correctement les statistiques globales et le top genres/auteurs', async () => {
    // Mock données
    const now = Date.now();
    const inventory = [
      { uri: 'inv:book1', addedAt: now - 5 * 24 * 60 * 60 * 1000 }, // 5 jours
      { uri: 'inv:book2', addedAt: now - 45 * 24 * 60 * 60 * 1000 }, // 45 jours
      { uri: 'inv:book3', addedAt: now - 100 * 24 * 60 * 60 * 1000 } // 100 jours
    ];
    const wishlist = [
      { uri: 'inv:wish1', addedAt: now },
      { uri: 'inv:wish2', addedAt: now }
    ];
    const loans = [
      { uri: 'inv:book1', itemId: 'item1', friendName: 'Jean', loanDate: now - 5 * 24 * 60 * 60 * 1000 }, // 5 jours
      { uri: 'inv:book2', itemId: 'item2', friendName: 'Marc', loanDate: now - 45 * 24 * 60 * 60 * 1000 } // 45 jours
    ];
    const cachedBooks = [
      {
        uri: 'inv:book1',
        ownershipStatus: 'owned',
        seriesId: 'seriesA',
        authors: ['Hergé'],
        genres: ['Aventure']
      },
      {
        uri: 'inv:book2',
        ownershipStatus: 'owned',
        seriesId: 'seriesA',
        authors: ['Hergé', 'Goscinny'],
        genres: ['Aventure', 'Humour']
      },
      {
        uri: 'inv:book3',
        ownershipStatus: 'owned',
        seriesId: 'seriesB',
        authors: ['Uderzo'],
        genres: ['Humour']
      }
    ];

    vi.mocked(databaseService.getAllRegistryEntries).mockImplementation(async (table) => {
      if (table === 'inventory') return inventory;
      if (table === 'wishlist') return wishlist;
      return [];
    });

    vi.mocked(databaseService.getAllLoans).mockResolvedValue(loans as any[]);
    vi.mocked(databaseService.getAllCachedBooks).mockResolvedValue(cachedBooks as any[]);

    // 1. Calculer avec une période de 30 jours
    const stats30 = await statsService.getDashboardStats(30);
    
    expect(stats30.totalOwned).toBe(3);
    expect(stats30.totalWishlist).toBe(2);
    expect(stats30.totalLoans).toBe(2);
    expect(stats30.totalSeries).toBe(2); // seriesA, seriesB
    expect(stats30.loanRate).toBe(67); // 2 / 3 = 67%
    expect(stats30.acquiredInPeriod).toBe(1); // Seulement le livre 1 (5 jours < 30)
    expect(stats30.loansInPeriod).toBe(1); // Seulement le prêt Jean (5 jours < 30)

    // Top genres et auteurs
    expect(stats30.topGenres).toEqual([
      { name: 'Aventure', count: 2 },
      { name: 'Humour', count: 2 }
    ]);
    expect(stats30.topAuthors).toEqual([
      { name: 'Hergé', count: 2 },
      { name: 'Goscinny', count: 1 },
      { name: 'Uderzo', count: 1 }
    ]);

    // 2. Calculer avec une période de 90 jours
    const stats90 = await statsService.getDashboardStats(90);
    expect(stats90.acquiredInPeriod).toBe(2); // livre 1 (5 jours) et livre 2 (45 jours)
    expect(stats90.loansInPeriod).toBe(2); // Jean (5j) et Marc (45j)

    // 3. Calculer avec historique complet (-1)
    const statsAll = await statsService.getDashboardStats(-1);
    expect(statsAll.acquiredInPeriod).toBe(3);
    expect(statsAll.loansInPeriod).toBe(2);
  });
});
