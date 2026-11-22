// src/core/utils/batch-actions.util.ts
import type { HumanizedBook } from '../types';

export type BatchActionType =
  | 'ADD_INVENTORY'
  | 'ADD_WISHLIST'
  | 'LEND'
  | 'RETURN'
  | 'DELETE';

export interface BatchSelectionSummary {
  count: number;
  actions: BatchActionType[];
  eligibleCounts: Record<BatchActionType, number>;
  isHomogeneousDelete: 'owned' | 'wish' | 'lent' | null;
}

export type BatchBookLike = Pick<HumanizedBook, 'ownershipStatus' | 'loan'> & {
  ownedViaIntegral?: unknown;
};

/**
 * Filtre les livres réellement éligibles à une action groupée donnée.
 * Permet d'exécuter une action sur une sélection hétérogène sans jamais bloquer l'utilisateur :
 * - ADD_INVENTORY : uniquement les livres non possédés (et non couverts par une intégrale)
 * - ADD_WISHLIST  : uniquement les livres non possédés et pas encore en wishlist
 * - LEND          : uniquement les livres possédés et disponibles (non déjà prêtés)
 * - RETURN        : uniquement les livres actuellement prêtés
 * - DELETE        : uniquement les livres possédés (prêtés ou non) ou en wishlist
 */
export function filterEligibleBooksForBatchAction<T extends BatchBookLike>(
  books: T[],
  action: BatchActionType
): T[] {
  switch (action) {
    case 'ADD_INVENTORY':
      return books.filter((b) => b.ownershipStatus !== 'owned' && !b.ownedViaIntegral);
    case 'ADD_WISHLIST':
      return books.filter((b) => b.ownershipStatus === 'none' && !b.ownedViaIntegral);
    case 'LEND':
      return books.filter((b) => b.ownershipStatus === 'owned' && !b.loan);
    case 'RETURN':
      return books.filter((b) => Boolean(b.loan));
    case 'DELETE':
      return books.filter(
        (b) => b.ownershipStatus === 'owned' || b.ownershipStatus === 'wish' || Boolean(b.loan)
      );
    default:
      return books;
  }
}

/**
 * Détermine dynamiquement toutes les actions valides sur une sélection (même hétérogène)
 * en comptant pour chaque action le sous-ensemble exact d'ouvrages éligibles.
 */
export function computeCommonBatchActions(
  selectedBooks: Array<BatchBookLike>
): BatchSelectionSummary {
  const count = selectedBooks.length;
  const emptyCounts: Record<BatchActionType, number> = {
    ADD_INVENTORY: 0,
    ADD_WISHLIST: 0,
    LEND: 0,
    RETURN: 0,
    DELETE: 0
  };
  if (count === 0) {
    return { count: 0, actions: [], eligibleCounts: emptyCounts, isHomogeneousDelete: null };
  }

  let ownedAvailable = 0;
  let wishCount = 0;
  let noneCount = 0;
  let lentCount = 0;

  for (const book of selectedBooks) {
    if (book.loan) {
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
    ADD_INVENTORY: noneCount + wishCount,
    ADD_WISHLIST: noneCount,
    LEND: ownedAvailable,
    RETURN: lentCount,
    DELETE: ownedAvailable + lentCount + wishCount
  };

  const actions: BatchActionType[] = [];
  if (eligibleCounts.ADD_INVENTORY > 0) actions.push('ADD_INVENTORY');
  if (eligibleCounts.ADD_WISHLIST > 0) actions.push('ADD_WISHLIST');
  if (eligibleCounts.LEND > 0) actions.push('LEND');
  if (eligibleCounts.RETURN > 0) actions.push('RETURN');
  if (eligibleCounts.DELETE > 0) actions.push('DELETE');

  let isHomogeneousDelete: 'owned' | 'wish' | 'lent' | null = null;
  if (lentCount > 0 && ownedAvailable === 0 && wishCount === 0 && noneCount === 0) {
    isHomogeneousDelete = 'lent';
  } else if (ownedAvailable > 0 && lentCount === 0 && wishCount === 0 && noneCount === 0) {
    isHomogeneousDelete = 'owned';
  } else if (wishCount > 0 && lentCount === 0 && ownedAvailable === 0 && noneCount === 0) {
    isHomogeneousDelete = 'wish';
  }

  return { count, actions, eligibleCounts, isHomogeneousDelete };
}
