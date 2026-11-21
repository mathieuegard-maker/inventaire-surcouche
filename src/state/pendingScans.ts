// src/state/pendingScans.ts
import { ref } from 'vue';
import { isbnUtil } from '../core/utils/isbn.util';

export interface PendingOfflineScan {
  isbn: string;
  scannedAt: number;
}

const STORAGE_KEY = 'biblio_pending_offline_scans';

function normalizeIsbnKey(rawIsbn: string): string {
  const norm = isbnUtil.normalize(rawIsbn || '');
  if (!norm) return '';
  if (norm.length === 10) return isbnUtil.toIsbn13(norm) || norm;
  return norm;
}

function readFromStorage(): PendingOfflineScan[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingOfflineScan =>
        Boolean(item && typeof item.isbn === 'string' && typeof item.scannedAt === 'number')
    );
  } catch {
    return [];
  }
}

function writeToStorage(list: PendingOfflineScan[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore storage quota errors
  }
}

const pendingScans = ref<PendingOfflineScan[]>(readFromStorage());

export const pendingScansStore = {
  pendingScans,

  addPendingScan(rawIsbn: string): PendingOfflineScan | null {
    const clean = normalizeIsbnKey(rawIsbn);
    if (!clean) return null;
    const entry: PendingOfflineScan = {
      isbn: clean,
      scannedAt: Date.now()
    };
    const filtered = pendingScans.value.filter((item) => item.isbn !== clean);
    const updated = [entry, ...filtered];
    pendingScans.value = updated;
    writeToStorage(updated);
    return entry;
  },

  removePendingScan(rawIsbn: string): void {
    const clean = normalizeIsbnKey(rawIsbn);
    const rawClean = isbnUtil.normalize(rawIsbn || '');
    const updated = pendingScans.value.filter(
      (item) => item.isbn !== clean && item.isbn !== rawClean
    );
    if (updated.length !== pendingScans.value.length) {
      pendingScans.value = updated;
      writeToStorage(updated);
    }
  },

  reload(): void {
    pendingScans.value = readFromStorage();
  },

  clearAll(): void {
    pendingScans.value = [];
    writeToStorage([]);
  }
};
