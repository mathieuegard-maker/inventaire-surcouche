// src/shared/bibliographic/batch-actions.util.ts
// Calcul d'éligibilité des actions groupées sur sélection hétérogène + séparation des livres prêtés avant suppression.

import type { BookView } from '../types/domain.types';

export type BatchActionType = 'ADD_OWNED' | 'ADD_WISH' | 'LEND' | 'RETURN' | 'DELETE';

export interface BatchSelectionSummary {
  count: number;
  actions: BatchActionType[];
  eligibleCounts: Record<BatchActionType, number>;
  lentCountInDelete: number;
}

export type BatchBookLike = Pick<BookView, 'ownershipStatus' | 'activeLoan' | 'ownedViaIntegral'>;

export function filterEligibleBooksForBatchAction<T extends BatchBookLike>(
  books: T[],
  action: BatchActionType
): T[] {
  switch (action) {
    case 'ADD_OWNED':
      return books.filter((b) => b.ownershipStatus !== 'owned' && !b.ownedViaIntegral);
    case 'ADD_WISH':
      return books.filter((b) => b.ownershipStatus === 'none' && !b.ownedViaIntegral);
    case 'LEND':
      return books.filter((b) => b.ownershipStatus === 'owned' && !b.activeLoan);
    case 'RETURN':
      return books.filter((b) => Boolean(b.activeLoan));
    case 'DELETE':
      return books.filter(
        (b) => b.ownershipStatus === 'owned' || b.ownershipStatus === 'wish' || Boolean(b.activeLoan)
      );
  }
}

/**
 * Sépare une sélection à supprimer en :
 * - `standardToDelete` : livres non prêtés (supprimés après confirmation standard)
 * - `lentRequiringDecision` : livres actuellement prêtés nécessitant un choix individuel
 *   (Annuler la suppression vs Marquer rendu et supprimer).
 */
export function partitionBooksForDeletion<T extends BatchBookLike>(books: T[]): {
  standardToDelete: T[];
  lentRequiringDecision: T[];
} {
  const eligible = filterEligibleBooksForBatchAction(books, 'DELETE');
  const standardToDelete: T[] = [];
  const lentRequiringDecision: T[] = [];
  for (const b of eligible) {
    if (b.activeLoan) {
      lentRequiringDecision.push(b);
    } else {
      standardToDelete.push(b);
    }
  }
  return { standardToDelete, lentRequiringDecision };
}

export function computeCommonBatchActions(selectedBooks: BatchBookLike[]): BatchSelectionSummary {
  const count = selectedBooks.length;
  const emptyCounts: Record<BatchActionType, number> = {
    ADD_OWNED: 0,
    ADD_WISH: 0,
    LEND: 0,
    RETURN: 0,
    DELETE: 0
  };
  if (count === 0) {
    return { count: 0, actions: [], eligibleCounts: emptyCounts, lentCountInDelete: 0 };
  }

  let ownedAvailable = 0;
  let wishCount = 0;
  let noneCount = 0;
  let lentCount = 0;

  for (const book of selectedBooks) {
    if (book.activeLoan) {
      lentCount++;
    } else if (book.ownershipStatus === 'owned') {
      ownedAvailable++;
    } else if (book.ownershipStatus === 'wish') {
      wishCount++;
    } else if (!book.ownedViaIntegral) {
      noneCount++;
    }
  }

  const eligibleCounts: Record<BatchActionType, number> = {
    ADD_OWNED: noneCount + wishCount,
    ADD_WISH: noneCount,
    LEND: ownedAvailable,
    RETURN: lentCount,
    DELETE: ownedAvailable + lentCount + wishCount
  };

  const actions: BatchActionType[] = [];
  if (eligibleCounts.ADD_OWNED > 0) actions.push('ADD_OWNED');
  if (eligibleCounts.ADD_WISH > 0) actions.push('ADD_WISH');
  if (eligibleCounts.LEND > 0) actions.push('LEND');
  if (eligibleCounts.RETURN > 0) actions.push('RETURN');
  if (eligibleCounts.DELETE > 0) actions.push('DELETE');

  return { count, actions, eligibleCounts, lentCountInDelete: lentCount };
}
