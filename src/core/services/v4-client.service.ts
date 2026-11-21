// src/core/services/v4-client.service.ts
// Client Front-End unifié pour dialoguer avec le pipeline Backend V4 (/api/v2/books/ingest et /api/v2/books/search-local)
// tout en synchronisant IndexedDB et en affichant les statuts bidirectionnels d'Intégrales.

import { connectionState, fetchWithTimeout } from '../../state/connection';
import { databaseService } from '../database/database.service';
import { sessionStore } from '../../state/session';
import type { HumanizedBook, ParentIntegralRef } from '../types';
import { imageUtil } from '../utils/image.util';
import { normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import type {
  IngestBatchResult,
  IngestSingleResult,
  Layer2Status,
  SourceChannel,
  UserIngestHint,
  V4BookRecord,
  V4SeriesBooksResponse,
  V4SyncResponse
} from './v4-pipeline.service';
import type { Canal3ResolveResponse } from './canal3-resolver.service';
import type { BnfHintQuery } from '../resolvers/bnf.resolver';

export function v4BookRecordToHumanizedBook(
  rec: V4BookRecord,
  ownershipStatus: 'owned' | 'wish' | 'none' = 'none'
): HumanizedBook {
  const primaryIsbn = rec.knownIsbns?.[0] || rec.editionsCatalog?.[0]?.isbn13;
  const editionMeta =
    rec.editionsCatalog?.find((e) => e.isbn13 === primaryIsbn) || rec.editionsCatalog?.[0];
  const fallbackCovers = imageUtil.buildCoverCandidates(primaryIsbn, [
    rec.selectedCoverUrl || undefined,
    editionMeta?.coverUrl,
    ...(rec.editionsCatalog || []).map((e) => e.coverUrl)
  ]);
  const uri = rec.legacyEntityUri || (primaryIsbn ? `isbn:${primaryIsbn}` : `book:${rec.id}`);

  const seriesNumberDisplay = rec.isIntegral
    ? rec.integralMetadata?.includedVolumeNumbers?.length >= 2
      ? `Int. T.${rec.integralMetadata.includedVolumeNumbers[0]}-${rec.integralMetadata.includedVolumeNumbers[rec.integralMetadata.includedVolumeNumbers.length - 1]}`
      : rec.volumeLabel || 'Intégrale'
    : rec.volumeLabel || undefined;

  return {
    uri,
    bookId: rec.id,
    type: 'edition',
    isbn13: primaryIsbn,
    knownIsbns: rec.knownIsbns || [],
    editionsCatalog: rec.editionsCatalog || [],
    isHorsSerie: Boolean(rec.isHorsSerie),
    horsSerieLabel: rec.horsSerieLabel || undefined,
    isIntegral: Boolean(rec.isIntegral),
    integralMetadata: rec.integralMetadata,
    parentIntegrals: rec.parentIntegrals || [],
    title: rec.canonicalTitle,
    authors: rec.authors?.length ? rec.authors : ['Auteur inconnu'],
    illustrators: [],
    scriptwriters: [],
    publisher: editionMeta?.publisher,
    publishDate: editionMeta?.publicationYear,
    series: rec.seriesName || undefined,
    seriesId: rec.seriesId || undefined,
    seriesNumber: seriesNumberDisplay,
    ...(rec.hiddenSeriesIds?.length ? { hiddenSeriesIds: rec.hiddenSeriesIds } : {}),
    genres: [rec.mainCategory, ...(rec.subgenres || [])].filter((g) => g && g !== 'Autre'),
    coverUrl: rec.selectedCoverUrl || fallbackCovers[0],
    ...(rec.selectedCoverUrl?.startsWith('data:image/') ? { localCover: rec.selectedCoverUrl } : {}),
    coverFallbackUrls: fallbackCovers,
    ownershipStatus,
    updatedAt: Date.now()
  };
}

export function formatV4StatusNotice(res: IngestSingleResult): string | undefined {
  const title = res.book?.canonicalTitle || res.normalizedIsbn13 || res.inputIsbn;
  if (res.layer2Status === 'ALREADY_OWNED') {
    return `« ${title} » est déjà dans votre collection.`;
  }
  if (res.layer2Status === 'INCLUDED_IN_INTEGRAL') {
    const names = (res.ownedIntegralMatches || []).map((m) => m.title).filter(Boolean).join(', ');
    return names
      ? `« ${title} » est déjà inclus dans l'intégrale que vous possédez (${names}).`
      : `« ${title} » est déjà couvert par une intégrale de votre collection.`;
  }
  if (res.layer2Status === 'PARTIAL_INTEGRAL_OWNED') {
    const count = res.includedOwnedWorkIds?.length || 0;
    return `Intégrale « ${title} » partiellement possédée : ${count} tome(s) individuel(s) sont déjà dans votre collection.`;
  }
  if (res.layer2Status === 'FULL_INTEGRAL_OWNED') {
    return `Vous possédez déjà l'ensemble des tomes contenus dans l'intégrale « ${title} ».`;
  }
  return undefined;
}

export function checkLocalIntegralConflict(
  book: HumanizedBook,
  allCached: HumanizedBook[]
): {
  status?: Layer2Status;
  ownedIntegralMatches: ParentIntegralRef[];
  includedOwnedWorkIds: string[];
  notice?: string;
} {
  const ownedBooks = allCached.filter((b) => b.ownershipStatus === 'owned');
  const ownedIntegralMatches: ParentIntegralRef[] = [];
  const includedOwnedWorkIds: string[] = [];

  if (!book.isIntegral) {
    // 1. Lien explicite `parentIntegrals` renseigné par le serveur V4
    if (Array.isArray(book.parentIntegrals) && book.parentIntegrals.length > 0) {
      for (const ref of book.parentIntegrals) {
        const hasOwnedIntegral = ownedBooks.some(
          (ob) => ob.bookId === ref.integralBookId || (ref.isbn13 && (ob.isbn13 === ref.isbn13 || ob.knownIsbns?.includes(ref.isbn13)))
        );
        if (hasOwnedIntegral && !ownedIntegralMatches.some((m) => m.integralBookId === ref.integralBookId)) {
          ownedIntegralMatches.push(ref);
        }
      }
    }

    // 2. Recoupement direct via les intégrales possédées de la même série (par numéro de tome inclus, bookId ou ISBN)
    const normBookVol = book.seriesNumber ? normalizeSeriesNumber(book.seriesNumber) : '';
    const normBookSeries = book.series ? normalizeTextKey(book.series) : '';
    const bookIsbns = new Set([book.isbn13, ...(book.knownIsbns || [])].filter(Boolean) as string[]);

    for (const ob of ownedBooks) {
      if (!ob.isIntegral || !ob.integralMetadata) continue;
      const meta = ob.integralMetadata;
      const sameSeries =
        (book.seriesId && ob.seriesId && book.seriesId === ob.seriesId) ||
        (normBookSeries && ob.series && normalizeTextKey(ob.series) === normBookSeries);
      const volCovered =
        Boolean(sameSeries && normBookVol) &&
        (meta.includedVolumeNumbers || []).some((v) => normalizeSeriesNumber(String(v)) === normBookVol);
      const idCovered = Boolean(book.bookId && (meta.includedWorkIds || []).includes(book.bookId));
      const isbnCovered = (meta.includedIsbns || []).some((i) => bookIsbns.has(i));

      if (volCovered || idCovered || isbnCovered) {
        const intId = ob.bookId || ob.uri;
        if (!ownedIntegralMatches.some((m) => m.integralBookId === intId)) {
          ownedIntegralMatches.push({
            integralBookId: intId,
            title: ob.title,
            isbn13: ob.isbn13 || ''
          });
        }
      }
    }

    if (ownedIntegralMatches.length > 0) {
      return {
        status: 'INCLUDED_IN_INTEGRAL',
        ownedIntegralMatches,
        includedOwnedWorkIds,
        notice: `« ${book.title} » est déjà inclus dans votre intégrale (${ownedIntegralMatches[0].title}).`
      };
    }
  }

  if (book.isIntegral && book.integralMetadata) {
    const targetIds = new Set(book.integralMetadata.includedWorkIds || []);
    const targetVols = new Set(
      (book.integralMetadata.includedVolumeNumbers || [])
        .map((v) => normalizeSeriesNumber(String(v)))
        .filter(Boolean)
    );
    const normBookSeries = book.series ? normalizeTextKey(book.series) : '';
    const seenWorkKeys = new Set<string>();
    for (const ob of ownedBooks) {
      if (ob.isIntegral) continue;
      const idMatch = Boolean(ob.bookId && targetIds.has(ob.bookId));
      const sameSeries =
        (book.seriesId && ob.seriesId && ob.seriesId === book.seriesId) ||
        (normBookSeries && ob.series && normalizeTextKey(ob.series) === normBookSeries);
      const obVol = ob.seriesNumber ? normalizeSeriesNumber(ob.seriesNumber) : '';
      const volMatch = Boolean(sameSeries && obVol && targetVols.has(obVol));
      if (idMatch || volMatch) {
        const key = ob.bookId || ob.uri;
        if (!seenWorkKeys.has(key)) {
          seenWorkKeys.add(key);
          includedOwnedWorkIds.push(key);
        }
      }
    }
    if (includedOwnedWorkIds.length > 0) {
      const total = Math.max(targetIds.size, targetVols.size);
      const status: Layer2Status =
        total > 0 && includedOwnedWorkIds.length >= total ? 'FULL_INTEGRAL_OWNED' : 'PARTIAL_INTEGRAL_OWNED';
      return {
        status,
        ownedIntegralMatches,
        includedOwnedWorkIds,
        notice:
          status === 'FULL_INTEGRAL_OWNED'
            ? `Vous possédez déjà tous les tomes inclus dans « ${book.title} ».`
            : `Vous possédez déjà ${includedOwnedWorkIds.length} tome(s) inclus dans l'intégrale « ${book.title} ».`
      };
    }
  }

  return { ownedIntegralMatches, includedOwnedWorkIds };
}

export async function pushClientPipelineLogs(params: {
  traceId?: string;
  sourceChannel: SourceChannel;
  steps: Array<{
    layer: 'C1' | 'C2' | 'C3';
    stepName: string;
    status: 'ok' | 'warn' | 'error';
    summary: string;
    payload?: unknown;
    durationMs?: number;
  }>;
}): Promise<void> {
  if (connectionState.isOffline.value || typeof fetch !== 'function' || !params.steps.length) return;
  try {
    const savedUri = sessionStore.getUserUri() || undefined;
    await fetchWithTimeout('/api/v2/logs/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 6000,
      body: JSON.stringify({
        traceId: params.traceId,
        sourceChannel: params.sourceChannel,
        userUri: savedUri,
        steps: params.steps
      })
    }).catch(() => {});
  } catch {
    // Non-bloquant
  }
}

async function saveV4BookPreservingLocalCover(humanized: HumanizedBook): Promise<void> {
  if (typeof databaseService.saveBookToCache !== 'function') {
    if (typeof databaseService.indexBookIsbns === 'function') {
      await databaseService.indexBookIsbns(humanized).catch(() => {});
    }
    return;
  }
  const existing =
    typeof databaseService.getBookFromCache === 'function'
      ? await databaseService.getBookFromCache(humanized.uri).catch(() => undefined)
      : undefined;
  if (existing) {
    if (existing.localCover && (!humanized.coverUrl || existing.coverUrl === humanized.coverUrl)) {
      humanized.localCover = existing.localCover;
    }
    if (existing.loan && humanized.ownershipStatus === 'owned') {
      humanized.loan = existing.loan;
    }
  }
  await databaseService.saveBookToCache(humanized).catch(() => {});
}

export async function ingestIsbnsViaV4(params: {
  isbns: string[];
  sourceChannel: SourceChannel;
  action?: 'owned' | 'wishlist' | 'preview';
  traceId?: string;
  chunkSize?: number;
  hints?: Record<string, UserIngestHint>;
  onProgress?: (processed: number, total: number) => void;
}): Promise<IngestBatchResult | null> {
  if (connectionState.isOffline.value || typeof fetch !== 'function') return null;
  const uniqueIsbns = Array.from(new Set(params.isbns.map((s) => String(s || '').trim()).filter(Boolean)));
  if (!uniqueIsbns.length) return null;

  // Micro-lots de 2 ISBNs maximum par appel HTTP pour rester sous la limite de 50 sous-requêtes Cloudflare
  // et garantir que 100 % des livres passent par Couche 3 -> Couche 4 (0 bascule V2 legacy).
  const step = Math.min(3, Math.max(1, Math.trunc(params.chunkSize || 2)));
  const savedUri = sessionStore.getUserUri() || undefined;
  const allResults: IngestSingleResult[] = [];
  let effectiveTraceId = params.traceId || '';
  let anyNetworkSuccess = false;

  try {
    for (let i = 0; i < uniqueIsbns.length; i += step) {
      const slice = uniqueIsbns.slice(i, i + step);
      const sliceHints: Record<string, UserIngestHint> = {};
      if (params.hints) {
        for (const k of slice) {
          if (params.hints[k]) sliceHints[k] = params.hints[k];
        }
      }
      const res = await fetchWithTimeout('/api/v2/books/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 24000,
        body: JSON.stringify({
          isbns: slice,
          source_channel: params.sourceChannel,
          action: params.action || 'preview',
          userUri: savedUri,
          ...(Object.keys(sliceHints).length > 0 ? { hints: sliceHints } : {}),
          ...(effectiveTraceId ? { traceId: effectiveTraceId } : {})
        })
      });

      if (!res?.ok) {
        if (i === 0) return null;
        continue;
      }
      const data = (await res.json()) as IngestBatchResult;
      if (!data || !Array.isArray(data.results)) {
        if (i === 0) return null;
        continue;
      }
      anyNetworkSuccess = true;
      if (!effectiveTraceId && data.traceId) effectiveTraceId = data.traceId;
      allResults.push(...data.results);
      params.onProgress?.(Math.min(uniqueIsbns.length, i + slice.length), uniqueIsbns.length);

      // Synchroniser immédiatement chaque livre consolidé dans IndexedDB (cache_books + registres inventory/wishlist)
      for (const r of data.results) {
        if (!r.book) continue;
        const isDirectlyOwned =
          params.action === 'owned' || r.layer2Status === 'ALREADY_OWNED';
        const targetStatus: 'owned' | 'wish' | 'none' = isDirectlyOwned
          ? 'owned'
          : params.action === 'wishlist'
            ? 'wish'
            : 'none';
        const humanized = v4BookRecordToHumanizedBook(r.book, targetStatus);
        await saveV4BookPreservingLocalCover(humanized);
        if (typeof databaseService.addRegistryEntry === 'function') {
          if (targetStatus === 'owned') {
            await databaseService.addRegistryEntry('inventory', humanized.uri).catch(() => {});
            await databaseService.removeRegistryEntry?.('wishlist', humanized.uri).catch(() => {});
          } else if (targetStatus === 'wish') {
            await databaseService.addRegistryEntry('wishlist', humanized.uri).catch(() => {});
          }
        }
      }
    }

    return anyNetworkSuccess
      ? {
          traceId: effectiveTraceId || '',
          sourceChannel: params.sourceChannel,
          results: allResults
        }
      : null;
  } catch {
    return anyNetworkSuccess
      ? {
          traceId: effectiveTraceId || '',
          sourceChannel: params.sourceChannel,
          results: allResults
        }
      : null;
  }
}

const V4_LAST_SYNC_KEY = 'biblio_v4_last_sync_at';

/**
 * Appelle le service Back-End utilitaire Canal 3 (`POST /api/v2/books/resolve-hints`).
 * Retourne `null` si hors-ligne ou si l'endpoint n'est pas joignable (permettant le repli client).
 */
export async function resolveHintsViaV4Backend(params: {
  hints: BnfHintQuery;
  aiConfidence?: 'high' | 'medium' | 'low';
  sourceChannel?: SourceChannel;
  skipLocalD1?: boolean;
}): Promise<Canal3ResolveResponse | null> {
  if (connectionState.isOffline.value || typeof fetch !== 'function') return null;
  try {
    const savedUri = sessionStore.getUserUri() || undefined;
    const res = await fetchWithTimeout('/api/v2/books/resolve-hints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 16000,
      body: JSON.stringify({
        hints: params.hints,
        aiConfidence: params.aiConfidence,
        source_channel: params.sourceChannel || 'canal_4_ai_photo',
        userUri: savedUri,
        skipLocalD1: params.skipLocalD1
      })
    });
    if (!res?.ok) return null;
    const data = (await res.json()) as Canal3ResolveResponse;
    if (!data || typeof data !== 'object' || !Array.isArray(data.alternatives)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Synchronisation différentielle V4 pure (`GET /api/v2/books/sync`) :
 * hydrate IndexedDB (`cache_books`, `book_isbn_index`, registres `inventory`/`wishlist`)
 * directement depuis les tables V4 (`books`, `v4_library_books`).
 */
export async function syncV4BooksToIndexedDb(forceFull = false): Promise<{ syncedCount: number } | null> {
  if (connectionState.isOffline.value || typeof fetch !== 'function') return null;
  try {
    const savedUri = sessionStore.getUserUri() || undefined;
    const lastSync =
      !forceFull && typeof localStorage !== 'undefined' ? localStorage.getItem(V4_LAST_SYNC_KEY) : null;
    const qs = new URLSearchParams();
    if (lastSync) qs.set('since', lastSync);
    if (savedUri) qs.set('userUri', savedUri);

    const res = await fetchWithTimeout(`/api/v2/books/sync${qs.toString() ? `?${qs.toString()}` : ''}`, {
      timeout: 12000
    });
    if (!res?.ok) return null;
    const data = (await res.json()) as V4SyncResponse;
    if (!data || !Array.isArray(data.books)) return null;

    let syncedCount = 0;
    for (const item of data.books) {
      if (!item?.book) continue;
      const humanized = v4BookRecordToHumanizedBook(item.book, item.ownershipStatus);
      await saveV4BookPreservingLocalCover(humanized);
      if (item.ownershipStatus === 'owned') {
        await databaseService.addRegistryEntry('inventory', humanized.uri).catch(() => {});
        await databaseService.removeRegistryEntry?.('wishlist', humanized.uri).catch(() => {});
      } else if (item.ownershipStatus === 'wish') {
        await databaseService.addRegistryEntry('wishlist', humanized.uri).catch(() => {});
        await databaseService.removeRegistryEntry?.('inventory', humanized.uri).catch(() => {});
      } else {
        await databaseService.removeRegistryEntry?.('inventory', humanized.uri).catch(() => {});
        await databaseService.removeRegistryEntry?.('wishlist', humanized.uri).catch(() => {});
      }
      syncedCount++;
    }

    if (data.serverTime && typeof localStorage !== 'undefined') {
      localStorage.setItem(V4_LAST_SYNC_KEY, data.serverTime);
    }
    return { syncedCount };
  } catch {
    return null;
  }
}

/**
 * Hydrate directement tous les tomes V4 consolidés d'une série (`GET /api/v2/books/series/:seriesId`)
 * dans IndexedDB sans passer par l'ancien endpoint V2 `series-list`.
 */
export async function fetchV4SeriesBooksToIndexedDb(seriesId: string): Promise<{ count: number } | null> {
  if (!seriesId || connectionState.isOffline.value || typeof fetch !== 'function') return null;
  try {
    const savedUri = sessionStore.getUserUri() || undefined;
    const qs = savedUri ? `?userUri=${encodeURIComponent(savedUri)}` : '';
    const res = await fetchWithTimeout(`/api/v2/books/series/${encodeURIComponent(seriesId)}${qs}`, {
      timeout: 10000
    });
    if (!res?.ok) return null;
    const data = (await res.json()) as V4SeriesBooksResponse;
    if (!data || !Array.isArray(data.books)) return null;

    for (const item of data.books) {
      if (!item?.book) continue;
      const humanized = v4BookRecordToHumanizedBook(item.book, item.ownershipStatus);
      await saveV4BookPreservingLocalCover(humanized);
      if (item.ownershipStatus === 'owned') {
        await databaseService.addRegistryEntry('inventory', humanized.uri).catch(() => {});
        await databaseService.removeRegistryEntry?.('wishlist', humanized.uri).catch(() => {});
      } else if (item.ownershipStatus === 'wish') {
        await databaseService.addRegistryEntry('wishlist', humanized.uri).catch(() => {});
        await databaseService.removeRegistryEntry?.('inventory', humanized.uri).catch(() => {});
      } else {
        await databaseService.removeRegistryEntry?.('inventory', humanized.uri).catch(() => {});
        await databaseService.removeRegistryEntry?.('wishlist', humanized.uri).catch(() => {});
      }
    }
    return { count: data.books.length };
  } catch {
    return null;
  }
}

/**
 * Persiste une édition manuelle (`BookEdit.vue`) directement dans les tables V4 (`books` + `v4_library_books`)
 * afin qu'elle ne soit jamais écrasée par les synchronisations V4 suivantes.
 */
export async function patchV4BookMetadata(params: {
  bookId?: string;
  uri?: string;
  isbn13?: string;
  title?: string;
  authors?: string[];
  series?: string;
  seriesId?: string | null;
  seriesNumber?: string;
  publisher?: string;
  publishDate?: string;
  coverUrl?: string;
  genres?: string[];
}): Promise<V4BookRecord | null> {
  if (connectionState.isOffline.value || typeof fetch !== 'function') return null;
  try {
    const savedUri = sessionStore.getUserUri() || undefined;
    const res = await fetchWithTimeout('/api/v2/books/update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      timeout: 12000,
      body: JSON.stringify({
        ...params,
        userUri: savedUri
      })
    });
    if (!res?.ok) return null;
    const data = (await res.json()) as { ok?: boolean; book?: V4BookRecord | null };
    return data?.book || null;
  } catch {
    return null;
  }
}

/**
 * Option B : Exclut / masque un tome d'une série uniquement pour le foyer connecté (`v4_library_books`),
 * et met à jour le cache local IndexedDB pour disparition immédiate de la vue Série.
 */
export async function excludeBookFromSeriesViaV4(params: {
  seriesId: string;
  bookId?: string;
  uri?: string;
  isbn13?: string;
  detachOwned?: boolean;
}): Promise<V4BookRecord | null> {
  if (connectionState.isOffline.value || typeof fetch !== 'function') return null;
  try {
    const savedUri = sessionStore.getUserUri() || undefined;
    const res = await fetchWithTimeout('/api/v2/books/exclude-from-series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 12000,
      body: JSON.stringify({
        ...params,
        userUri: savedUri
      })
    });
    if (!res?.ok) return null;
    const data = (await res.json()) as { ok?: boolean; book?: V4BookRecord | null };
    return data?.book || null;
  } catch {
    return null;
  }
}
