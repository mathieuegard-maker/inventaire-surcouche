// src/core/resolvers/series.resolver.ts
import { entityMapper } from './mapper';
import { databaseService } from '../database/database.service';
import { inventoryService } from '../services/inventory.service';
import { wishlistService } from '../services/wishlist.service';
import { syncOrchestrator } from '../orchestrators/sync.orchestrator'; 
import type { HumanizedBook } from '../types';

export const seriesResolver = {
  async getFullSeries(seriesId: string): Promise<HumanizedBook[]> {
    console.group(`[SERIES RESOLVER] Récupération de la série: ${seriesId}`);
    
    const resList = await fetch(`/api/gateway?action=series-list&seriesId=${encodeURIComponent(seriesId)}`);
    const { tomes: tomeUris } = await resList.json();
    
    if (!tomeUris || tomeUris.length === 0) {
      console.groupEnd();
      return [];
    }

    const fullTomes: HumanizedBook[] = [];
    const missingUris: string[] = [];

    for (const uri of tomeUris) {
      let cachedBook = await databaseService.getBookFromCache(uri);
      
      if (!cachedBook && uri.startsWith('wd:')) {
        cachedBook = await databaseService.getEditionByWorkFromCache(uri);
      }

      if (cachedBook) {
        const isOwned = await inventoryService.isUriOwned(cachedBook.uri, cachedBook.workUri);
        const isWished = await wishlistService.isUriWished(cachedBook.uri, cachedBook.workUri);
        cachedBook.ownershipStatus = isOwned ? 'owned' : (isWished ? 'wish' : 'none');
        
        fullTomes.push(cachedBook);
      } else {
        missingUris.push(uri);
      }
    }

    let urgentUris: string[] = [];
    
    if (missingUris.length > 0) {
      const URGENT_LIMIT = 20; 
      urgentUris = missingUris.slice(0, URGENT_LIMIT);
      const backgroundUris = missingUris.slice(URGENT_LIMIT);

      console.log(`[SERIES] Windowing activé : ${urgentUris.length} urgents, ${backgroundUris.length} en arrière-plan.`);

      if (backgroundUris.length > 0) {
        syncOrchestrator.hydrateRemainingSeries(backgroundUris).catch(e => console.error(e));
      }
    }

    if (urgentUris.length > 0) {
      // NOTE : Si le nombre d'URIs est très long, on passera la requête au proxy Inventaire officiel
      // Mais ici, on utilise l'endpoint Vercel gateway
      const resData = await fetch(`https://inventaire.io/api/entities/by-uris?uris=${encodeURIComponent(urgentUris.join('|'))}`);
      const data = await resData.json();
      const entities = data.entities || data;

      const idsToTranslate = new Set<string>();
      const rawBooks = urgentUris.map((uri: string) => {
        const raw = entityMapper.mapResponse(uri, entities[uri]);
        [...raw.authorIds, ...raw.illustratorIds, ...raw.scriptwriterIds, ...raw.genreIds].forEach(id => {
          if (id) idsToTranslate.add(id);
        });
        if (raw.seriesId) idsToTranslate.add(raw.seriesId);
        if (raw.publisherId) idsToTranslate.add(raw.publisherId);
        if (raw.collectionId) idsToTranslate.add(raw.collectionId);
        return raw;
      });

      const resTrans = await fetch(`https://inventaire.io/api/entities/by-uris?uris=${encodeURIComponent(Array.from(idsToTranslate).join('|'))}`);
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