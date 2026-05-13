// src/resolvers/series.resolver.ts
import { entityMapper } from './mapper';
import { databaseService } from '../services/database.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import type { HumanizedBook, RawBook } from './types';

export const seriesResolver = {
  /**
   * Récupère tous les tomes d'une série en mode Local-First
   */
  async getFullSeries(seriesId: string): Promise<HumanizedBook[]> {
    console.group(`[SERIES RESOLVER] Récupération de la série: ${seriesId}`);
    
    // 1. Liste des IDs via notre proxy
    const resList = await fetch(`/api/series/list?seriesId=${encodeURIComponent(seriesId)}`);
    const { tomes: tomeUris } = await resList.json();
    
    if (!tomeUris || tomeUris.length === 0) {
      console.groupEnd();
      return [];
    }

    const fullTomes: HumanizedBook[] = [];
    const missingUris: string[] = [];

    // 2. TUNNEL LOCAL-FIRST INTELLIGENT
    for (const uri of tomeUris) {
      let cachedBook = await databaseService.getBookFromCache(uri);
      
      // AJOUT : Si la série donne une Œuvre (wd:) mais qu'on a l'Édition (inv:) en cache
      if (!cachedBook && uri.startsWith('wd:')) {
        cachedBook = await databaseService.getEditionByWorkFromCache(uri);
      }

      if (cachedBook) {
        // Utilisation de la vérification intelligente
        const isOwned = await inventoryService.isUriOwned(cachedBook.uri, cachedBook.workUri);
        const isWished = await wishlistService.isUriWished(cachedBook.uri, cachedBook.workUri);
        cachedBook.ownershipStatus = isOwned ? 'owned' : (isWished ? 'wish' : 'none');
        
        fullTomes.push(cachedBook);
      } else {
        missingUris.push(uri);
      }
    }

    console.log(`[SERIES] Cache local : ${fullTomes.length} | À télécharger : ${missingUris.length}`);

    // 3. RÉCUPÉRATION ET TRADUCTION EN BATCH DES MANQUANTS
    if (missingUris.length > 0) {
      const resData = await fetch(`/api/entities/by-uris?uris=${encodeURIComponent(missingUris.join('|'))}`);
      const data = await resData.json();
      const entities = data.entities || data;

      const idsToTranslate = new Set<string>();
      const rawBooks = missingUris.map((uri: string) => {
        const raw = entityMapper.mapResponse(uri, entities[uri]);
        [...raw.authorIds, ...raw.illustratorIds, ...raw.scriptwriterIds, ...raw.genreIds].forEach(id => {
          if (id) idsToTranslate.add(id);
        });
        if (raw.seriesId) idsToTranslate.add(raw.seriesId);
        if (raw.publisherId) idsToTranslate.add(raw.publisherId);
        if (raw.collectionId) idsToTranslate.add(raw.collectionId);
        return raw;
      });

      const resTrans = await fetch(`/api/entities/by-uris?uris=${encodeURIComponent(Array.from(idsToTranslate).join('|'))}`);
      const transData = await resTrans.json();
      const transEntities = transData.entities || transData;

      const getName = (id?: string) => {
        const e = transEntities[id || ''];
        return e ? (e.label || e.labels?.fr || id) : id;
      };

      for (const raw of rawBooks) {
        const translatedAuthors = raw.authorIds.map(id => getName(id)!);
        const translatedIllustrators = raw.illustratorIds.map(id => getName(id)!);
        const translatedScriptwriters = raw.scriptwriterIds.map(id => getName(id)!);

        const isOwned = await inventoryService.isUriOwned(raw.uri, raw.workUri);
        const isWished = await wishlistService.isUriWished(raw.uri, raw.workUri);

        const humanized: HumanizedBook = {
          ...raw,
          authors: translatedAuthors.length > 0 ? translatedAuthors : Array.from(new Set([...translatedScriptwriters, ...translatedIllustrators])),
          illustrators: translatedIllustrators,
          scriptwriters: translatedScriptwriters,
          genres: raw.genreIds.map(id => getName(id)!),
          series: getName(raw.seriesId),
          publisher: getName(raw.publisherId),
          collection: getName(raw.collectionId),
          ownershipStatus: isOwned ? 'owned' : (isWished ? 'wish' : 'none')
        };

        await databaseService.saveBookToCache(humanized);
        fullTomes.push(humanized);
      }
    }

    console.groupEnd();
    
    return fullTomes.sort((a, b) => {
      const numA = parseInt(a.seriesNumber || '999');
      const numB = parseInt(b.seriesNumber || '999');
      return numA - numB;
    });
  }
};