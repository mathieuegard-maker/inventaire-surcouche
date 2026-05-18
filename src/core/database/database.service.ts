// src/services/database.service.ts
import Dexie, { type Table } from 'dexie';
import type { HumanizedBook, LoanRecord, RegistryEntry } from '../types';

export class AppDatabase extends Dexie {
  inventory!: Table<RegistryEntry, string>;
  wishlist!: Table<RegistryEntry, string>;
  cache_books!: Table<HumanizedBook, string>;
  loans!: Table<LoanRecord, string>; // Nouvelle table pour le carnet de prêt

  constructor() {
    super('InventaireLocalDBV2');
    
    // Version 3 : Ajout de la table des prêts
    this.version(3).stores({
      inventory: 'uri',
      wishlist: 'uri',
      cache_books: 'uri, workUri, seriesId, isbn13, isbn10, ownershipStatus',
      loans: 'uri, friendName' // Indexation par URI et Nom d'ami
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

  // --- GESTION DU CACHE (Fiches complètes) ---
  
  async saveBookToCache(book: HumanizedBook): Promise<void> {
    console.log(`[DEBUG-DB] Écriture cache pour ${book.uri}. localCover: ${!!book.localCover}`);
    await db.cache_books.put(book);
  },

  async getBookFromCache(uri: string): Promise<HumanizedBook | undefined> {
    return await db.cache_books.get(uri);
  },

  async getAllCachedBooks(): Promise<HumanizedBook[]> {
    return await db.cache_books.toArray();
  },

  // --- GESTION DES REGISTRES (Listes légères) ---
  
  async addRegistryEntry(tableName: 'inventory' | 'wishlist', uri: string): Promise<void> {
    await db[tableName].put({ uri, addedAt: Date.now() });
  },

  async removeRegistryEntry(tableName: 'inventory' | 'wishlist', uri: string): Promise<void> {
    await db[tableName].delete(uri);
  },

  async isUriInRegistry(tableName: 'inventory' | 'wishlist', uri: string): Promise<boolean> {
    const entry = await db[tableName].get(uri);
    return !!entry;
  },

  async getAllRegistryUris(tableName: 'inventory' | 'wishlist'): Promise<string[]> {
    const entries = await db[tableName].toArray();
    return entries.map((entry: RegistryEntry) => entry.uri);
  },

  async syncRegistry(tableName: 'inventory' | 'wishlist', uris: string[]): Promise<void> {
    await db[tableName].clear();
    const entries: RegistryEntry[] = uris.map((uri: string) => ({ uri, addedAt: Date.now() }));
    await db[tableName].bulkPut(entries);
  },

  // --- NOUVEAU : GESTION DES PRÊTS (Table locale) ---

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
  }
};