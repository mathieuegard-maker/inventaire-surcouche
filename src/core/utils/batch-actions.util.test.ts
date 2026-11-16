// src/core/utils/batch-actions.util.test.ts
import { describe, it, expect } from 'vitest';
import { computeCommonBatchActions } from './batch-actions.util';

describe('computeCommonBatchActions', () => {
  it('autorise uniquement Collection lorsqu’on sélectionne un Non possédé et un À avoir', () => {
    const res = computeCommonBatchActions([
      { ownershipStatus: 'none' },
      { ownershipStatus: 'wish' }
    ]);
    expect(res.actions).toEqual(['ADD_INVENTORY']);
    expect(res.isHomogeneousDelete).toBeNull();
  });

  it('autorise Collection et Wishlist si tous sont Non possédés', () => {
    const res = computeCommonBatchActions([
      { ownershipStatus: 'none' },
      { ownershipStatus: 'none' }
    ]);
    expect(res.actions).toEqual(['ADD_INVENTORY', 'ADD_WISHLIST']);
    expect(res.isHomogeneousDelete).toBeNull();
  });

  it('autorise Prêter, Basculer et Supprimer si tous sont Possédés disponibles', () => {
    const res = computeCommonBatchActions([
      { ownershipStatus: 'owned' },
      { ownershipStatus: 'owned' }
    ]);
    expect(res.actions).toEqual(['LEND', 'TOGGLE_WISHLIST', 'DELETE']);
    expect(res.isHomogeneousDelete).toBe('owned');
  });

  it('autorise Rendre et Supprimer si tous sont Prêtés', () => {
    const res = computeCommonBatchActions([
      { ownershipStatus: 'owned', loan: { uri: 'inv:1', friendName: 'Alice', loanDate: 1 } }
    ]);
    expect(res.actions).toEqual(['RETURN', 'DELETE']);
    expect(res.isHomogeneousDelete).toBe('lent');
  });

  it('ne propose aucune action commune si Possédé et Non possédé sont mélangés', () => {
    const res = computeCommonBatchActions([
      { ownershipStatus: 'owned' },
      { ownershipStatus: 'none' }
    ]);
    expect(res.actions).toEqual([]);
    expect(res.isHomogeneousDelete).toBeNull();
  });
});
