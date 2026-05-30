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

export class AppDatabase extends Dexie {
  inventory!: Table<RegistryEntry, string>;
  wishlist!: Table<RegistryEntry, string>;
  cache_books!: Table<HumanizedBook, string>;
  loans!: Table<LoanRecord, string>; // Table pour le carnet de prêt
  pending_actions!: Table<PendingAction, number>; // NOUVELLE TABLE : File d'attente

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
  }
};