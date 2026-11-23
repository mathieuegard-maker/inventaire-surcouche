// src/client/cache/sync-engine.ts
// Moteur de synchronisation unique : PUSH outbox d'abord, PULL delta ensuite (garantit zéro écrasement d'action hors-ligne).

import { apiRequest } from '../api/client';
import type { ActiveLoanView, BookView, SeriesView } from '../../shared/types/domain.types';
import type { SyncOutboxOperation } from '../../shared/schemas';
import { localDb, type CachedLoanContact } from './indexeddb';

interface SyncPushResponse {
  ok: true;
  serverTime: string;
  results: Array<{ id: string; applied: boolean; reason?: string }>;
}

interface SyncPullResponse {
  ok: true;
  serverTime: string;
  isFullSync: boolean;
  books: BookView[];
  series: SeriesView[];
  deletedBookIds: string[];
  loans: ActiveLoanView[];
  contacts: CachedLoanContact[];
  unreadAlertsCount: number;
}

const LAST_SYNC_META_KEY = 'last_sync_at';
const LAST_LIBRARY_ID_META_KEY = 'last_library_id';

export async function enqueueOutboxOp(op: SyncOutboxOperation): Promise<void> {
  await localDb.outbox.put(op);
}

/**
 * Exécute un cycle complet `PUSH -> PULL` contre le serveur.
 * 0. Si le foyer actif a changé (nouveau compte / base réinitialisée), purge l'ancien cache local avant un full pull.
 * 1. Pousse toute l'`outbox` datée au serveur (avant tout pull).
 * 2. Tire le delta depuis `last_sync_at` (ou snapshot complet au premier chargement).
 * 3. Met à jour le miroir IndexedDB (sans images base64).
 */
export async function runSyncCycle(options?: { forceFullPull?: boolean; libraryId?: string }): Promise<{
  pushedCount: number;
  pulledBooksCount: number;
  unreadAlertsCount: number;
}> {
  let forceFullPull = Boolean(options?.forceFullPull);

  if (options?.libraryId) {
    const prevLib = await localDb.meta.get(LAST_LIBRARY_ID_META_KEY);
    if (prevLib?.value && prevLib.value !== options.libraryId) {
      await Promise.all([
        localDb.mirror_books.clear(),
        localDb.mirror_series.clear(),
        localDb.mirror_loans.clear(),
        localDb.mirror_contacts.clear(),
        localDb.outbox.clear(),
        localDb.meta.delete(LAST_SYNC_META_KEY)
      ]);
      forceFullPull = true;
    }
    await localDb.meta.put({ key: LAST_LIBRARY_ID_META_KEY, value: options.libraryId });
  }

  // ÉTAPE 1 : PUSH outbox d'abord
  const pendingOps = await localDb.outbox.orderBy('timestamp').toArray();
  let pushedCount = 0;

  if (pendingOps.length > 0) {
    const pushRes = await apiRequest<SyncPushResponse>('/api/sync/push', {
      method: 'POST',
      body: { operations: pendingOps }
    });
    pushedCount = pushRes.results.length;
    const processedIds = pushRes.results.map((r) => r.id);
    if (processedIds.length > 0) {
      await localDb.outbox.bulkDelete(processedIds);
    }
  }

  // ÉTAPE 2 : PULL delta ensuite
  const lastMeta = forceFullPull ? undefined : await localDb.meta.get(LAST_SYNC_META_KEY);
  const query = lastMeta?.value ? `?since=${encodeURIComponent(lastMeta.value)}` : '';
  const pullRes = await apiRequest<SyncPullResponse>(`/api/sync/pull${query}`);

  // ÉTAPE 3 : Mise à jour atomique du miroir IndexedDB
  await localDb.transaction(
    'rw',
    [localDb.mirror_books, localDb.mirror_series, localDb.mirror_loans, localDb.mirror_contacts, localDb.meta],
    async () => {
      if (pullRes.isFullSync) {
        await localDb.mirror_books.clear();
        await localDb.mirror_series.clear();
      } else if (pullRes.deletedBookIds.length > 0) {
        await localDb.mirror_books.bulkDelete(pullRes.deletedBookIds);
      }

      if (pullRes.books.length > 0) {
        await localDb.mirror_books.bulkPut(pullRes.books);
      }

      await localDb.mirror_series.clear();
      if (pullRes.series.length > 0) {
        await localDb.mirror_series.bulkPut(pullRes.series);
      }

      await localDb.mirror_loans.clear();
      if (pullRes.loans.length > 0) {
        await localDb.mirror_loans.bulkPut(pullRes.loans);
      }

      await localDb.mirror_contacts.clear();
      if (pullRes.contacts.length > 0) {
        await localDb.mirror_contacts.bulkPut(pullRes.contacts);
      }

      await localDb.meta.put({ key: LAST_SYNC_META_KEY, value: pullRes.serverTime });
    }
  );

  return {
    pushedCount,
    pulledBooksCount: pullRes.books.length,
    unreadAlertsCount: pullRes.unreadAlertsCount
  };
}
