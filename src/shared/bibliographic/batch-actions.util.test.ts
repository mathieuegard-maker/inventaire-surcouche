// src/shared/bibliographic/batch-actions.util.test.ts
import { describe, expect, it } from 'vitest';
import {
  computeCommonBatchActions,
  partitionBooksForDeletion,
  type BatchBookLike
} from './batch-actions.util';

describe('batch-actions.util', () => {
  it('calcule les sous-ensembles éligibles sur sélection mixte et sépare les livres prêtés avant suppression', () => {
    const selection: Array<BatchBookLike & { id: string }> = [
      { id: 'b1', ownershipStatus: 'owned', activeLoan: null, ownedViaIntegral: null },
      {
        id: 'b2',
        ownershipStatus: 'owned',
        activeLoan: { id: 'l1', bookId: 'b2', borrowerName: 'Thomas', loanedAt: '2026-11-01' },
        ownedViaIntegral: null
      },
      { id: 'b3', ownershipStatus: 'wish', activeLoan: null, ownedViaIntegral: null },
      { id: 'b4', ownershipStatus: 'none', activeLoan: null, ownedViaIntegral: null }
    ];

    const summary = computeCommonBatchActions(selection);
    expect(summary.eligibleCounts.ADD_OWNED).toBe(2);
    expect(summary.eligibleCounts.ADD_WISH).toBe(1);
    expect(summary.eligibleCounts.LEND).toBe(1);
    expect(summary.eligibleCounts.RETURN).toBe(1);
    expect(summary.eligibleCounts.DELETE).toBe(3);
    expect(summary.lentCountInDelete).toBe(1);

    const partitioned = partitionBooksForDeletion(selection);
    expect(partitioned.standardToDelete.map((b) => b.id)).toEqual(['b1', 'b3']);
    expect(partitioned.lentRequiringDecision.map((b) => b.id)).toEqual(['b2']);
  });
});
