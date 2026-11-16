// src/state/bookNavigation.ts
import { databaseService } from '../core/database/database.service';
import type { HumanizedBook } from '../core/types';
import { getOrCreateViewState } from './viewState';

const STORAGE_KEY = 'biblio_book_nav_order';
const ORIGIN_STORAGE_KEY = 'biblio_book_nav_origin';

function getVolumeSortWeight(vol?: string): number {
  if (!vol) return 9999;
  const trimmed = vol.trim();
  const numMatch = /^(\d+(?:\.\d+)?)/.exec(trimmed);
  if (numMatch) return parseFloat(numMatch[1]);
  const hsMatch = /hs\s*(\d+)?/i.exec(trimmed);
  if (hsMatch) return 5000 + (hsMatch[1] ? parseInt(hsMatch[1], 10) : 0);
  return 8000;
}

export function sortSeriesTomes(tomes: HumanizedBook[]): HumanizedBook[] {
  return [...tomes].sort((a, b) => {
    const diff = getVolumeSortWeight(a.seriesNumber) - getVolumeSortWeight(b.seriesNumber);
    return diff !== 0 ? diff : (a.title || '').localeCompare(b.title || '', 'fr');
  });
}

export function sortBooksByCollectionMode(books: HumanizedBook[], sortMode: string): HumanizedBook[] {
  const list = [...books];
  if (sortMode === 'title') {
    return list.sort((a, b) => {
      const cleanA = a.title.replace(/^(les\s+|la\s+|le\s+|l'|une\s+|un\s+)/i, '').trim().toLowerCase();
      const cleanB = b.title.replace(/^(les\s+|la\s+|le\s+|l'|une\s+|un\s+)/i, '').trim().toLowerCase();
      return cleanA.localeCompare(cleanB);
    });
  }
  if (sortMode === 'author') {
    return list.sort((a, b) => {
      const authA = a.authors?.[0] || '';
      const authB = b.authors?.[0] || '';
      return authA.localeCompare(authB);
    });
  }
  // 'date' par défaut (plus récent d'abord)
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function saveBookNavigationOrder(uris: string[], origin?: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(uris));
    if (origin !== undefined) {
      sessionStorage.setItem(ORIGIN_STORAGE_KEY, origin);
    } else if (typeof sessionStorage.removeItem === 'function') {
      sessionStorage.removeItem(ORIGIN_STORAGE_KEY);
    }
  } catch {
    // ignore storage quota errors
  }
}

export function getSavedBookNavigationOrder(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

export function getSavedBookNavigationOrigin(): string {
  try {
    return sessionStorage.getItem(ORIGIN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export async function resolveCollectionOrderedUrisForBook(currentUri: string): Promise<string[]> {
  const saved = getSavedBookNavigationOrder();
  const origin = getSavedBookNavigationOrigin();

  // Ouverture directe (scan code-barres, ISBN direct) : pas de fuite d'ordre Collection/Wishlist
  if (origin === 'direct' && saved.includes(currentUri)) {
    return [];
  }

  if (saved.includes(currentUri)) {
    if (saved.length > 1) return saved;
    if (origin && origin !== 'direct') return saved;
  }

  // Repli si on ouvre directement une fiche possédée sans passer par une liste enregistrée
  const cached = await databaseService.getAllBooksFromCache();
  const owned = cached.filter((b) => b.ownershipStatus === 'owned');
  if (!owned.some((b) => b.uri === currentUri)) {
    return [];
  }

  const collectionState = getOrCreateViewState('collection', {
    currentPage: 1,
    pageSize: 20,
    searchQuery: '',
    filters: { currentMode: 'series', currentSort: 'date', filterText: '' }
  });
  const sortMode = collectionState.filters?.currentSort || 'date';
  const sorted = sortBooksByCollectionMode(owned, sortMode);
  return sorted.map((b) => b.uri);
}
