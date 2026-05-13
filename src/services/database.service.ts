// src/services/database.service.ts
import Dexie, { type Table } from 'dexie';
import type { HumanizedBook } from '../resolvers/types';

export interface RegistryEntry {
  uri: string;
  addedAt: number;
}

export class AppDatabase extends Dexie {
  inventory!: Table<RegistryEntry, string>;
  wishlist!: Table<RegistryEntry, string>;
  cache_books!: Table<HumanizedBook, string>;

  constructor() {
    super('InventaireLocalDBV2');
    // On passe à la version 2 et on enlève le "&" redondant sur les clés primaires
    this.version(2).stores({
      inventory: 'uri',
      wishlist: 'uri',
      cache_books: 'uri, workUri, seriesId, isbn13, isbn10, ownershipStatus' 
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

  /**
   * RECTIFICATION : Ne se fie plus au champ 'ownershipStatus' du cache (statique)
   * mais vérifie la présence réelle de l'URI dans le registre inventory.
   */
  async getOtherOwnedEdition(workUri: string, currentEditionUri: string): Promise<HumanizedBook | undefined> {
    if (!workUri) return undefined;
    
    // On récupère toutes les éditions de cette œuvre présentes en cache
    const candidates = await db.cache_books
      .where('workUri').equals(workUri)
      .toArray();

    // On cherche la première qui est réellement marquée comme possédée dans le registre
    for (const book of candidates) {
      if (book.uri !== currentEditionUri) {
        const isOwned = await this.isUriInRegistry('inventory', book.uri);
        if (isOwned) return book;
      }
    }
    return undefined;
  },

  /**
   * AJOUT : Permet de retrouver une édition mise en cache à partir de son œuvre
   */
  async getEditionByWorkFromCache(workUri: string): Promise<HumanizedBook | undefined> {
    return await db.cache_books.where('workUri').equals(workUri).first();
  },

  // --- GESTION DU CACHE (Fiches complètes) ---
  
  async saveBookToCache(book: HumanizedBook): Promise<void> {
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
    return entries.map(entry => entry.uri);
  },

  async syncRegistry(tableName: 'inventory' | 'wishlist', uris: string[]): Promise<void> {
    await db[tableName].clear();
    const entries: RegistryEntry[] = uris.map(uri => ({ uri, addedAt: Date.now() }));
    await db[tableName].bulkPut(entries);
  }
};