// src/client/cache/indexeddb.ts
// Cache local Dexie minimaliste V2 (Espace 3 Appareil) — ZÉRO image base64 (les couvertures vivent dans Cache API PWA).

import Dexie, { type Table } from 'dexie';
import type { ActiveLoanView, BookView, SeriesView } from '../../shared/types/domain.types';
import type { SyncOutboxOperation } from '../../shared/schemas';

export interface CachedLoanContact {
  name: string;
  isFriend: boolean;
  lastUsedAt: string | null;
}

export interface PendingOfflineScan {
  isbn13: string;
  scannedAt: string;
  resolvedBookId?: string | null;
  resolvedTitle?: string | null;
}

export interface SyncMetaEntry {
  key: string;
  value: string;
}

class BiblioLocalDatabase extends Dexie {
  mirror_books!: Table<BookView, string>;
  mirror_series!: Table<SeriesView, string>;
  mirror_loans!: Table<ActiveLoanView, string>;
  mirror_contacts!: Table<CachedLoanContact, string>;
  outbox!: Table<SyncOutboxOperation, string>;
  pending_offline_scans!: Table<PendingOfflineScan, string>;
  meta!: Table<SyncMetaEntry, string>;

  constructor() {
    super('biblio_v2_cache');
    this.version(1).stores({
      mirror_books: 'id, seriesId, ownershipStatus, updatedAt',
      mirror_series: 'id, franchiseId, canonicalName',
      mirror_loans: 'id, bookId, borrowerName',
      mirror_contacts: 'name',
      outbox: 'id, timestamp, op',
      pending_offline_scans: 'isbn13, scannedAt',
      meta: 'key'
    });
  }
}

export const localDb = new BiblioLocalDatabase();

export async function clearAllLocalCache(): Promise<void> {
  await localDb.transaction(
    'rw',
    [
      localDb.mirror_books,
      localDb.mirror_series,
      localDb.mirror_loans,
      localDb.mirror_contacts,
      localDb.outbox,
      localDb.pending_offline_scans,
      localDb.meta
    ],
    async () => {
      await localDb.mirror_books.clear();
      await localDb.mirror_series.clear();
      await localDb.mirror_loans.clear();
      await localDb.mirror_contacts.clear();
      await localDb.outbox.clear();
      await localDb.pending_offline_scans.clear();
      await localDb.meta.clear();
    }
  );
}
