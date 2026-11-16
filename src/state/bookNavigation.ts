// src/state/bookNavigation.ts
import { databaseService } from '../core/database/database.service';
import type { HumanizedBook } from '../core/types';
import { getOrCreateViewState } from './viewState';

const STORAGE_KEY = 'biblio_book_nav_order';

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

export function saveBookNavigationOrder(uris: string[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(uris));
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

export async function resolveCollectionOrderedUrisForBook(currentUri: string): Promise<string[]> {
  const saved = getSavedBookNavigationOrder();
  if (saved.includes(currentUri) && saved.length > 1) {
    return saved;
  }
  const cached = await databaseService.getAllBooksFromCache().catch(() => []);
  const owned = cached.filter((b) => b.ownershipStatus === 'owned');
  if (!owned.some((b) => b.uri === currentUri)) {
    return [];
  }
  const colState = getOrCreateViewState('collection', {
    currentPage: 1,
    pageSize: 20,
    searchQuery: '',
    filters: { mode: 'books', genre: 'all', sort: 'date' }
  });
  const sorted = sortBooksByCollectionMode(owned, colState.filters.sort || 'date');
  return sorted.map((b) => b.uri);
}
