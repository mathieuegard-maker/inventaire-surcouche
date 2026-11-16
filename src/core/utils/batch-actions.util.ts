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
  isHomogeneousDelete: 'owned' | 'wish' | 'lent' | null;
}

/**
 * Détermine dynamiquement les actions communes valides sur une sélection (même hétérogène).
 * Exemple : un lot contenant "Non possédé" + "À avoir" autorise l'ajout à la collection,
 * mais interdit "Wishlist" (car certains y sont déjà) et "Supprimer" (états incompatibles).
 */
export function computeCommonBatchActions(
  selectedBooks: Array<Pick<HumanizedBook, 'ownershipStatus' | 'loan'>>
): BatchSelectionSummary {
  const count = selectedBooks.length;
  if (count === 0) {
    return { count: 0, actions: [], isHomogeneousDelete: null };
  }

  let hasOwned = false;
  let hasWish = false;
  let hasNone = false;
  let hasLent = false;

  for (const book of selectedBooks) {
    if (book.loan) {
      hasLent = true;
    } else if (book.ownershipStatus === 'owned') {
      hasOwned = true;
    } else if (book.ownershipStatus === 'wish') {
      hasWish = true;
    } else {
      hasNone = true;
    }
  }

  const actions: BatchActionType[] = [];

  // Ajouter à la collection : valide si AUCUN livre n'est déjà possédé/prêté
  if (!hasOwned && !hasLent && (hasNone || hasWish)) {
    actions.push('ADD_INVENTORY');
  }

  // Ajouter à la wishlist : valide uniquement si TOUS sont non possédés
  if (hasNone && !hasWish && !hasOwned && !hasLent) {
    actions.push('ADD_WISHLIST');
  }

  // Prêter : uniquement si TOUS sont possédés et disponibles (non prêtés)
  if (hasOwned && !hasLent && !hasWish && !hasNone) {
    actions.push('LEND');
  }

  // Rendre : uniquement si TOUS sont actuellement prêtés
  if (hasLent && !hasOwned && !hasWish && !hasNone) {
    actions.push('RETURN');
  }

  // Supprimer : uniquement si la sélection est homogène sur un statut supprimable
  let isHomogeneousDelete: 'owned' | 'wish' | 'lent' | null = null;
  if (hasLent && !hasOwned && !hasWish && !hasNone) {
    isHomogeneousDelete = 'lent';
    actions.push('DELETE');
  } else if (hasOwned && !hasLent && !hasWish && !hasNone) {
    isHomogeneousDelete = 'owned';
    actions.push('DELETE');
  } else if (hasWish && !hasLent && !hasOwned && !hasNone) {
    isHomogeneousDelete = 'wish';
    actions.push('DELETE');
  }

  return { count, actions, isHomogeneousDelete };
}
