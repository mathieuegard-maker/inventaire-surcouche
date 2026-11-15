// src/core/services/photo-book-resolution.service.ts
import { databaseService } from '../database/database.service';
import { bnfResolver, normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';
import { entityResolver } from '../resolvers/entity.resolver';
import { externalMetadataService } from './external-metadata.service';
import { wishlistService } from './wishlist.service';
import { isbnUtil } from '../utils/isbn.util';
import type { RecognizedBookCandidate } from './byok-vision.service';
import type { ExternalBookMetadata } from '../types';

export interface ResolvedPhotoItem {
  id: string;
  sourceKind: 'detected' | 'series_extra';
  rawCandidate: RecognizedBookCandidate;
  status: 'resolved' | 'unresolved';
  selected: boolean;
  alreadyOwned: boolean;
  alreadyWished: boolean;
  isbn13?: string;
  title: string;
  authors: string[];
  publisher?: string;
  publishDate?: string;
  pageCount?: number;
  coverUrl?: string;
  series?: string;
  seriesNumber?: string;
  existingUri?: string;
  existingWorkUri?: string;
  failureReason?: string;
}

export interface PhotoBatchResolutionResult {
  detectedItems: ResolvedPhotoItem[];
  seriesExtraItems: ResolvedPhotoItem[];
  detectedSeriesNames: string[];
}

function normalizeToIsbn13(raw?: string): string | undefined {
  if (!raw || !isbnUtil.isValidFormat(raw)) return undefined;
  const clean = isbnUtil.normalize(raw);
  if (!clean) return undefined;
  return clean.length === 10 ? isbnUtil.toIsbn13(clean) : clean;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  const runners = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return results;
}

async function checkOwnershipByIsbn(isbn13: string): Promise<{
  alreadyOwned: boolean;
  alreadyWished: boolean;
  existingUri?: string;
  existingWorkUri?: string;
  cachedCover?: string;
}> {
  try {
    const localBook = await databaseService.getBookByIsbn(isbn13);
    if (!localBook) {
      return { alreadyOwned: false, alreadyWished: false };
    }

    const isOwned =
      localBook.ownershipStatus === 'owned' ||
      (await databaseService.isUriInRegistry('inventory', localBook.uri));
    const isWished =
      localBook.ownershipStatus === 'wish' ||
      (await wishlistService.isUriWished(localBook.uri, localBook.workUri));

    return {
      alreadyOwned: isOwned,
      alreadyWished: !isOwned && isWished,
      existingUri: localBook.uri,
      existingWorkUri: localBook.workUri,
      cachedCover: localBook.localCover || localBook.coverUrl
    };
  } catch {
    return { alreadyOwned: false, alreadyWished: false };
  }
}

export const photoBookResolutionService = {
  /**
   * Prend un candidat issu de l'IA (titre, série, tome, auteur, éditeur, éventuellement ISBN),
   * retrouve son ISBN-13 officiel (BnF prioritaire puis Google Books), puis exécute
   * le flux classique complet par ISBN (BnF + Open Library + Google Books + D1).
   */
  async resolveSingleCandidate(cand: RecognizedBookCandidate, idPrefix = 'det'): Promise<ResolvedPhotoItem> {
    const uid = `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    try {
      // 1. Retrouver un ISBN-13 officiel à partir des indices visuels (si absent)
      let isbn13 = normalizeToIsbn13(cand.isbn);
      let hintMatchMeta: ExternalBookMetadata | null = null;

      if (!isbn13) {
        hintMatchMeta = await bnfResolver.searchBestMatchByHints({
          title: cand.title,
          series: cand.series,
          volumeNumber: cand.volumeNumber,
          author: cand.author,
          publisher: cand.publisher
        });
        if (hintMatchMeta?.isbn) {
          isbn13 = normalizeToIsbn13(hintMatchMeta.isbn);
        }
      }

      if (!isbn13) {
        const gbHintMeta = await googleBooksResolver.searchByHints({
          title: cand.title,
          series: cand.series,
          volumeNumber: cand.volumeNumber,
          author: cand.author,
          publisher: cand.publisher
        });
        if (gbHintMeta?.isbn) {
          isbn13 = normalizeToIsbn13(gbHintMeta.isbn);
          hintMatchMeta = gbHintMeta;
        }
      }

      if (!isbn13) {
        return {
          id: uid,
          sourceKind: 'detected',
          rawCandidate: { ...cand },
          status: 'unresolved',
          selected: false,
          alreadyOwned: false,
          alreadyWished: false,
          title: cand.title,
          authors: cand.author ? [cand.author] : [],
          publisher: cand.publisher,
          series: cand.series,
          seriesNumber: cand.volumeNumber,
          failureReason: 'Aucun ISBN / notice BnF trouvé. Corrigez les champs et relancez la recherche.'
        };
      }

      // 2. Flux classique complet par ISBN : BnF -> Open Library -> Google Books + vérification D1 / cache local
      const [externalMeta, ownership, d1Entity] = await Promise.all([
        externalMetadataService.fetchFromExternalSources(isbn13),
        checkOwnershipByIsbn(isbn13),
        entityResolver.resolvePhysicalEntity(`isbn:${isbn13}`).catch(() => null)
      ]);

      const mergedTitle =
        externalMeta?.title?.trim() ||
        d1Entity?.title?.trim() ||
        hintMatchMeta?.title?.trim() ||
        cand.title;

      const mergedAuthors =
        externalMeta?.authors?.length
          ? externalMeta.authors
          : d1Entity?.authors?.length
            ? d1Entity.authors
            : hintMatchMeta?.authors?.length
              ? hintMatchMeta.authors
              : cand.author
                ? [cand.author]
                : [];

      const mergedCover =
        externalMeta?.coverUrl ||
        ownership.cachedCover ||
        d1Entity?.localCover ||
        d1Entity?.coverUrl ||
        hintMatchMeta?.coverUrl;

      const mergedSeries =
        externalMeta?.series || d1Entity?.series || hintMatchMeta?.series || cand.series;
      const mergedSeriesNum =
        externalMeta?.seriesNumber ||
        d1Entity?.seriesNumber ||
        hintMatchMeta?.seriesNumber ||
        cand.volumeNumber;

      return {
        id: uid,
        sourceKind: 'detected',
        rawCandidate: { ...cand },
        status: 'resolved',
        selected: !ownership.alreadyOwned,
        alreadyOwned: ownership.alreadyOwned,
        alreadyWished: ownership.alreadyWished,
        isbn13,
        title: mergedTitle,
        authors: mergedAuthors,
        publisher: externalMeta?.publisher || d1Entity?.publisher || hintMatchMeta?.publisher || cand.publisher,
        publishDate: externalMeta?.publishDate || d1Entity?.publishDate || hintMatchMeta?.publishDate,
        pageCount: externalMeta?.pageCount || d1Entity?.pageCount || hintMatchMeta?.pageCount,
        coverUrl: mergedCover,
        series: mergedSeries,
        seriesNumber: mergedSeriesNum,
        existingUri: ownership.existingUri || d1Entity?.uri,
        existingWorkUri: ownership.existingWorkUri || d1Entity?.workUri
      };
    } catch (err: unknown) {
      return {
        id: uid,
        sourceKind: 'detected',
        rawCandidate: { ...cand },
        status: 'unresolved',
        selected: false,
        alreadyOwned: false,
        alreadyWished: false,
        title: cand.title,
        authors: cand.author ? [cand.author] : [],
        publisher: cand.publisher,
        series: cand.series,
        seriesNumber: cand.volumeNumber,
        failureReason: err instanceof Error ? err.message : 'Erreur lors de la recherche BnF.'
      };
    }
  },

  /**
   * Résout l'ensemble des livres détectés sur la photo via le flux ISBN complet,
   * puis active la découverte des autres tomes de chaque série détectée pour les proposer
   * dans la liste finale de validation.
   */
  async resolveCandidatesAndDiscoverSeries(
    candidates: RecognizedBookCandidate[],
    onStatus?: (msg: string) => void
  ): Promise<PhotoBatchResolutionResult> {
    let completed = 0;
    onStatus?.(`Identification BnF / ISBN (0/${candidates.length})...`);

    const resolvedRaw = await runWithConcurrency(candidates, 3, async (cand, idx) => {
      const item = await this.resolveSingleCandidate(cand, `det-${idx}`);
      completed++;
      onStatus?.(`Identification BnF / ISBN (${completed}/${candidates.length})...`);
      return item;
    });

    // Dédoublonnage si deux éléments de la photo ont pointé vers le même ISBN-13
    const seenIsbns = new Set<string>();
    const detectedItems: ResolvedPhotoItem[] = [];
    for (const item of resolvedRaw) {
      if (item.isbn13) {
        if (seenIsbns.has(item.isbn13)) continue;
        seenIsbns.add(item.isbn13);
      }
      detectedItems.push(item);
    }

    // Collecte des séries uniques détectées pour activer la proposition des autres tomes
    const seriesMap = new Map<string, { seriesName: string; author?: string }>();
    const knownVolKeysBySeries = new Map<string, Set<string>>();

    for (const item of detectedItems) {
      if (item.status !== 'resolved' || !item.series?.trim()) continue;
      const seriesKey = normalizeTextKey(item.series);
      if (!seriesKey) continue;

      if (!seriesMap.has(seriesKey)) {
        seriesMap.set(seriesKey, { seriesName: item.series.trim(), author: item.authors[0] });
      }
      const volSet = knownVolKeysBySeries.get(seriesKey) || new Set<string>();
      const normNum = normalizeSeriesNumber(item.seriesNumber);
      if (normNum) volSet.add(`num:${normNum}`);
      if (item.title) volSet.add(`title:${normalizeTextKey(item.title)}`);
      knownVolKeysBySeries.set(seriesKey, volSet);
    }

    const seriesExtraItems: ResolvedPhotoItem[] = [];
    const detectedSeriesNames: string[] = [];

    for (const [seriesKey, { seriesName, author }] of seriesMap.entries()) {
      detectedSeriesNames.push(seriesName);
      onStatus?.(`Recherche des autres tomes de la série « ${seriesName} » sur la BnF...`);

      const bnfVolumes = await bnfResolver.searchSeriesVolumes(seriesName, author);
      const knownVols = knownVolKeysBySeries.get(seriesKey) || new Set<string>();

      const candidateExtras: ExternalBookMetadata[] = [];
      for (const vol of bnfVolumes) {
        const volIsbn13 = normalizeToIsbn13(vol.isbn);
        if (!volIsbn13 || seenIsbns.has(volIsbn13)) continue;

        const normNum = normalizeSeriesNumber(vol.seriesNumber);
        if (normNum && knownVols.has(`num:${normNum}`)) continue;
        if (!normNum && knownVols.has(`title:${normalizeTextKey(vol.title)}`)) continue;

        seenIsbns.add(volIsbn13);
        candidateExtras.push({ ...vol, isbn: volIsbn13 });
      }

      if (candidateExtras.length === 0) continue;

      onStatus?.(
        `Récupération des couvertures manquantes pour « ${seriesName} » (${candidateExtras.length} tomes)...`
      );

      const enrichedExtras = await runWithConcurrency(candidateExtras, 3, async (vol, idx) => {
        const ownership = await checkOwnershipByIsbn(vol.isbn);
        let finalMeta: ExternalBookMetadata = vol;

        // S'il n'y a pas encore de couverture depuis la BnF, passage par le flux classique (OpenLibrary / Google Books)
        if (!vol.coverUrl && !ownership.cachedCover) {
          const ext = await externalMetadataService.fetchFromExternalSources(vol.isbn).catch(() => null);
          if (ext) {
            finalMeta = {
              ...vol,
              title: ext.title || vol.title,
              authors: ext.authors.length > 0 ? ext.authors : vol.authors,
              publisher: ext.publisher || vol.publisher,
              publishDate: ext.publishDate || vol.publishDate,
              pageCount: ext.pageCount || vol.pageCount,
              coverUrl: ext.coverUrl || vol.coverUrl,
              series: ext.series || vol.series,
              seriesNumber: ext.seriesNumber || vol.seriesNumber
            };
          }
        }

        const coverUrl = finalMeta.coverUrl || ownership.cachedCover;

        return {
          id: `extra-${seriesKey}-${idx}-${vol.isbn}`,
          sourceKind: 'series_extra' as const,
          rawCandidate: {
            title: finalMeta.title,
            series: finalMeta.series || seriesName,
            volumeNumber: finalMeta.seriesNumber,
            author: finalMeta.authors[0],
            publisher: finalMeta.publisher,
            isbn: vol.isbn
          },
          status: 'resolved' as const,
          selected: !ownership.alreadyOwned,
          alreadyOwned: ownership.alreadyOwned,
          alreadyWished: ownership.alreadyWished,
          isbn13: vol.isbn,
          title: finalMeta.title,
          authors: finalMeta.authors,
          publisher: finalMeta.publisher,
          publishDate: finalMeta.publishDate,
          pageCount: finalMeta.pageCount,
          coverUrl,
          series: finalMeta.series || seriesName,
          seriesNumber: finalMeta.seriesNumber,
          existingUri: ownership.existingUri,
          existingWorkUri: ownership.existingWorkUri
        };
      });

      seriesExtraItems.push(...enrichedExtras);
    }

    return {
      detectedItems,
      seriesExtraItems,
      detectedSeriesNames
    };
  }
};
