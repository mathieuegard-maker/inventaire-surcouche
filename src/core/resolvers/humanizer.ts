// src/resolvers/humanizer.ts
import { entityResolver } from './entity.resolver';
import type { RawBook, HumanizedBook } from '../types';
import { imageService } from '../services/image.service';

export const entityHumanizer = {
  async humanize(rawBook: RawBook): Promise<HumanizedBook> {
    console.log(`[HUMANIZER] Début pour ${rawBook.uri}`);

    const [
      authors,
      illustrators,
      scriptwriters,
      publisher,
      series,
      genres,
      collection
    ] = await Promise.all([
      Promise.all((rawBook.authorIds || []).map(id => entityResolver.resolveName(id))),
      Promise.all((rawBook.illustratorIds || []).map(id => entityResolver.resolveName(id))),
      Promise.all((rawBook.scriptwriterIds || []).map(id => entityResolver.resolveName(id))),
      rawBook.publisherId ? entityResolver.resolveName(rawBook.publisherId) : Promise.resolve(undefined),
      rawBook.seriesId ? entityResolver.resolveName(rawBook.seriesId) : Promise.resolve(undefined),
      Promise.all((rawBook.genreIds || []).map(id => entityResolver.resolveName(id))),
      rawBook.collectionId ? entityResolver.resolveName(rawBook.collectionId) : Promise.resolve(undefined)
    ]);

    // SONDE DEBUG : URL REÇUE DANS LE HUMANIZER
    console.log(`[DEBUG-HUMANIZER] URL avant compression pour ${rawBook.uri} :`, rawBook.coverUrl);

    // Tolérance si le mapper utilise encore l'ancien format 'image'
    const targetImageUrl = rawBook.coverUrl || (rawBook as any).image;
    
    // Compression de l'image pour le cache local
    let localCover = undefined;
    if (targetImageUrl) {
      console.log(`[HUMANIZER] Compression de la couverture pour ${rawBook.uri}...`);
      localCover = await imageService.compressAndEncode(targetImageUrl) || undefined;
      
      // SONDE DEBUG : RÉSULTAT COMPRESSION
      console.log(`[DEBUG-HUMANIZER] Résultat compression (localCover) :`, localCover ? "OK (Base64)" : "ÉCHEC (Null)");
    }

    const humanized: HumanizedBook = {
      uri: rawBook.uri,
      workUri: rawBook.workUri,
      type: rawBook.type,
      title: rawBook.title,
      subtitle: rawBook.subtitle,
      originalTitle: rawBook.originalTitle,
      description: rawBook.description,
      isbn13: rawBook.isbn13,
      isbn10: rawBook.isbn10,
      coverUrl: targetImageUrl,
      localCover: localCover,
      pageCount: rawBook.pageCount,
      publishDate: rawBook.publishDate,
      format: rawBook.format,
      language: rawBook.language,

      authors: authors.filter(Boolean) as string[],
      illustrators: illustrators.filter(Boolean) as string[],
      scriptwriters: scriptwriters.filter(Boolean) as string[],
      publisher: publisher || undefined,
      series: series || undefined,
      seriesId: rawBook.seriesId,
      seriesNumber: rawBook.seriesNumber,
      genres: genres.filter(Boolean) as string[],
      collection: collection || undefined,

      // Initialisation par défaut pour le Cerveau Métier
      ownershipStatus: 'none'
    };

    console.log(`[HUMANIZER] Succès pour ${rawBook.uri}`);
    return humanized;
  }
};