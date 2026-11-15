// src/core/services/photo-book-resolution.service.ts
import { databaseService } from '../database/database.service';
import {
  bnfResolver,
  normalizeSeriesNumber,
  normalizeTextKey,
  scoreHintMatch,
  type BnfHintQuery
} from '../resolvers/bnf.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';
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
  correctedFromAi?: boolean;
  sourcesCount?: number;
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

type DiscoverySource = 'bnf' | 'google' | 'openlibrary';

interface ConsensusBucket {
  isbn13: string;
  bestScore: number;
  sources: Set<DiscoverySource>;
  workKey: string;
  bestMeta: ExternalBookMetadata;
  fromBnf: boolean;
}

interface ShelfSeriesNeighbor {
  spineIndex: number;
  series: string;
  author?: string;
  publisher?: string;
}

const CONSENSUS_SCORE_THRESHOLD = 28;
const MULTI_SOURCE_ISBN_BONUS = 22;
const MULTI_SOURCE_WORK_BONUS = 14;
const BNF_AUTHORITY_TIEBREAK = 6;

function buildHintQuery(cand: RecognizedBookCandidate): BnfHintQuery {
  return {
    title: cand.title,
    subtitle: cand.subtitle,
    series: cand.series,
    volumeNumber: cand.volumeNumber,
    author: cand.author,
    illustrator: cand.illustrator,
    publisher: cand.publisher,
    collection: cand.collection,
    rawSpineText: cand.rawSpineText
  };
}

function computeWorkKey(meta: { series?: string; seriesNumber?: string; title?: string }): string {
  const normSeries = meta.series ? normalizeTextKey(meta.series) : '';
  const normNum = meta.seriesNumber ? normalizeSeriesNumber(meta.seriesNumber) : '';
  const normTitle = meta.title ? normalizeTextKey(meta.title) : '';

  if (normSeries && normNum) return `series:${normSeries}#${normNum}`;
  if (normTitle && normNum) return `title:${normTitle}#${normNum}`;
  if (normTitle) return `title:${normTitle}`;
  return '';
}

function hasTextTokenOverlap(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const normA = normalizeTextKey(a);
  const normB = normalizeTextKey(b);
  if (!normA || !normB) return false;
  if (normA.includes(normB) || normB.includes(normA)) return true;

  const tokensA = normA.split(/\s+/).filter((t) => t.length >= 3);
  const tokensB = new Set(normB.split(/\s+/).filter((t) => t.length >= 3));
  return tokensA.some((t) => tokensB.has(t));
}

function detectAiCorrection(
  cand: RecognizedBookCandidate,
  resolvedTitle: string,
  resolvedAuthors: string[]
): boolean {
  const aiAuthor = cand.author?.trim();
  if (aiAuthor && resolvedAuthors.length > 0) {
    const joinedResolved = resolvedAuthors.join(' ');
    if (!hasTextTokenOverlap(aiAuthor, joinedResolved)) {
      return true;
    }
  }

  const aiTitle = cand.title?.trim();
  if (aiTitle && resolvedTitle) {
    const normAi = normalizeTextKey(aiTitle);
    const normRes = normalizeTextKey(resolvedTitle);
    if (normAi.length >= 4 && normRes.length >= 4 && !hasTextTokenOverlap(normAi, normRes)) {
      return true;
    }
  }

  return false;
}

async function discoverConsensusByHints(hints: BnfHintQuery): Promise<{
  isbn13?: string;
  meta?: ExternalBookMetadata;
  sourcesCount: number;
}> {
  const [bnfMatches, gbMatches, olMatches] = await Promise.all([
    bnfResolver.searchCandidatesByHints(hints, 12).catch(() => []),
    googleBooksResolver.searchCandidatesByHints(hints, 8).catch(() => []),
    openLibraryResolver.searchCandidatesByHints(hints, 8).catch(() => [])
  ]);

  const buckets = new Map<string, ConsensusBucket>();
  const workKeySources = new Map<string, Set<DiscoverySource>>();

  const addCandidate = (
    source: DiscoverySource,
    meta: ExternalBookMetadata,
    precomputedScore?: number
  ): void => {
    const normIsbn = normalizeToIsbn13(meta.isbn);
    if (!normIsbn) return;

    const score = typeof precomputedScore === 'number' ? precomputedScore : scoreHintMatch(meta, hints);
    const workKey = computeWorkKey(meta);

    if (workKey) {
      const wkSet = workKeySources.get(workKey) || new Set<DiscoverySource>();
      wkSet.add(source);
      workKeySources.set(workKey, wkSet);
    }

    const existing = buckets.get(normIsbn);
    if (!existing) {
      buckets.set(normIsbn, {
        isbn13: normIsbn,
        bestScore: score,
        sources: new Set([source]),
        workKey,
        bestMeta: { ...meta, isbn: normIsbn },
        fromBnf: source === 'bnf'
      });
      return;
    }

    existing.sources.add(source);
    if (source === 'bnf') {
      existing.fromBnf = true;
    }
    if (score > existing.bestScore || (source === 'bnf' && !existing.fromBnf)) {
      existing.bestScore = Math.max(existing.bestScore, score);
      existing.bestMeta = {
        ...existing.bestMeta,
        ...meta,
        isbn: normIsbn,
        coverUrl: meta.coverUrl || existing.bestMeta.coverUrl
      };
    }
    if (!existing.workKey && workKey) {
      existing.workKey = workKey;
    }
  };

  for (const entry of bnfMatches) {
    addCandidate('bnf', entry.meta, entry.score);
  }
  for (const meta of gbMatches) {
    addCandidate('google', meta);
  }
  for (const meta of olMatches) {
    addCandidate('openlibrary', meta);
  }

  let winner: ConsensusBucket | null = null;
  let winnerFinalScore = -Infinity;
  let winnerSourcesCount = 0;

  for (const bucket of buckets.values()) {
    const wkSourceCount = bucket.workKey ? (workKeySources.get(bucket.workKey)?.size ?? 1) : 1;
    const effectiveSources = Math.max(bucket.sources.size, wkSourceCount);
    const isbnConsensusBonus = Math.max(0, bucket.sources.size - 1) * MULTI_SOURCE_ISBN_BONUS;
    const workConsensusBonus = Math.max(0, wkSourceCount - bucket.sources.size) * MULTI_SOURCE_WORK_BONUS;
    const tieBreak = bucket.fromBnf ? BNF_AUTHORITY_TIEBREAK : 0;
    const finalScore = bucket.bestScore + isbnConsensusBonus + workConsensusBonus + tieBreak;

    if (finalScore > winnerFinalScore) {
      winnerFinalScore = finalScore;
      winner = bucket;
      winnerSourcesCount = effectiveSources;
    }
  }

  if (!winner || winnerFinalScore < CONSENSUS_SCORE_THRESHOLD) {
    return { sourcesCount: 0 };
  }

  return {
    isbn13: winner.isbn13,
    meta: winner.bestMeta,
    sourcesCount: winnerSourcesCount
  };
}

function findMatchingNeighborSeries(
  cand: RecognizedBookCandidate,
  fallbackIndex: number,
  neighbors: ShelfSeriesNeighbor[]
): ShelfSeriesNeighbor | null {
  if (neighbors.length === 0) return null;
  const itemSpineIdx = typeof cand.spineIndex === 'number' ? cand.spineIndex : fallbackIndex;
  const searchBlob = [cand.rawSpineText, cand.series, cand.title, cand.publisher].filter(Boolean).join(' ');

  let bestNeighbor: ShelfSeriesNeighbor | null = null;
  let bestRank = -1;

  for (const neighbor of neighbors) {
    const distance = Math.abs(itemSpineIdx - neighbor.spineIndex);
    const seriesOverlap = hasTextTokenOverlap(searchBlob, neighbor.series);
    const publisherOverlap =
      Boolean(cand.publisher && neighbor.publisher) && hasTextTokenOverlap(cand.publisher, neighbor.publisher);
    const isAdjacentWithVolOrPub = distance <= 2 && (Boolean(cand.volumeNumber) || publisherOverlap);

    if (!seriesOverlap && !isAdjacentWithVolOrPub) continue;

    // Priorise la correspondance textuelle de série puis la proximité physique sur l'étagère
    const rank = (seriesOverlap ? 100 : 0) + (publisherOverlap ? 20 : 0) + Math.max(0, 10 - distance);
    if (rank > bestRank) {
      bestRank = rank;
      bestNeighbor = neighbor;
    }
  }

  return bestNeighbor;
}

export const photoBookResolutionService = {
  /**
   * Prend un candidat issu de l'IA (tranche par tranche : titre, sous-titre, série, tome,
   * auteur, illustrateur, éditeur, collection, rawSpineText, ou ISBN), lance une recherche
   * croisée parallèle (BnF + Google Books + Open Library) avec consensus multi-sources,
   * puis exécute le flux classique complet par ISBN (BnF + Open Library + Google Books + D1).
   */
  async resolveSingleCandidate(cand: RecognizedBookCandidate, idPrefix = 'det'): Promise<ResolvedPhotoItem> {
    const uid = `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    try {
      // 1. Retrouver un ISBN-13 officiel par consensus multi-sources à partir des indices visuels (si absent)
      let isbn13 = normalizeToIsbn13(cand.isbn);
      let hintMatchMeta: ExternalBookMetadata | undefined;
      let sourcesCount = isbn13 ? 1 : 0;

      if (!isbn13) {
        const consensus = await discoverConsensusByHints(buildHintQuery(cand));
        isbn13 = consensus.isbn13;
        hintMatchMeta = consensus.meta;
        sourcesCount = consensus.sourcesCount;
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
          title: cand.title || cand.rawSpineText || 'Livre non identifié',
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

      const correctedFromAi = detectAiCorrection(cand, mergedTitle, mergedAuthors);

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
        existingWorkUri: ownership.existingWorkUri || d1Entity?.workUri,
        correctedFromAi,
        sourcesCount
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
        title: cand.title || cand.rawSpineText || 'Livre non identifié',
        authors: cand.author ? [cand.author] : [],
        publisher: cand.publisher,
        series: cand.series,
        seriesNumber: cand.volumeNumber,
        failureReason: err instanceof Error ? err.message : 'Erreur lors de la recherche BnF.'
      };
    }
  },

  /**
   * Résout l'ensemble des livres détectés sur la photo via le flux croisé multi-sources + ISBN,
   * applique un rattrapage par voisinage de série sur la même étagère pour les tranches ambiguës,
   * puis active la découverte des autres tomes de chaque série détectée pour les proposer
   * dans la liste finale de validation.
   */
  async resolveCandidatesAndDiscoverSeries(
    candidates: RecognizedBookCandidate[],
    onStatus?: (msg: string) => void
  ): Promise<PhotoBatchResolutionResult> {
    let completed = 0;
    onStatus?.(`Identification multi-sources & BnF (0/${candidates.length})...`);

    const resolvedRaw = await runWithConcurrency(candidates, 3, async (cand, idx) => {
      const item = await this.resolveSingleCandidate(cand, `det-${idx}`);
      completed++;
      onStatus?.(`Identification multi-sources & BnF (${completed}/${candidates.length})...`);
      return item;
    });

    // Rattrapage intra-étagère : si une tranche est non identifiée mais voisine d'une série résolue
    const shelfNeighbors: ShelfSeriesNeighbor[] = [];
    for (let idx = 0; idx < resolvedRaw.length; idx++) {
      const item = resolvedRaw[idx];
      if (item.status === 'resolved' && item.series?.trim()) {
        shelfNeighbors.push({
          spineIndex: typeof item.rawCandidate.spineIndex === 'number' ? item.rawCandidate.spineIndex : idx,
          series: item.series.trim(),
          author: item.authors[0],
          publisher: item.publisher
        });
      }
    }

    const unresolvedIndices = resolvedRaw
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => item.status === 'unresolved');

    if (unresolvedIndices.length > 0 && shelfNeighbors.length > 0) {
      await runWithConcurrency(unresolvedIndices, 3, async ({ item, idx }) => {
        const neighbor = findMatchingNeighborSeries(item.rawCandidate, idx, shelfNeighbors);
        if (!neighbor) return;

        onStatus?.(`Rattrapage par série voisine « ${neighbor.series} »...`);
        const rescuedCand: RecognizedBookCandidate = {
          ...item.rawCandidate,
          series: item.rawCandidate.series || neighbor.series,
          author: neighbor.author || item.rawCandidate.author,
          publisher: item.rawCandidate.publisher || neighbor.publisher
        };

        const rescuedItem = await this.resolveSingleCandidate(rescuedCand, `rescue-${idx}`);
        if (rescuedItem.status === 'resolved') {
          resolvedRaw[idx] = {
            ...rescuedItem,
            rawCandidate: item.rawCandidate,
            correctedFromAi: true
          };
        }
      });
    }

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
