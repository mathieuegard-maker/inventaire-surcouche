// src/client/stores/library.store.ts
// Store Pinia central de la bibliothèque (Collection, Wishlist, Prêts, Séries, Sync offline PUSH->PULL & mémoire d'état des vues).

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { apiRequest } from '../api/client';
import { clearAllLocalCache, localDb, type CachedLoanContact, type PendingOfflineScan } from '../cache/indexeddb';
import { enqueueOutboxOp, runSyncCycle } from '../cache/sync-engine';
import { annotateIntegralCoverage } from '../../shared/bibliographic/integral.util';
import type { ActiveLoanView, BookView, OwnershipStatus, SeriesView } from '../../shared/types/domain.types';
import { useAuthStore } from './auth.store';

export interface CollectionViewMemory {
  tab: 'books' | 'series' | 'oneshots';
  filterQuery: string;
  sortBy: 'date' | 'alpha' | 'author';
  page: number;
  scrollY: number;
}

export interface WishlistViewMemory {
  query: string;
  genre: string;
  author: string;
  scrollY: number;
}

export interface LoansViewMemory {
  mode: 'borrower' | 'chrono';
  query: string;
  scrollY: number;
}

function makeOpId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useLibraryStore = defineStore('library', () => {
  const books = ref<BookView[]>([]);
  const series = ref<SeriesView[]>([]);
  const loans = ref<ActiveLoanView[]>([]);
  const contacts = ref<CachedLoanContact[]>([]);
  const pendingOfflineScans = ref<PendingOfflineScan[]>([]);
  const outboxCount = ref(0);
  const lastSyncAt = ref<string | null>(null);
  const isSyncing = ref(false);
  const isHydrated = ref(false);

  // Mémoire d'état par vue (filtres, tris, pagination, scroll)
  const collectionState = ref<CollectionViewMemory>({
    tab: 'books',
    filterQuery: '',
    sortBy: 'date',
    page: 1,
    scrollY: 0
  });

  const wishlistState = ref<WishlistViewMemory>({
    query: '',
    genre: '',
    author: '',
    scrollY: 0
  });

  const loansState = ref<LoansViewMemory>({
    mode: 'borrower',
    query: '',
    scrollY: 0
  });

  // Getters dérivés
  const ownedBooks = computed(() => books.value.filter((b) => b.ownershipStatus === 'owned'));
  const wishedBooks = computed(() => books.value.filter((b) => b.ownershipStatus === 'wish'));
  const lentBooks = computed(() => books.value.filter((b) => Boolean(b.activeLoan)));
  const oneshotOwnedBooks = computed(() =>
    ownedBooks.value.filter((b) => !b.seriesId)
  );
  const recentOwnedBooks = computed(() =>
    [...ownedBooks.value]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5)
  );

  async function hydrateFromLocalCache(): Promise<void> {
    const [cachedBooks, cachedSeries, cachedLoans, cachedContacts, cachedScans, pendingOpsCount, metaSync] =
      await Promise.all([
        localDb.mirror_books.toArray(),
        localDb.mirror_series.toArray(),
        localDb.mirror_loans.toArray(),
        localDb.mirror_contacts.toArray(),
        localDb.pending_offline_scans.orderBy('scannedAt').reverse().toArray(),
        localDb.outbox.count(),
        localDb.meta.get('last_sync_at')
      ]);

    books.value = annotateIntegralCoverage(cachedBooks, cachedBooks);
    series.value = cachedSeries;
    loans.value = cachedLoans;
    contacts.value = cachedContacts;
    pendingOfflineScans.value = cachedScans;
    outboxCount.value = pendingOpsCount;
    lastSyncAt.value = metaSync?.value ?? null;
    isHydrated.value = true;
  }

  async function syncNow(options?: { forceFullPull?: boolean }): Promise<boolean> {
    if (isSyncing.value) return false;
    isSyncing.value = true;
    try {
      const outcome = await runSyncCycle(options);
      await hydrateFromLocalCache();
      const authStore = useAuthStore();
      if (authStore.profile) {
        authStore.profile = { ...authStore.profile, unreadAlertsCount: outcome.unreadAlertsCount };
      }
      return true;
    } catch {
      await hydrateFromLocalCache();
      return false;
    } finally {
      isSyncing.value = false;
    }
  }

  /**
   * Changement de statut en lot (avec prise en charge offline via outbox + décisions individuelles pour livres prêtés).
   */
  async function applyBatchStatus(input: {
    bookIds: string[];
    status: OwnershipStatus;
    lentDecisions?: Record<string, 'keep' | 'return_and_delete'>;
  }): Promise<{ offlineQueued: boolean }> {
    const now = new Date().toISOString();

    // Application optimiste immédiate dans IndexedDB + mémoire
    for (const bookId of input.bookIds) {
      const existing = await localDb.mirror_books.get(bookId);
      if (!existing) continue;

      if (input.status === 'none') {
        if (existing.activeLoan) {
          const decision = input.lentDecisions?.[bookId] ?? 'keep';
          if (decision === 'keep') continue;
          await localDb.mirror_loans.where('bookId').equals(bookId).delete();
        }
        await localDb.mirror_books.delete(bookId);
      } else {
        await localDb.mirror_books.put({
          ...existing,
          ownershipStatus: input.status,
          updatedAt: now
        });
      }
    }
    await hydrateFromLocalCache();

    // Tentative serveur directe ; sinon empile dans l'outbox offline
    try {
      await apiRequest('/api/library/books/batch-status', {
        method: 'POST',
        body: input
      });
      await syncNow();
      return { offlineQueued: false };
    } catch {
      for (const bookId of input.bookIds) {
        if (input.status === 'none') {
          const decision = input.lentDecisions?.[bookId];
          if (decision === 'keep') continue;
          if (decision === 'return_and_delete') {
            await enqueueOutboxOp({ id: makeOpId(), op: 'RETURN', bookId, timestamp: now });
          }
        }
        await enqueueOutboxOp({
          id: makeOpId(),
          op: 'SET_STATUS',
          bookId,
          status: input.status,
          timestamp: now
        });
      }
      await hydrateFromLocalCache();
      return { offlineQueued: true };
    }
  }

  async function applyBatchGenres(bookIds: string[], genres: string[]): Promise<void> {
    await apiRequest('/api/library/books/batch-genres', {
      method: 'POST',
      body: { bookIds, genres }
    });
    await syncNow();
  }

  async function lendBooks(input: { bookIds: string[]; borrowerName: string; notes?: string }): Promise<{ offlineQueued: boolean }> {
    const now = new Date().toISOString();
    const cleanBorrower = input.borrowerName.trim();

    for (const bookId of input.bookIds) {
      const existing = await localDb.mirror_books.get(bookId);
      const loanView: ActiveLoanView = {
        id: `local_${makeOpId()}`,
        bookId,
        borrowerName: cleanBorrower,
        loanedAt: now,
        notes: input.notes ?? null
      };
      await localDb.mirror_loans.put(loanView);
      if (existing) {
        await localDb.mirror_books.put({ ...existing, activeLoan: loanView, updatedAt: now });
      }
    }
    await localDb.mirror_contacts.put({ name: cleanBorrower, isFriend: false, lastUsedAt: now });
    await hydrateFromLocalCache();

    try {
      await apiRequest('/api/loans', {
        method: 'POST',
        body: { bookIds: input.bookIds, borrowerName: cleanBorrower, notes: input.notes }
      });
      await syncNow();
      return { offlineQueued: false };
    } catch {
      for (const bookId of input.bookIds) {
        await enqueueOutboxOp({
          id: makeOpId(),
          op: 'LEND',
          bookId,
          borrowerName: cleanBorrower,
          timestamp: now
        });
      }
      await hydrateFromLocalCache();
      return { offlineQueued: true };
    }
  }

  async function returnBooks(bookIds: string[]): Promise<{ offlineQueued: boolean }> {
    const now = new Date().toISOString();

    for (const bookId of bookIds) {
      await localDb.mirror_loans.where('bookId').equals(bookId).delete();
      const existing = await localDb.mirror_books.get(bookId);
      if (existing) {
        await localDb.mirror_books.put({ ...existing, activeLoan: null, updatedAt: now });
      }
    }
    await hydrateFromLocalCache();

    try {
      await apiRequest('/api/loans/return', {
        method: 'POST',
        body: { bookIds }
      });
      await syncNow();
      return { offlineQueued: false };
    } catch {
      for (const bookId of bookIds) {
        await enqueueOutboxOp({
          id: makeOpId(),
          op: 'RETURN',
          bookId,
          timestamp: now
        });
      }
      await hydrateFromLocalCache();
      return { offlineQueued: true };
    }
  }

  // ==================== SCANS HORS-LIGNE MÉMORISÉS ====================

  async function addPendingOfflineScan(isbn13: string): Promise<void> {
    const now = new Date().toISOString();
    await localDb.pending_offline_scans.put({ isbn13, scannedAt: now });
    await enqueueOutboxOp({ id: makeOpId(), op: 'OFFLINE_SCAN', isbn13, timestamp: now });
    await hydrateFromLocalCache();
  }

  async function removePendingOfflineScan(isbn13: string): Promise<void> {
    await localDb.pending_offline_scans.delete(isbn13);
    await hydrateFromLocalCache();
  }

  async function clearPendingOfflineScans(): Promise<void> {
    await localDb.pending_offline_scans.clear();
    await hydrateFromLocalCache();
  }

  async function clearCache(): Promise<void> {
    await clearAllLocalCache();
    books.value = [];
    series.value = [];
    loans.value = [];
    contacts.value = [];
    pendingOfflineScans.value = [];
    outboxCount.value = 0;
    lastSyncAt.value = null;
  }

  return {
    books,
    series,
    loans,
    contacts,
    pendingOfflineScans,
    outboxCount,
    lastSyncAt,
    isSyncing,
    isHydrated,
    collectionState,
    wishlistState,
    loansState,
    ownedBooks,
    wishedBooks,
    lentBooks,
    oneshotOwnedBooks,
    recentOwnedBooks,
    hydrateFromLocalCache,
    syncNow,
    applyBatchStatus,
    applyBatchGenres,
    lendBooks,
    returnBooks,
    addPendingOfflineScan,
    removePendingOfflineScan,
    clearPendingOfflineScans,
    clearCache
  };
});
