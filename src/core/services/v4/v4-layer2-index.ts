// src/core/services/v4/v4-layer2-index.ts
// Couche 2 V4 : Recherche locale D1 (Canal 3 Passe 1) et indexation O(1) + détection conflits d'intégrales.

import type { DatabaseBinding } from '../../adapters/storage-db.interface';
import type { ParentIntegralRef } from '../../types';
import { normalizeSeriesNumber, normalizeTextKey } from '../../resolvers/bnf.resolver';
import { stripEditorialCollectionSuffixes } from '../../utils/series-matcher.util';
import { getLevenshteinDistance } from '../../utils/string.util';
import { PipelineTracer } from '../pipeline-logger.service';
import {
  applyLibraryOverridesToBook,
  mapBookRow,
  parseIntegralMetadataDb,
  safeJsonParse,
  type Layer2CheckResult,
  type Layer2Status,
  type UserIngestHint
} from './v4-shared';

// ============================================================================
// CANAL 3 : RECHERCHE LOCALE SERVEUR (D1 `books`) AVANT API EXTERNES
// ============================================================================

export interface LocalSearchHit {
  bookId: string;
  isbn13: string;
  title: string;
  seriesName?: string;
  volumeNumber?: number | null;
  authors: string[];
  coverUrl?: string;
  score: number;
  source: 'server_d1';
}

const CANAL3_STOP_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'ou', 'au', 'aux',
  'en', 'dans', 'sur', 'par', 'pour', 'avec', 'the', 'of', 'and', 'tome', 'vol', 'volume'
]);

export async function searchLocalBooksForCanal3(
  db: DatabaseBinding,
  params: {
    q?: string;
    title?: string;
    author?: string;
    series?: string;
    volumeNumber?: string;
    limit?: number;
  }
): Promise<LocalSearchHit[]> {
  const limit = Math.min(25, Math.max(1, Math.trunc(params.limit || 10)));
  const qNorm = normalizeTextKey(params.q || params.title || params.series || '');
  const titleNorm = normalizeTextKey(params.title || '');
  const seriesNorm = normalizeTextKey(params.series || '');
  const authorNorm = normalizeTextKey(params.author || '');
  const volNum = params.volumeNumber ? parseInt(normalizeSeriesNumber(params.volumeNumber), 10) : NaN;

  if (!qNorm && !titleNorm && !seriesNorm && !authorNorm) return [];

  const rawTokens = Array.from(
    new Set(
      `${qNorm} ${titleNorm} ${seriesNorm}`
        .split(/\s+/)
        .filter((t) => t.length >= 2)
    )
  );
  const nonStopTokens = rawTokens.filter((t) => t.length >= 3 && !CANAL3_STOP_WORDS.has(t));
  const tokens = (nonStopTokens.length > 0 ? nonStopTokens : rawTokens.filter((t) => t.length >= 2)).slice(0, 4);

  if (tokens.length === 0 && !Number.isFinite(volNum)) return [];

  // Pré-filtrage SQL léger sur les tokens (accent-insensible via normalized_title & v4_series.normalized_core_key) + volume
  const whereClauses: string[] = [];
  const bindings: unknown[] = [];

  if (tokens.length > 0) {
    const tokenConds = tokens.map(
      () =>
        "(b.normalized_title LIKE ? OR LOWER(COALESCE(b.series_name, '')) LIKE ? OR LOWER(COALESCE(vs.normalized_core_key, '')) LIKE ? OR LOWER(b.authors_json) LIKE ?)"
    );
    whereClauses.push(`(${tokenConds.join(' OR ')})`);
    for (const tok of tokens) {
      const pattern = `%${tok}%`;
      bindings.push(pattern, pattern, pattern, pattern);
    }
  }
  if (Number.isFinite(volNum)) {
    whereClauses.push('(b.volume_number = ? OR b.volume_number IS NULL)');
    bindings.push(volNum);
  }

  const sql = `
    SELECT b.* FROM books b
    LEFT JOIN v4_series vs ON vs.id = b.series_id
    ${whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : ''}
    ORDER BY b.updated_at DESC
    LIMIT 60
  `;
  const rows = await db.prepare(sql).bind(...bindings).all<Record<string, any>>();
  const hits: LocalSearchHit[] = [];

  for (const row of rows.results || []) {
    const book = mapBookRow(row);
    const primaryIsbn = book.knownIsbns[0] || book.editionsCatalog[0]?.isbn13 || '';
    if (!primaryIsbn) continue;

    let textScore = 0;
    const bTitleNorm = book.normalizedTitle || normalizeTextKey(book.canonicalTitle);
    const bSeriesNorm = normalizeTextKey(book.seriesName || '');
    const bAuthorNorm = normalizeTextKey(book.authors.join(' '));

    if (titleNorm) {
      if (bTitleNorm === titleNorm) textScore += 60;
      else if (bTitleNorm.includes(titleNorm) || titleNorm.includes(bTitleNorm)) textScore += 35;
      else if (titleNorm.length >= 5 && getLevenshteinDistance(bTitleNorm, titleNorm) <= 2) textScore += 30;
    }

    if (seriesNorm) {
      const queryCore = stripEditorialCollectionSuffixes(seriesNorm).coreKey;
      const bookCore = stripEditorialCollectionSuffixes(book.seriesName || '').coreKey;
      if (bookCore && queryCore && bookCore === queryCore) textScore += 50;
      else if (bSeriesNorm && (bSeriesNorm.includes(seriesNorm) || seriesNorm.includes(bSeriesNorm))) textScore += 30;
    }

    if (qNorm && !titleNorm && !seriesNorm) {
      if (bTitleNorm === qNorm || bSeriesNorm === qNorm) textScore += 55;
      else if (bTitleNorm.includes(qNorm) || bSeriesNorm.includes(qNorm)) textScore += 32;
    }

    if (authorNorm && bAuthorNorm) {
      const authTokens = authorNorm.split(/\s+/).filter((t) => t.length >= 3);
      if (authTokens.some((t) => bAuthorNorm.includes(t))) textScore += 25;
    }

    let score = textScore;
    if (Number.isFinite(volNum)) {
      if (book.volumeNumber === volNum && textScore > 0) score += 45;
      else if (book.volumeNumber !== null && book.volumeNumber !== undefined && book.volumeNumber !== volNum) score -= 50;
    }

    if (score >= 45 && textScore > 0) {
      hits.push({
        bookId: book.id,
        isbn13: primaryIsbn,
        title: book.canonicalTitle,
        seriesName: book.seriesName || undefined,
        volumeNumber: book.volumeNumber,
        authors: book.authors,
        coverUrl: book.selectedCoverUrl || undefined,
        score,
        source: 'server_d1'
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ============================================================================
// COUCHE 2 : INDEX RELATIONNEL O(1) + DÉTECTION BIDIRECTIONNELLE INTÉGRALES
// ============================================================================

export async function checkBookIndexLayer2(
  db: DatabaseBinding,
  isbn13: string,
  libraryId?: string | null,
  tracer?: PipelineTracer,
  options?: { userHint?: UserIngestHint }
): Promise<Layer2CheckResult> {
  const start = Date.now();

  let indexRow = await db
    .prepare(
      `SELECT bi.book_id, b.*
       FROM book_isbn_index bi
       JOIN books b ON b.id = bi.book_id
       WHERE bi.isbn13 = ?
       LIMIT 1`
    )
    .bind(isbn13)
    .first<Record<string, any>>();

  // Rattrapage si présent dans books.known_isbns_json sans entrée dans book_isbn_index
  if (!indexRow) {
    const fallbackBook = await db
      .prepare('SELECT * FROM books WHERE known_isbns_json LIKE ? LIMIT 1')
      .bind(`%${isbn13}%`)
      .first<Record<string, any>>();
    if (fallbackBook) {
      indexRow = fallbackBook;
      await db
        .prepare(
          `INSERT OR IGNORE INTO book_isbn_index (isbn13, book_id, is_integral, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(isbn13, fallbackBook.id, Number(fallbackBook.is_integral) === 1 ? 1 : 0, new Date().toISOString())
        .run();
    }
  }

  if (!indexRow) {
    tracer?.record('C2', 'index_lookup', 'ok', `MISS O(1) pour ISBN ${isbn13} -> passage en Couche 3`, { isbn13 }, Date.now() - start);
    return {
      status: 'FULL_MISS',
      book: null,
      ownedIntegralMatches: [],
      includedOwnedWorkIds: []
    };
  }

  let book = mapBookRow(indexRow);
  const ownedIntegralMatches: ParentIntegralRef[] = [];
  const includedOwnedWorkIds: string[] = [];

  // Si l'entrée n'est encore qu'un squelette C5 non enrichi OU si l'utilisateur a corrigé le format Intégrale,
  // forcer le passage complet en Couches 3 -> 4 pour remplacer proprement le squelette.
  let isUnenrichedSkeleton = false;
  try {
    const pendingSkel = await db
      .prepare("SELECT status FROM enrichment_queue WHERE isbn13 = ? AND status != 'done' LIMIT 1")
      .bind(isbn13)
      .first<{ status: string }>();
    if (pendingSkel) isUnenrichedSkeleton = true;
  } catch {
    // Table absente en mock unitaire isolé
  }
  const userIncludedVols = (options?.userHint?.includedVolumeNumbers || [])
    .map((v) => normalizeSeriesNumber(String(v)))
    .filter(Boolean);
  const existingIncludedSet = new Set(book.integralMetadata?.includedVolumeNumbers || []);
  const hasMissingUserIncludedVols =
    options?.userHint?.isIntegral === true &&
    userIncludedVols.some((v) => !existingIncludedSet.has(v));
  const hasFormatConflict =
    (options?.userHint?.isIntegral !== undefined && options.userHint.isIntegral !== book.isIntegral) ||
    hasMissingUserIncludedVols;

  if (isUnenrichedSkeleton || hasFormatConflict) {
    tracer?.record(
      'C2',
      'index_lookup',
      'warn',
      isUnenrichedSkeleton
        ? `Squelette C5 non enrichi pour ${isbn13} -> ré-enrichissement immédiat Couche 3`
        : `Format corrigé par l'utilisateur pour ${isbn13} -> ré-indexation Couche 3/4`,
      { isbn13, bookId: book.id, isUnenrichedSkeleton, hasFormatConflict },
      Date.now() - start
    );
    return {
      status: 'FULL_MISS',
      book: null,
      ownedIntegralMatches: [],
      includedOwnedWorkIds: [],
      staleSkeletonBookId: book.id
    };
  }

  if (!libraryId) {
    tracer?.record(
      'C2',
      'index_lookup',
      'ok',
      `HIT catalogue serveur pour ${isbn13} (« ${book.canonicalTitle} »)`,
      { isbn13, bookId: book.id, status: 'SERVER_CATALOG_HIT' },
      Date.now() - start
    );
    return { status: 'SERVER_CATALOG_HIT', book, ownedIntegralMatches, includedOwnedWorkIds };
  }

  const libEntry = await db
    .prepare('SELECT is_owned, is_wished, selected_cover_url, custom_overrides_json FROM v4_library_books WHERE library_id = ? AND book_id = ? LIMIT 1')
    .bind(libraryId, book.id)
    .first<{
      is_owned: number;
      is_wished: number;
      selected_cover_url?: string | null;
      custom_overrides_json?: string | null;
    }>();

  if (libEntry) {
    book = applyLibraryOverridesToBook(book, libEntry.selected_cover_url, libEntry.custom_overrides_json);
  }

  if (libEntry && Number(libEntry.is_owned) === 1) {
    tracer?.record(
      'C2',
      'index_lookup',
      'ok',
      `ALREADY_OWNED : ${isbn13} (« ${book.canonicalTitle} »)`,
      { isbn13, bookId: book.id, status: 'ALREADY_OWNED' },
      Date.now() - start
    );
    return { status: 'ALREADY_OWNED', book, ownedIntegralMatches, includedOwnedWorkIds };
  }

  // Cas B1 : Tome unitaire inclus dans une Intégrale déjà possédée ?
  if (!book.isIntegral) {
    const candidateIntegrals = [...book.parentIntegrals];
    if (book.seriesId && typeof book.volumeNumber === 'number') {
      const seriesIntegrals = await db
        .prepare('SELECT id, canonical_title, known_isbns_json, integral_metadata_json FROM books WHERE series_id = ? AND is_integral = 1')
        .bind(book.seriesId)
        .all<{ id: string; canonical_title: string; known_isbns_json: string; integral_metadata_json: string }>();
      for (const sInt of seriesIntegrals.results || []) {
        const meta = parseIntegralMetadataDb(sInt.integral_metadata_json);
        const matchesVol = meta.includedVolumeNumbers.includes(String(book.volumeNumber));
        const matchesWork = meta.includedWorkIds.includes(book.id);
        if ((matchesVol || matchesWork) && !candidateIntegrals.some((c) => c.integralBookId === sInt.id)) {
          const intIsbns = safeJsonParse<string[]>(sInt.known_isbns_json, []);
          candidateIntegrals.push({
            integralBookId: sInt.id,
            title: sInt.canonical_title,
            isbn13: intIsbns[0] || ''
          });
        }
      }
    }

    if (candidateIntegrals.length > 0) {
      for (const ref of candidateIntegrals) {
        const ownedInt = await db
          .prepare('SELECT is_owned FROM v4_library_books WHERE library_id = ? AND book_id = ? LIMIT 1')
          .bind(libraryId, ref.integralBookId)
          .first<{ is_owned: number }>();
        if (ownedInt && Number(ownedInt.is_owned) === 1) {
          ownedIntegralMatches.push(ref);
        }
      }
      if (ownedIntegralMatches.length > 0) {
        tracer?.record(
          'C2',
          'index_lookup',
          'warn',
          `INCLUDED_IN_INTEGRAL : « ${book.canonicalTitle} » déjà couvert par ${ownedIntegralMatches[0].title}`,
          { isbn13, bookId: book.id, ownedIntegralMatches },
          Date.now() - start
        );
        return { status: 'INCLUDED_IN_INTEGRAL', book, ownedIntegralMatches, includedOwnedWorkIds };
      }
    }
  }

  // Cas B2 : Le livre scanné EST une Intégrale — certains ou tous ses tomes sont-ils déjà possédés ?
  if (book.isIntegral) {
    const targetWorkIds = new Set<string>(book.integralMetadata.includedWorkIds);
    if (book.seriesId && book.integralMetadata.includedVolumeNumbers.length > 0) {
      const volRows = await db
        .prepare('SELECT id, volume_number FROM books WHERE series_id = ? AND is_integral = 0 AND is_hors_serie = 0')
        .bind(book.seriesId)
        .all<{ id: string; volume_number: number | null }>();
      for (const v of volRows.results || []) {
        if (v.volume_number !== null && book.integralMetadata.includedVolumeNumbers.includes(String(v.volume_number))) {
          targetWorkIds.add(v.id);
        }
      }
    }

    for (const wId of targetWorkIds) {
      const ownedChild = await db
        .prepare('SELECT is_owned FROM v4_library_books WHERE library_id = ? AND book_id = ? LIMIT 1')
        .bind(libraryId, wId)
        .first<{ is_owned: number }>();
      if (ownedChild && Number(ownedChild.is_owned) === 1) {
        includedOwnedWorkIds.push(wId);
      }
    }

    if (includedOwnedWorkIds.length > 0) {
      const totalExpected = Math.max(targetWorkIds.size, book.integralMetadata.includedVolumeNumbers.length);
      const status: Layer2Status =
        totalExpected > 0 && includedOwnedWorkIds.length >= totalExpected
          ? 'FULL_INTEGRAL_OWNED'
          : 'PARTIAL_INTEGRAL_OWNED';
      tracer?.record(
        'C2',
        'index_lookup',
        'warn',
        `${status} : ${includedOwnedWorkIds.length}/${totalExpected} tome(s) inclus déjà possédé(s)`,
        { isbn13, bookId: book.id, includedOwnedWorkIds },
        Date.now() - start
      );
      return { status, book, ownedIntegralMatches, includedOwnedWorkIds };
    }
  }

  const finalStatus: Layer2Status = libEntry ? 'LOCAL_UNOWNED' : 'SERVER_CATALOG_HIT';
  tracer?.record(
    'C2',
    'index_lookup',
    'ok',
    `HIT O(1) (${finalStatus}) : « ${book.canonicalTitle} » (${book.knownIsbns.length} ISBN(s))`,
    { isbn13, bookId: book.id, status: finalStatus },
    Date.now() - start
  );
  return { status: finalStatus, book, ownedIntegralMatches, includedOwnedWorkIds };
}

