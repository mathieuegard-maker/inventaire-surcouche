// src/core/database/database.service.ts
import Dexie, { type Table } from 'dexie';
import type { HumanizedBook, LoanRecord, RegistryEntry, QueueActionPayload } from '../types';
import type { PhotoBatchResolutionResult } from '../services/photo-book-resolution.service';
import { isbnUtil } from '../utils/isbn.util';

function normalizeSeriesText(raw?: string): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’".,:;!?()\[\]-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Supprime récursivement les Proxies réactifs Vue et champs non clonables
 * tout en préservant les types binaires/natifs supportés par IndexedDB (Blob, Date, ArrayBuffer...).
 */
function toPlainCloneable<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (
    value instanceof Blob ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPlainCloneable(item)) as unknown as T;
  }
  const plain: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const prop = (value as Record<string, unknown>)[key];
    if (typeof prop !== 'function' && typeof prop !== 'symbol' && prop !== undefined) {
      plain[key] = toPlainCloneable(prop);
    }
  }
  return plain as T;
}

export interface PendingAction {
  id?: number;
  action: 'LEND' | 'RETURN' | 'ADD_INVENTORY' | 'REMOVE_INVENTORY' | 'ADD_WISHLIST' | 'REMOVE_WISHLIST';
  uri: string;
  payload?: QueueActionPayload; // CORRECTION : Typage strict appliqué (finis les "any")
  status: 'pending' | 'failed';
  createdAt: number;
}

export interface PendingCreation {
  id?: number;
  tempBook: HumanizedBook;
  resolvedSeriesUri?: string;
  resolvedAuthorUris: Record<string, string>;
  expandSeries: boolean;
  ownershipTarget?: 'owned' | 'wish' | 'none';
  status: 'pending' | 'processing' | 'failed';
  errorMessage?: string;
  createdAt: number;
}

export interface LocalIsbnIndexEntry {
  isbn13: string;
  bookUri: string;
  bookId?: string;
  isIntegral: boolean;
}

export interface PhotoScanJobRecord {
  id?: number;
  serverJobId?: string;
  mode: 'cover' | 'shelf';
  imageDataUrl: string;
  status: 'pending' | 'ai_running' | 'resolving' | 'done' | 'error';
  errorMessage?: string;
  candidatesCount?: number;
  externalLookupsCount?: number;
  result?: PhotoBatchResolutionResult;
  createdAt: number;
  updatedAt: number;
}

export class AppDatabase extends Dexie {
  inventory!: Table<RegistryEntry, string>;
  wishlist!: Table<RegistryEntry, string>;
  cache_books!: Table<HumanizedBook, string>;
  loans!: Table<LoanRecord, string>; // Table pour le carnet de prêt
  pending_actions!: Table<PendingAction, number>; // NOUVELLE TABLE : File d'attente
  pending_creations!: Table<PendingCreation, number>; // File de créations distantes en tâche de fond
  photo_scan_jobs!: Table<PhotoScanJobRecord, number>; // File persistante d'analyse photo en arrière-plan
  book_isbn_index!: Table<LocalIsbnIndexEntry, string>; // Index relationnel O(1) isbn13 -> livre local

  constructor() {
    super('InventaireLocalDBV2');
    
    // Historique conservé pour la migration fluide des utilisateurs existants
    this.version(3).stores({
      inventory: 'uri',
      wishlist: 'uri',
      cache_books: 'uri, workUri, seriesId, isbn13, isbn10, ownershipStatus',
      loans: 'uri, friendName'
    });

    // Version 4 : Ajout de la table pending_actions pour l'Optimistic UI
    this.version(4).stores({
      inventory: 'uri',
      wishlist: 'uri',
      cache_books: 'uri, workUri, seriesId, isbn13, isbn10, ownershipStatus',
      loans: 'uri, friendName',
      pending_actions: '++id, action, uri, status, createdAt' // ++id génère un auto-incrément mathématique
    });

    // Version 5 : Ajout de la file persistante pour créations / séries en tâche de fond
    this.version(5).stores({
      inventory: 'uri',
      wishlist: 'uri',
      cache_books: 'uri, workUri, seriesId, isbn13, isbn10, ownershipStatus',
      loans: 'uri, friendName',
      pending_actions: '++id, action, uri, status, createdAt',
      pending_creations: '++id, status, createdAt'
    });

    // Version 6 : File persistante d'analyse photo étagère / couverture en arrière-plan
    this.version(6).stores({
      inventory: 'uri',
      wishlist: 'uri',
      cache_books: 'uri, workUri, seriesId, isbn13, isbn10, ownershipStatus',
      loans: 'uri, friendName',
      pending_actions: '++id, action, uri, status, createdAt',
      pending_creations: '++id, status, createdAt',
      photo_scan_jobs: '++id, status, createdAt'
    });

    // Version 7 (Architecture V4) : Index relationnel O(1) book_isbn_index (isbn13 PK)
    this.version(7).stores({
      inventory: 'uri',
      wishlist: 'uri',
      cache_books: 'uri, workUri, seriesId, isbn13, isbn10, ownershipStatus',
      loans: 'uri, friendName',
      pending_actions: '++id, action, uri, status, createdAt',
      pending_creations: '++id, status, createdAt',
      photo_scan_jobs: '++id, status, createdAt',
      book_isbn_index: 'isbn13, bookUri, bookId, isIntegral'
    });
  }
}

export const db = new AppDatabase();

export const databaseService = {
  // --- RECHERCHES LOCAL-FIRST (Double Check) ---

  async lookupIsbnIndexLocal(isbn13: string): Promise<{ entry: LocalIsbnIndexEntry; book?: HumanizedBook } | undefined> {
    const clean = (isbn13 || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (!clean) return undefined;
    const entry = await db.book_isbn_index.get(clean);
    if (!entry) return undefined;
    const book = await db.cache_books.get(entry.bookUri);
    return { entry, book };
  },

  async indexBookIsbns(book: HumanizedBook): Promise<void> {
    const isbns = new Set<string>();
    const addClean = (raw?: string) => {
      const c = (raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
      if (c.length === 13) isbns.add(c);
    };
    addClean(book.isbn13);
    for (const k of book.knownIsbns || []) addClean(k);
    if (isbns.size === 0) return;

    const entries: LocalIsbnIndexEntry[] = Array.from(isbns).map((code) => ({
      isbn13: code,
      bookUri: book.uri,
      bookId: book.bookId,
      isIntegral: Boolean(book.isIntegral)
    }));
    await db.book_isbn_index.bulkPut(entries).catch(() => {});
  },

  async getBookByIsbn(isbn: string): Promise<HumanizedBook | undefined> {
    const clean = isbnUtil.normalize(isbn || '');
    const isbn13 = clean.length === 10 ? isbnUtil.toIsbn13(clean) : clean;
    if (isbn13.length === 13) {
      const indexed = await db.book_isbn_index.get(isbn13).catch(() => undefined);
      if (indexed?.bookUri) {
        const hit = await db.cache_books.get(indexed.bookUri);
        if (hit) return hit;
      }
    }
    return await db.cache_books
      .where('isbn13').equals(isbn13 || clean)
      .or('isbn10').equals(clean)
      .first();
  },

  async getOtherOwnedEdition(workUri: string, currentEditionUri: string): Promise<HumanizedBook | undefined> {
    if (!workUri) return undefined;
    const candidates = await db.cache_books
      .where('workUri').equals(workUri)
      .toArray();
    for (const book of candidates) {
      if (book.uri !== currentEditionUri) {
        const isOwned = await this.isUriInRegistry('inventory', book.uri);
        if (isOwned) return book;
      }
    }
    return undefined;
  },

  async getEditionByWorkFromCache(workUri: string): Promise<HumanizedBook | undefined> {
    return await db.cache_books.where('workUri').equals(workUri).first();
  },

  /**
   * [NOUVEAU V2] Récupère tous les tomes physiques associés à une série (par seriesId, avec repli par nom si seriesId absent)
   */
  async getBooksBySeriesId(seriesId: string, seriesNameHint?: string): Promise<HumanizedBook[]> {
    const byId = await db.cache_books.where('seriesId').equals(seriesId).toArray();
    const isOpaqueSeriesUri =
      seriesId.startsWith('inv:') || seriesId.startsWith('ser_') || seriesId.startsWith('wd:');

    const normTargets = new Set<string>();
    const addTarget = (raw?: string) => {
      const n = normalizeSeriesText(raw);
      if (n && n.length >= 2) normTargets.add(n);
    };
    if (seriesNameHint) addTarget(seriesNameHint);
    if (!isOpaqueSeriesUri) addTarget(seriesId);
    for (const b of byId) {
      if (b.series) addTarget(b.series);
    }

    let combined = byId;
    if (normTargets.size > 0 && (byId.length === 0 || !isOpaqueSeriesUri || Boolean(seriesNameHint))) {
      const allBooks = await db.cache_books.toArray();
      const byUri = new Map<string, HumanizedBook>();
      for (const b of byId) byUri.set(b.uri, b);
      for (const b of allBooks) {
        if (byUri.has(b.uri) || !b.series) continue;
        if (!normTargets.has(normalizeSeriesText(b.series))) continue;
        if (!b.seriesId || b.seriesId.startsWith('local:') || !isOpaqueSeriesUri) {
          byUri.set(b.uri, b);
        }
      }
      combined = Array.from(byUri.values());
    }

    return combined.filter((b) => !(b.hiddenSeriesIds || []).includes(seriesId));
  },

  // --- GESTION DU CACHE (Fiches complètes) ---
  
  async saveBookToCache(book: HumanizedBook): Promise<void> {
    console.log(`[DEBUG-DB] Écriture cache pour ${book.uri}. localCover: ${!!book.localCover}`);
    const plainBook = toPlainCloneable(book);
    plainBook.updatedAt = Date.now(); // AJOUT : Marquage temporel automatique (TTL)
    await db.cache_books.put(plainBook);
    await this.indexBookIsbns(plainBook);
  },

  async getBookFromCache(uri: string): Promise<HumanizedBook | undefined> {
    return await db.cache_books.get(uri);
  },

  async getAllCachedBooks(): Promise<HumanizedBook[]> {
    return await db.cache_books.toArray();
  },

  /**
   * [NOUVEAU V2] Récupère l'intégralité du cache local (pour la tâche de fond)
   */
  async getAllBooksFromCache(): Promise<HumanizedBook[]> {
    return await db.cache_books.toArray();
  },

  // --- GESTION DES REGISTRES (Listes légères) ---
  
  async addRegistryEntry(tableName: 'inventory' | 'wishlist', uri: string, itemId?: string): Promise<void> {
    const existing = await db[tableName].get(uri).catch(() => undefined);
    await db[tableName].put({
      uri,
      addedAt: existing?.addedAt || Date.now(),
      itemId: itemId || existing?.itemId
    });
  },

  async removeRegistryEntry(tableName: 'inventory' | 'wishlist', uri: string): Promise<void> {
    await db[tableName].delete(uri);
  },

  async getRegistryEntry(tableName: 'inventory' | 'wishlist', uri: string): Promise<RegistryEntry | undefined> {
    return await db[tableName].get(uri);
  },

  async isUriInRegistry(tableName: 'inventory' | 'wishlist', uri: string): Promise<boolean> {
    const entry = await db[tableName].get(uri);
    return !!entry;
  },

  async getAllRegistryUris(tableName: 'inventory' | 'wishlist'): Promise<string[]> {
    const entries = await db[tableName].toArray();
    return entries.map((entry: RegistryEntry) => entry.uri);
  },

  async getAllRegistryEntries(tableName: 'inventory' | 'wishlist'): Promise<RegistryEntry[]> {
    return await db[tableName].toArray();
  },

  // CORRECTION : Encapsulation dans une transaction atomique "rw" (Read/Write) en préservant addedAt et itemId
  async syncRegistry(tableName: 'inventory' | 'wishlist', items: (string | { uri: string, itemId?: string })[]): Promise<void> {
    await db.transaction('rw', db[tableName], async () => {
      const existingRows = await db[tableName].toArray();
      const existingByUri = new Map<string, RegistryEntry>();
      for (const r of existingRows) {
        if (r?.uri) existingByUri.set(r.uri, r);
      }
      await db[tableName].clear();
      const entries: RegistryEntry[] = items.map((item) => {
        if (typeof item === 'string') {
          const prev = existingByUri.get(item);
          return { uri: item, addedAt: prev?.addedAt || Date.now(), itemId: prev?.itemId };
        } else {
          const prev = existingByUri.get(item.uri);
          return {
            uri: item.uri,
            addedAt: prev?.addedAt || Date.now(),
            itemId: item.itemId || prev?.itemId
          };
        }
      });
      await db[tableName].bulkPut(entries);
    });
  },

  // --- GESTION DES PRÊTS (Table locale) ---

  async saveLoan(loan: LoanRecord): Promise<void> {
    await db.loans.put(toPlainCloneable(loan));
  },

  async deleteLoan(uri: string): Promise<void> {
    await db.loans.delete(uri);
  },

  async getLoan(uri: string): Promise<LoanRecord | undefined> {
    return await db.loans.get(uri);
  },

  async getAllLoans(): Promise<LoanRecord[]> {
    return await db.loans.toArray();
  },

  async searchBooksLocally(query: string): Promise<HumanizedBook[]> {
    if (!query || !query.trim()) return [];
    const normalizedQuery = query.toLowerCase().trim();
    const allBooks = await db.cache_books.toArray();
    return allBooks.filter(book => {
      const titleMatch = book.title?.toLowerCase().includes(normalizedQuery);
      const seriesMatch = book.series?.toLowerCase().includes(normalizedQuery);
      const authorMatch = book.authors?.some(author => author.toLowerCase().includes(normalizedQuery));
      return !!(titleMatch || seriesMatch || authorMatch);
    });
  },

  // --- NOUVEAU : GESTION DE LA FILE D'ATTENTE (Optimistic UI) ---

  async savePendingAction(action: PendingAction): Promise<number> {
    return await db.pending_actions.put(toPlainCloneable(action));
  },

  async getPendingActions(): Promise<PendingAction[]> {
    return await db.pending_actions.orderBy('createdAt').toArray();
  },

  async deletePendingAction(id: number): Promise<void> {
    await db.pending_actions.delete(id);
  },

  // --- GESTION DU CACHE AVANCÉE & FUSION DE SÉRIES ---

  async deleteBookFromCache(uri: string): Promise<void> {
    await db.cache_books.delete(uri);
    await db.book_isbn_index.where('bookUri').equals(uri).delete().catch(() => {});
  },

  /**
   * Remplace une fiche temporaire (ex: isbn:...) ou doublon par la fiche canonique (ex: inv:...)
   * en migrant atomiquement les registres, prêts, actions en file et métadonnées locales.
   */
  async replaceBookUri(oldUri: string, newBook: HumanizedBook): Promise<HumanizedBook> {
    const plainNew: HumanizedBook = JSON.parse(JSON.stringify(newBook));
    const mergedResult = await db.transaction(
      'rw',
      [db.cache_books, db.inventory, db.wishlist, db.loans, db.pending_actions, db.book_isbn_index],
      async () => {
        const oldBook = oldUri !== plainNew.uri ? await db.cache_books.get(oldUri) : undefined;
        const existingTarget = await db.cache_books.get(plainNew.uri);

        const rankOwnership = (s?: HumanizedBook['ownershipStatus']) =>
          s === 'owned' ? 2 : s === 'wish' ? 1 : 0;

        const bestOwnership = [oldBook?.ownershipStatus, existingTarget?.ownershipStatus, plainNew.ownershipStatus]
          .sort((a, b) => rankOwnership(b) - rankOwnership(a))[0] || 'none';

        const merged: HumanizedBook = {
          ...oldBook,
          ...existingTarget,
          ...plainNew,
          uri: plainNew.uri,
          localCover: plainNew.localCover || existingTarget?.localCover || oldBook?.localCover,
          coverUrl: plainNew.coverUrl || existingTarget?.coverUrl || oldBook?.coverUrl,
          isLocallyEdited: Boolean(plainNew.isLocallyEdited || existingTarget?.isLocallyEdited || oldBook?.isLocallyEdited),
          ownershipStatus: bestOwnership,
          updatedAt: Date.now()
        };

        await db.cache_books.put(merged);

        if (oldUri && oldUri !== plainNew.uri) {
          await db.cache_books.delete(oldUri);
          await db.book_isbn_index.where('bookUri').equals(oldUri).delete();

          const oldInv = await db.inventory.get(oldUri);
          if (oldInv) {
            const existingNewInv = await db.inventory.get(plainNew.uri);
            await db.inventory.put({
              uri: plainNew.uri,
              addedAt: oldInv.addedAt,
              itemId: existingNewInv?.itemId || oldInv.itemId
            });
            await db.inventory.delete(oldUri);
          }

          const oldWish = await db.wishlist.get(oldUri);
          if (oldWish) {
            await db.wishlist.put({ uri: plainNew.uri, addedAt: oldWish.addedAt });
            await db.wishlist.delete(oldUri);
          }

          const oldLoan = await db.loans.get(oldUri);
          if (oldLoan) {
            await db.loans.put({ ...oldLoan, uri: plainNew.uri });
            await db.loans.delete(oldUri);
          }

          const pending = await db.pending_actions.where('uri').equals(oldUri).toArray();
          for (const act of pending) {
            if (act.id !== undefined) {
              await db.pending_actions.update(act.id, { uri: plainNew.uri });
            }
          }
        }

        return merged;
      }
    );
    await this.indexBookIsbns(mergedResult).catch(() => {});
    return mergedResult;
  },

  async findLocalSeriesMatches(seriesName?: string, seriesId?: string): Promise<HumanizedBook[]> {
    const normTarget = normalizeSeriesText(seriesName);

    const allBooks = await db.cache_books.toArray();
    return allBooks.filter(book => {
      if (seriesId && book.seriesId === seriesId) return true;
      if (!normTarget || !book.series) return false;
      return normalizeSeriesText(book.series) === normTarget;
    });
  },

  // --- GESTION DES CRÉATIONS EN TÂCHE DE FOND ---

  async savePendingCreation(job: PendingCreation): Promise<number> {
    const plainJob: PendingCreation = JSON.parse(JSON.stringify(job));
    return await db.pending_creations.put(plainJob);
  },

  async getPendingCreations(): Promise<PendingCreation[]> {
    return await db.pending_creations.orderBy('createdAt').toArray();
  },

  async updatePendingCreation(id: number, patch: Partial<PendingCreation>): Promise<void> {
    await db.pending_creations.update(id, toPlainCloneable(patch));
  },

  async deletePendingCreation(id: number): Promise<void> {
    await db.pending_creations.delete(id);
  },

  // --- FILE PERSISTANTE D'ANALYSE PHOTO EN ARRIÈRE-PLAN ---

  async addPhotoScanJob(job: Omit<PhotoScanJobRecord, 'id'>): Promise<number> {
    const plainJob = JSON.parse(JSON.stringify(job));
    return await db.photo_scan_jobs.add(plainJob);
  },

  async getPhotoScanJobs(): Promise<PhotoScanJobRecord[]> {
    return await db.photo_scan_jobs.orderBy('createdAt').toArray();
  },

  async updatePhotoScanJob(id: number, patch: Partial<PhotoScanJobRecord>): Promise<void> {
    const plainPatch = JSON.parse(JSON.stringify(patch));
    await db.photo_scan_jobs.update(id, plainPatch);
  },

  async deletePhotoScanJob(id: number): Promise<void> {
    await db.photo_scan_jobs.delete(id);
  },

  async clearPhotoScanJobs(): Promise<void> {
    await db.photo_scan_jobs.clear();
  },

  /**
   * Vide intégralement toutes les tables locales IndexedDB (livres en cache, inventaire, wishlist, prêts, files d'attente)
   */
  async clearAllBookData(): Promise<void> {
    await db.transaction(
      'rw',
      [
        db.inventory,
        db.wishlist,
        db.cache_books,
        db.loans,
        db.pending_actions,
        db.pending_creations,
        db.photo_scan_jobs,
        db.book_isbn_index
      ],
      async () => {
        await Promise.all([
          db.inventory.clear(),
          db.wishlist.clear(),
          db.cache_books.clear(),
          db.loans.clear(),
          db.pending_actions.clear(),
          db.pending_creations.clear(),
          db.photo_scan_jobs.clear(),
          db.book_isbn_index.clear()
        ]);
      }
    );
  }
};