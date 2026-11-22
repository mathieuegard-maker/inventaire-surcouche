// src/core/utils/batch-actions.util.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeCommonBatchActions,
  filterEligibleBooksForBatchAction
} from './batch-actions.util';

describe('computeCommonBatchActions (sélection multiple intelligente)', () => {
  it('propose Collection, Wishlist et Supprimer avec sous-ensembles exacts pour Non possédé + À avoir', () => {
    const books = [
      { ownershipStatus: 'none' as const },
      { ownershipStatus: 'wish' as const }
    ];
    const res = computeCommonBatchActions(books);
    expect(res.actions).toEqual(['ADD_INVENTORY', 'ADD_WISHLIST', 'DELETE']);
    expect(res.eligibleCounts).toEqual({
      ADD_INVENTORY: 2,
      ADD_WISHLIST: 1,
      LEND: 0,
      RETURN: 0,
      DELETE: 1
    });
  });

  it('autorise Collection et Wishlist si tous sont Non possédés', () => {
    const res = computeCommonBatchActions([
      { ownershipStatus: 'none' },
      { ownershipStatus: 'none' }
    ]);
    expect(res.actions).toEqual(['ADD_INVENTORY', 'ADD_WISHLIST']);
    expect(res.isHomogeneousDelete).toBeNull();
  });

  it('autorise Prêter et Supprimer si tous sont Possédés disponibles', () => {
    const res = computeCommonBatchActions([
      { ownershipStatus: 'owned' },
      { ownershipStatus: 'owned' }
    ]);
    expect(res.actions).toEqual(['LEND', 'DELETE']);
    expect(res.isHomogeneousDelete).toBe('owned');
  });

  it('autorise Rendre et Supprimer si tous sont Prêtés', () => {
    const res = computeCommonBatchActions([
      { ownershipStatus: 'owned', loan: { uri: 'inv:1', friendName: 'Alice', loanDate: 1 } }
    ]);
    expect(res.actions).toEqual(['RETURN', 'DELETE']);
    expect(res.isHomogeneousDelete).toBe('lent');
  });

  it('propose les actions par sous-ensemble éligible quand Possédé, Prêté et Non possédé sont mélangés', () => {
    const books = [
      { ownershipStatus: 'owned' as const },
      { ownershipStatus: 'owned' as const, loan: { uri: 'inv:2', friendName: 'Bob', loanDate: 2 } },
      { ownershipStatus: 'none' as const }
    ];
    const res = computeCommonBatchActions(books);
    expect(res.actions).toEqual(['ADD_INVENTORY', 'ADD_WISHLIST', 'LEND', 'RETURN', 'DELETE']);
    expect(res.eligibleCounts).toEqual({
      ADD_INVENTORY: 1,
      ADD_WISHLIST: 1,
      LEND: 1,
      RETURN: 1,
      DELETE: 2
    });
    expect(filterEligibleBooksForBatchAction(books, 'LEND')).toHaveLength(1);
    expect(filterEligibleBooksForBatchAction(books, 'RETURN')).toHaveLength(1);
    expect(filterEligibleBooksForBatchAction(books, 'DELETE')).toHaveLength(2);
    expect(filterEligibleBooksForBatchAction(books, 'ADD_INVENTORY')).toHaveLength(1);
  });
});
