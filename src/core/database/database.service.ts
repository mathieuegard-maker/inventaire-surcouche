// src/core/database/database.service.ts
import Dexie, { type Table } from 'dexie';
import type { HumanizedBook, LoanRecord, RegistryEntry, QueueActionPayload } from '../types';

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
  status: 'pending' | 'processing' | 'failed';
  errorMessage?: string;
  createdAt: number;
}

export class AppDatabase extends Dexie {
  inventory!: Table<RegistryEntry, string>;
  wishlist!: Table<RegistryEntry, string>;
  cache_books!: Table<HumanizedBook, string>;
  loans!: Table<LoanRecord, string>; // Table pour le carnet de prêt
  pending_actions!: Table<PendingAction, number>; // NOUVELLE TABLE : File d'attente
  pending_creations!: Table<PendingCreation, number>; // File de créations distantes en tâche de fond

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
  }
}

export const db = new AppDatabase();

export const databaseService = {
  // --- RECHERCHES LOCAL-FIRST (Double Check) ---

  async getBookByIsbn(isbn: string): Promise<HumanizedBook | undefined> {
    return await db.cache_books
      .where('isbn13').equals(isbn)
      .or('isbn10').equals(isbn)
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
   * [NOUVEAU V2] Récupère tous les tomes physiques associés à une série
   */
  async getBooksBySeriesId(seriesId: string): Promise<HumanizedBook[]> {
    return await db.cache_books.where('seriesId').equals(seriesId).toArray();
  },

  // --- GESTION DU CACHE (Fiches complètes) ---
  
  async saveBookToCache(book: HumanizedBook): Promise<void> {
    console.log(`[DEBUG-DB] Écriture cache pour ${book.uri}. localCover: ${!!book.localCover}`);
    book.updatedAt = Date.now(); // AJOUT : Marquage temporel automatique (TTL)
    await db.cache_books.put(book);
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
    await db[tableName].put({ uri, addedAt: Date.now(), itemId });
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

  // CORRECTION : Encapsulation dans une transaction atomique "rw" (Read/Write)
  async syncRegistry(tableName: 'inventory' | 'wishlist', items: (string | { uri: string, itemId?: string })[]): Promise<void> {
    await db.transaction('rw', db[tableName], async () => {
      await db[tableName].clear();
      const entries: RegistryEntry[] = items.map((item) => {
        if (typeof item === 'string') {
          return { uri: item, addedAt: Date.now() };
        } else {
          return { uri: item.uri, addedAt: Date.now(), itemId: item.itemId };
        }
      });
      await db[tableName].bulkPut(entries);
    });
  },

  // --- GESTION DES PRÊTS (Table locale) ---

  async saveLoan(loan: LoanRecord): Promise<void> {
    await db.loans.put(loan);
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
    return await db.pending_actions.put(action);
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
  },

  /**
   * Remplace une fiche temporaire (ex: isbn:...) ou doublon par la fiche canonique (ex: inv:...)
   * en migrant atomiquement les registres, prêts, actions en file et métadonnées locales.
   */
  async replaceBookUri(oldUri: string, newBook: HumanizedBook): Promise<HumanizedBook> {
    const plainNew: HumanizedBook = JSON.parse(JSON.stringify(newBook));
    return await db.transaction(
      'rw',
      [db.cache_books, db.inventory, db.wishlist, db.loans, db.pending_actions],
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
  },

  async findLocalSeriesMatches(seriesName?: string, seriesId?: string): Promise<HumanizedBook[]> {
    const normTarget = (seriesName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['’".,:;!?()\[\]-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const allBooks = await db.cache_books.toArray();
    return allBooks.filter(book => {
      if (seriesId && book.seriesId === seriesId) return true;
      if (!normTarget || !book.series) return false;
      const normBookSeries = book.series
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/['’".,:;!?()\[\]-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return normBookSeries === normTarget;
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
    await db.pending_creations.update(id, patch);
  },

  async deletePendingCreation(id: number): Promise<void> {
    await db.pending_creations.delete(id);
  },

  /**
   * Vide intégralement toutes les tables locales IndexedDB (livres en cache, inventaire, wishlist, prêts, files d'attente)
   */
  async clearAllBookData(): Promise<void> {
    await db.transaction(
      'rw',
      [db.inventory, db.wishlist, db.cache_books, db.loans, db.pending_actions, db.pending_creations],
      async () => {
        await Promise.all([
          db.inventory.clear(),
          db.wishlist.clear(),
          db.cache_books.clear(),
          db.loans.clear(),
          db.pending_actions.clear(),
          db.pending_creations.clear()
        ]);
      }
    );
  }
};