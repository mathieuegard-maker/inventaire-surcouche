// src/core/services/v4-client.service.ts
// Client Front-End unifié pour dialoguer avec le pipeline Backend V4 (/api/v2/books/ingest et /api/v2/books/search-local)
// tout en synchronisant IndexedDB et en affichant les statuts bidirectionnels d'Intégrales.

import { connectionState, fetchWithTimeout } from '../../state/connection';
import { databaseService } from '../database/database.service';
import { sessionStore } from '../../state/session';
import type { HumanizedBook, ParentIntegralRef } from '../types';
import { imageUtil } from '../utils/image.util';
import type {
  IngestBatchResult,
  IngestSingleResult,
  Layer2Status,
  SourceChannel,
  V4BookRecord
} from './v4-pipeline.service';

export function v4BookRecordToHumanizedBook(
  rec: V4BookRecord,
  ownershipStatus: 'owned' | 'wish' | 'none' = 'none'
): HumanizedBook {
  const primaryIsbn = rec.knownIsbns?.[0] || rec.editionsCatalog?.[0]?.isbn13;
  const editionMeta = rec.editionsCatalog?.[0];
  const fallbackCovers = imageUtil.buildCoverCandidates(primaryIsbn, [
    rec.selectedCoverUrl || undefined,
    ...(rec.editionsCatalog || []).map((e) => e.coverUrl)
  ]);
  const uri = rec.legacyEntityUri || (primaryIsbn ? `isbn:${primaryIsbn}` : `book:${rec.id}`);

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
    seriesNumber: rec.volumeLabel || undefined,
    genres: [rec.mainCategory, ...(rec.subgenres || [])].filter((g) => g && g !== 'Autre'),
    coverUrl: rec.selectedCoverUrl || fallbackCovers[0],
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

  if (!book.isIntegral && Array.isArray(book.parentIntegrals) && book.parentIntegrals.length > 0) {
    for (const ref of book.parentIntegrals) {
      const hasOwnedIntegral = ownedBooks.some(
        (ob) => ob.bookId === ref.integralBookId || (ref.isbn13 && ob.knownIsbns?.includes(ref.isbn13))
      );
      if (hasOwnedIntegral) ownedIntegralMatches.push(ref);
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
    const targetVols = new Set(book.integralMetadata.includedVolumeNumbers || []);
    for (const ob of ownedBooks) {
      const idMatch = ob.bookId && targetIds.has(ob.bookId);
      const volMatch =
        book.seriesId &&
        ob.seriesId === book.seriesId &&
        ob.seriesNumber &&
        targetVols.has(ob.seriesNumber);
      if (idMatch || volMatch) {
        includedOwnedWorkIds.push(ob.bookId || ob.uri);
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

export async function ingestIsbnsViaV4(params: {
  isbns: string[];
  sourceChannel: SourceChannel;
  action?: 'owned' | 'wishlist' | 'preview';
  traceId?: string;
  chunkSize?: number;
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
      const res = await fetchWithTimeout('/api/v2/books/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 24000,
        body: JSON.stringify({
          isbns: slice,
          source_channel: params.sourceChannel,
          action: params.action || 'preview',
          userUri: savedUri,
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

      // Synchroniser immédiatement chaque livre consolidé dans IndexedDB
      for (const r of data.results) {
        if (!r.book) continue;
        const targetStatus: 'owned' | 'wish' | 'none' =
          params.action === 'owned' || r.layer2Status === 'ALREADY_OWNED'
            ? 'owned'
            : params.action === 'wishlist'
              ? 'wish'
              : 'none';
        const humanized = v4BookRecordToHumanizedBook(r.book, targetStatus);
        if (typeof databaseService.saveBookToCache === 'function') {
          await databaseService.saveBookToCache(humanized).catch(() => {});
        } else if (typeof databaseService.indexBookIsbns === 'function') {
          await databaseService.indexBookIsbns(humanized).catch(() => {});
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
