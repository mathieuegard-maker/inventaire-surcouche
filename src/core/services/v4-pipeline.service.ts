// src/core/services/v4-pipeline.service.ts
// Pipeline d'acquisition FRBR V4 (Couches 1 -> 5) 100% portable sur DatabaseBinding + fetch().
// Zéro dépendance propriétaire Cloudflare : prêt pour D1/Pages comme pour SQLite/Postgres auto-hébergé.

import type { DatabaseBinding } from '../adapters/storage-db.interface';
import type { EditionCatalogEntry, IntegralMetadata, ParentIntegralRef } from '../types';
import {
  cleanAuthor,
  cleanPublishDate,
  cleanPublisher,
  cleanSeriesName,
  cleanTitle,
  normalizeSeriesNumber,
  normalizeTextKey,
  parseSeriesFromTitle
} from '../resolvers/bnf.resolver';
import { classifyBookMetadata } from '../utils/category-classifier.util';
import { isbnUtil } from '../utils/isbn.util';
import { stripEditorialCollectionSuffixes } from '../utils/series-matcher.util';
import { getLevenshteinDistance } from '../utils/string.util';
import { resolveBestCoverUrl, upsertCatalogEntity } from './d1-gateway.service';
import { generateTraceId, PipelineTracer } from './pipeline-logger.service';

const USER_AGENT_BASE = 'BiblioCollectionPWA/4.0 (mathieu.egard@gmail.com)';

export type SourceChannel =
  | 'canal_1_barcode'
  | 'canal_2_manual_isbn'
  | 'canal_3_text_search'
  | 'canal_4_ai_photo';

export type Layer2Status =
  | 'ALREADY_OWNED'
  | 'INCLUDED_IN_INTEGRAL'
  | 'PARTIAL_INTEGRAL_OWNED'
  | 'FULL_INTEGRAL_OWNED'
  | 'LOCAL_UNOWNED'
  | 'SERVER_CATALOG_HIT'
  | 'FULL_MISS';

export interface V4BookRecord {
  id: string;
  workCanonicalId: string;
  canonicalTitle: string;
  normalizedTitle: string;
  seriesId?: string | null;
  seriesName?: string | null;
  volumeNumber?: number | null;
  volumeLabel?: string | null;
  isHorsSerie: boolean;
  horsSerieLabel?: string | null;
  isIntegral: boolean;
  integralMetadata: IntegralMetadata;
  parentIntegrals: ParentIntegralRef[];
  authors: string[];
  language: string;
  knownIsbns: string[];
  editionsCatalog: EditionCatalogEntry[];
  selectedCoverUrl?: string | null;
  mainCategory: string;
  subgenres: string[];
  legacyEntityUri?: string | null;
  updatedAt: string;
}

export interface SisterEditionCandidate {
  source: 'bnf' | 'inventaire' | 'wikidata' | 'openlibrary' | 'google_books';
  isbn13?: string;
  title: string;
  seriesRaw?: string;
  collectionRaw?: string;
  volumeNumber?: string;
  publisher?: string;
  publishDate?: string;
  pageCount?: number;
  coverUrl?: string;
  bnfEnsembleId?: string;
  wikidataWorkQid?: string;
  wikidataSeriesQid?: string;
  language?: string;
}

export interface SeriesVoteCandidate {
  source: string;
  rawName: string;
  coreKey: string;
  cleanDisplay: string;
  weight: number;
  ensembleId?: string;
  wikidataQid?: string;
}

export interface StagingPayload {
  anchorIsbn13: string;
  anchorTitle: string;
  language: string;
  sisterEditions: SisterEditionCandidate[];
  seriesCandidates: SeriesVoteCandidate[];
  authors: string[];
  illustrators: string[];
  scriptwriters: string[];
  publisher?: string;
  publishDate?: string;
  pageCount?: number;
  description?: string;
  deweyCode?: string;
  rawSubjects: string[];
  rawTitles: string[];
  wikidataWorkQid?: string;
  wikidataSeriesQid?: string;
  inventaireWorkUri?: string;
  sourcesHit: string[];
}

export interface Layer2CheckResult {
  status: Layer2Status;
  book: V4BookRecord | null;
  ownedIntegralMatches: ParentIntegralRef[];
  includedOwnedWorkIds: string[];
}

export interface IngestSingleResult {
  inputIsbn: string;
  normalizedIsbn13: string | null;
  pressEanExtrapolatedFrom?: string;
  layer2Status: Layer2Status;
  book: V4BookRecord | null;
  ownedIntegralMatches: ParentIntegralRef[];
  includedOwnedWorkIds: string[];
  seriesExpandedQueued?: number;
  error?: string;
}

export interface IngestBatchResult {
  traceId: string;
  sourceChannel: SourceChannel;
  results: IngestSingleResult[];
}

// ============================================================================
// NORMALISATION ISBN & EXTRAPOLATION CODE-BARRES PRESSE (330/378/977)
// ============================================================================

export function computeEan13CheckDigit(twelveDigits: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(twelveDigits[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Normalise une chaîne ISBN-10/ISBN-13 ou détecte un code-barres presse (330/378/977)
 * et extrapole un candidat ISBN-13 français 978... lorsque la structure le permet.
 */
export function normalizeIsbnWithPressFallback(raw: string): {
  isbn13Candidates: string[];
  isPressEan: boolean;
  cleanRaw: string;
} {
  const clean = isbnUtil.normalize(String(raw || '')).toUpperCase();
  if (!clean) return { isbn13Candidates: [], isPressEan: false, cleanRaw: '' };

  if (clean.length === 10 && isbnUtil.isValidFormat(clean)) {
    const converted = isbnUtil.toIsbn13(clean);
    if (isbnUtil.isValidBookBarcode(converted)) {
      return { isbn13Candidates: [converted], isPressEan: false, cleanRaw: clean };
    }
  }

  if (isbnUtil.isValidBookBarcode(clean)) {
    return { isbn13Candidates: [clean], isPressEan: false, cleanRaw: clean };
  }

  // Codes presse/kiosque français (330..., 378..., 977...) sur 13 chiffres
  if (/^(330|378|977)\d{10}$/.test(clean)) {
    const body9 = clean.slice(3, 12);
    const prefix978Base = `978${body9}`;
    const candidateDirect = `${prefix978Base}${computeEan13CheckDigit(prefix978Base)}`;
    const bodyFr2 = `9782${clean.slice(4, 12)}`;
    const candidateFr2 = `${bodyFr2}${computeEan13CheckDigit(bodyFr2)}`;
    const unique = Array.from(new Set([candidateDirect, candidateFr2])).filter((c) =>
      isbnUtil.isValidBookBarcode(c)
    );
    return { isbn13Candidates: unique, isPressEan: true, cleanRaw: clean };
  }

  // Accepte un 978/979 même si clé légèrement abîmée uniquement en dernier recours? Non, rester strict sur clé.
  return { isbn13Candidates: [], isPressEan: false, cleanRaw: clean };
}

// ============================================================================
// UTILITAIRES XML / JSON / PARSING SÛRS
// ============================================================================

function parseMarcFieldsFromXml(
  xml: string
): Array<{ tag: string; subfields: Array<{ code: string; value: string }> }> {
  const fields: Array<{ tag: string; subfields: Array<{ code: string; value: string }> }> = [];
  const dfRegex = /<(?:[\w-]+:)?datafield\s+[^>]*tag="(\d+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?datafield>/gi;
  let dfMatch;
  while ((dfMatch = dfRegex.exec(xml)) !== null) {
    const tag = dfMatch[1];
    const inner = dfMatch[2];
    const subfields: Array<{ code: string; value: string }> = [];
    const sfRegex = /<(?:[\w-]+:)?subfield\s+[^>]*code="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?subfield>/gi;
    let sfMatch;
    while ((sfMatch = sfRegex.exec(inner)) !== null) {
      const val = sfMatch[2]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      subfields.push({ code: sfMatch[1], value: val });
    }
    fields.push({ tag, subfields });
  }
  return fields;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseIntegralMetadataDb(raw: string | null | undefined): IntegralMetadata {
  const obj = safeJsonParse<Record<string, unknown>>(raw, {});
  return {
    includedVolumeNumbers: Array.isArray(obj.included_volume_numbers)
      ? obj.included_volume_numbers.map(String)
      : Array.isArray(obj.includedVolumeNumbers)
        ? obj.includedVolumeNumbers.map(String)
        : [],
    includedWorkIds: Array.isArray(obj.included_work_ids)
      ? obj.included_work_ids.map(String)
      : Array.isArray(obj.includedWorkIds)
        ? obj.includedWorkIds.map(String)
        : [],
    includedIsbns: Array.isArray(obj.included_isbns)
      ? obj.included_isbns.map(String)
      : Array.isArray(obj.includedIsbns)
        ? obj.includedIsbns.map(String)
        : []
  };
}

function serializeIntegralMetadataDb(meta: IntegralMetadata): string {
  return JSON.stringify({
    included_volume_numbers: Array.from(new Set(meta.includedVolumeNumbers)),
    included_work_ids: Array.from(new Set(meta.includedWorkIds)),
    included_isbns: Array.from(new Set(meta.includedIsbns))
  });
}

function mapBookRow(row: Record<string, any>): V4BookRecord {
  return {
    id: String(row.id),
    workCanonicalId: String(row.work_canonical_id),
    canonicalTitle: String(row.canonical_title),
    normalizedTitle: String(row.normalized_title),
    seriesId: row.series_id ?? null,
    seriesName: row.series_name ?? null,
    volumeNumber: typeof row.volume_number === 'number' ? row.volume_number : row.volume_number ? Number(row.volume_number) : null,
    volumeLabel: row.volume_label ?? null,
    isHorsSerie: Number(row.is_hors_serie) === 1,
    horsSerieLabel: row.hors_serie_label ?? null,
    isIntegral: Number(row.is_integral) === 1,
    integralMetadata: parseIntegralMetadataDb(row.integral_metadata_json),
    parentIntegrals: safeJsonParse<ParentIntegralRef[]>(row.parent_integrals_json, []),
    authors: safeJsonParse<string[]>(row.authors_json, []),
    language: String(row.language || 'fr'),
    knownIsbns: safeJsonParse<string[]>(row.known_isbns_json, []),
    editionsCatalog: safeJsonParse<EditionCatalogEntry[]>(row.editions_catalog_json, []),
    selectedCoverUrl: row.selected_cover_url ?? null,
    mainCategory: String(row.main_category || 'Autre'),
    subgenres: safeJsonParse<string[]>(row.subgenres_json, []),
    legacyEntityUri: row.legacy_entity_uri ?? null,
    updatedAt: String(row.updated_at || '')
  };
}

function isStrictFrenchLanguage(lang?: string): boolean {
  if (!lang) return true; // BnF / sources sans balise explicite tolérées seulement si pas marquées étrangères
  const low = lang.trim().toLowerCase();
  return low === 'fr' || low === 'fre' || low === 'fra' || low.startsWith('fr-') || low === 'french';
}

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

  const tokens = Array.from(
    new Set(
      `${qNorm} ${titleNorm} ${seriesNorm}`
        .split(/\s+/)
        .filter((t) => t.length >= 3)
    )
  ).slice(0, 4);

  if (tokens.length === 0 && !Number.isFinite(volNum)) return [];

  // Pré-filtrage SQL léger sur les tokens + volume
  const whereClauses: string[] = [];
  const bindings: unknown[] = [];

  if (tokens.length > 0) {
    const tokenConds = tokens.map(
      () => "(normalized_title LIKE ? OR LOWER(COALESCE(series_name, '')) LIKE ? OR LOWER(authors_json) LIKE ?)"
    );
    whereClauses.push(`(${tokenConds.join(' OR ')})`);
    for (const tok of tokens) {
      const pattern = `%${tok}%`;
      bindings.push(pattern, pattern, pattern);
    }
  }
  if (Number.isFinite(volNum)) {
    whereClauses.push('(volume_number = ? OR volume_number IS NULL)');
    bindings.push(volNum);
  }

  const sql = `
    SELECT * FROM books
    ${whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT 60
  `;
  const rows = await db.prepare(sql).bind(...bindings).all<Record<string, any>>();
  const hits: LocalSearchHit[] = [];

  for (const row of rows.results || []) {
    const book = mapBookRow(row);
    const primaryIsbn = book.knownIsbns[0] || book.editionsCatalog[0]?.isbn13 || '';
    if (!primaryIsbn) continue;

    let score = 0;
    const bTitleNorm = book.normalizedTitle || normalizeTextKey(book.canonicalTitle);
    const bSeriesNorm = normalizeTextKey(book.seriesName || '');
    const bAuthorNorm = normalizeTextKey(book.authors.join(' '));

    if (titleNorm) {
      if (bTitleNorm === titleNorm) score += 60;
      else if (bTitleNorm.includes(titleNorm) || titleNorm.includes(bTitleNorm)) score += 35;
      else if (titleNorm.length >= 5 && getLevenshteinDistance(bTitleNorm, titleNorm) <= 2) score += 30;
    }

    if (seriesNorm) {
      const queryCore = stripEditorialCollectionSuffixes(seriesNorm).coreKey;
      const bookCore = stripEditorialCollectionSuffixes(book.seriesName || '').coreKey;
      if (bookCore && queryCore && bookCore === queryCore) score += 50;
      else if (bSeriesNorm && (bSeriesNorm.includes(seriesNorm) || seriesNorm.includes(bSeriesNorm))) score += 30;
    }

    if (qNorm && !titleNorm && !seriesNorm) {
      if (bTitleNorm === qNorm || bSeriesNorm === qNorm) score += 55;
      else if (bTitleNorm.includes(qNorm) || bSeriesNorm.includes(qNorm)) score += 32;
    }

    if (Number.isFinite(volNum)) {
      if (book.volumeNumber === volNum) score += 45;
      else if (book.volumeNumber !== null && book.volumeNumber !== undefined && book.volumeNumber !== volNum) score -= 50;
    }

    if (authorNorm && bAuthorNorm) {
      const authTokens = authorNorm.split(/\s+/).filter((t) => t.length >= 3);
      if (authTokens.some((t) => bAuthorNorm.includes(t))) score += 25;
    }

    if (score >= 45) {
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
  tracer?: PipelineTracer
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

  const book = mapBookRow(indexRow);
  const ownedIntegralMatches: ParentIntegralRef[] = [];
  const includedOwnedWorkIds: string[] = [];

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
    .prepare('SELECT is_owned, is_wished FROM v4_library_books WHERE library_id = ? AND book_id = ? LIMIT 1')
    .bind(libraryId, book.id)
    .first<{ is_owned: number; is_wished: number }>();

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

// ============================================================================
// COUCHE 3 : DÉCOUVERTE MULTI-SOURCES EN PARALLÈLE + ÉDITIONS SŒURS FR
// ============================================================================

function extractMarcRecordMetadata(recXml: string, fallbackIsbn?: string): SisterEditionCandidate | null {
  const fields = parseMarcFieldsFromXml(recXml);
  if (!fields.length) return null;

  let isbn13 = fallbackIsbn || '';
  let title = '';
  let seriesRaw = '';
  let volumeNumber = '';
  let bnfEnsembleId = '';
  let collectionRaw = '';
  let publisher = '';
  let publishDate = '';
  let pageCount: number | undefined;
  let coverUrl = '';
  let language = '';

  for (const f of fields) {
    const getSf = (c: string) => f.subfields.find((s) => s.code === c)?.value || '';
    if (f.tag === '020' || f.tag === '038') {
      const rawIsbn = isbnUtil.normalize(getSf('a'));
      const conv = rawIsbn.length === 10 ? isbnUtil.toIsbn13(rawIsbn) : rawIsbn;
      if (isbnUtil.isValidBookBarcode(conv)) {
        isbn13 = conv;
      }
    } else if (f.tag === '101') {
      const lang = getSf('a').toLowerCase();
      if (lang) language = lang;
    } else if (f.tag === '950') {
      const coverId = getSf('a');
      if (coverId) {
        coverUrl = `https://catalogue.bnf.fr/couverture?idImage=${coverId}&couverture=1&appName=NE`;
      }
    } else if (f.tag === '245') {
      const a = cleanTitle(getSf('a'));
      const e = cleanTitle(getSf('e'));
      const p = cleanTitle(getSf('p'));
      const n = getSf('n');
      const u = getSf('u');
      if (p && a) {
        seriesRaw = seriesRaw || cleanSeriesName(a);
        title = p;
        if (n || u) volumeNumber = volumeNumber || normalizeSeriesNumber(n || u);
      } else {
        title = title || a;
        if (u) volumeNumber = volumeNumber || normalizeSeriesNumber(u);
        if (e && !seriesRaw && /^(?:(?:tome|vol\.?|volume|épisode|n°)\s*\d+|\d{1,3})$/i.test(e.trim())) {
          volumeNumber = volumeNumber || normalizeSeriesNumber(e);
        }
      }
    } else if (f.tag === '460' || f.tag === '461') {
      const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
      const sVol = normalizeSeriesNumber(getSf('v'));
      const sEnsId = getSf('3').replace(/\D/g, '');
      if (sTitle && sVol && !seriesRaw) {
        seriesRaw = sTitle;
        volumeNumber = sVol;
        if (sEnsId) bnfEnsembleId = sEnsId;
      } else if (sTitle && !collectionRaw) {
        collectionRaw = sTitle;
        if (sEnsId && !bnfEnsembleId) bnfEnsembleId = sEnsId;
      }
    } else if (f.tag === '290' || f.tag === '410' || f.tag === '295') {
      const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
      const sVol = normalizeSeriesNumber(getSf('v'));
      if (sTitle && sVol && !seriesRaw) {
        seriesRaw = sTitle;
        volumeNumber = sVol;
      } else if (sTitle && !collectionRaw) {
        collectionRaw = sTitle;
      }
    } else if (f.tag === '260') {
      publisher = publisher || cleanPublisher(getSf('c') || getSf('b'));
      publishDate = publishDate || cleanPublishDate(getSf('d'));
    } else if (f.tag === '280') {
      const m = /(\d+)\s*p\b/i.exec(getSf('a'));
      if (m) pageCount = Number(m[1]);
    }
  }

  if (!title) return null;
  return {
    source: 'bnf',
    isbn13: isbn13 || undefined,
    title,
    seriesRaw: seriesRaw || undefined,
    collectionRaw: collectionRaw || undefined,
    volumeNumber: volumeNumber || undefined,
    publisher: publisher || undefined,
    publishDate: publishDate || undefined,
    pageCount,
    coverUrl: coverUrl || undefined,
    bnfEnsembleId: bnfEnsembleId || undefined,
    language: language || 'fre'
  };
}

export async function discoverMultiSourceLayer3(
  rawIsbn13: string,
  tracer?: PipelineTracer
): Promise<StagingPayload | null> {
  const start = Date.now();
  const isbn13 = isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn13)) || isbnUtil.normalize(rawIsbn13);
  if (!isbn13) return null;

  const bnfAnchorUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=bib.anywhere%20all%20%22${encodeURIComponent(isbn13)}%22&recordSchema=intermarcxchange&maximumRecords=2`;
  const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn13)}&maxResults=4`;
  const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn13)}&jscmd=data&format=json`;
  const invUrl = `https://inventaire.io/api/entities?action=by-uris&uris=isbn:${encodeURIComponent(isbn13)}&attributes=info|labels|descriptions|claims|image&relatives=wdt:P629|wdt:P179|wdt:P50`;

  const [bnfRes, gbRes, olRes, invRes] = await Promise.allSettled([
    fetch(bnfAnchorUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.text() : '')),
    fetch(gbUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.json() : null)),
    fetch(olUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.json() : null)),
    fetch(invUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.json() : null))
  ]);

  const sisterEditions: SisterEditionCandidate[] = [];
  const seriesCandidates: SeriesVoteCandidate[] = [];
  const authors: string[] = [];
  const illustrators: string[] = [];
  const scriptwriters: string[] = [];
  const rawSubjects: string[] = [];
  const rawTitles: string[] = [];
  const sourcesHit: string[] = [];

  let anchorTitle = '';
  let publisher = '';
  let publishDate = '';
  let pageCount: number | undefined;
  let description = '';
  let deweyCode = '';
  let wikidataWorkQid: string | undefined;
  let wikidataSeriesQid: string | undefined;
  let inventaireWorkUri: string | undefined;

  const registerSeriesVote = (
    source: string,
    rawName: string | undefined,
    weight: number,
    extra?: { ensembleId?: string; wikidataQid?: string }
  ) => {
    if (!rawName?.trim()) return;
    const { coreKey, cleanDisplay } = stripEditorialCollectionSuffixes(cleanSeriesName(rawName));
    if (!coreKey || coreKey.length < 2) return;
    seriesCandidates.push({
      source,
      rawName: rawName.trim(),
      coreKey,
      cleanDisplay: cleanDisplay || cleanSeriesName(rawName),
      weight,
      ensembleId: extra?.ensembleId,
      wikidataQid: extra?.wikidataQid
    });
  };

  // 1. Analyse BnF InterMarc
  if (bnfRes.status === 'fulfilled' && bnfRes.value) {
    const records = bnfRes.value.split('<srw:record>').slice(1);
    for (const recXml of records) {
      const cand = extractMarcRecordMetadata(recXml, isbn13);
      if (!cand) continue;
      sourcesHit.push('bnf');
      if (!isStrictFrenchLanguage(cand.language)) continue;
      sisterEditions.push(cand);
      anchorTitle = anchorTitle || cand.title;
      rawTitles.push(cand.title);
      publisher = publisher || cand.publisher || '';
      publishDate = publishDate || cand.publishDate || '';
      pageCount = pageCount || cand.pageCount;

      if (cand.seriesRaw) {
        registerSeriesVote('bnf_anchor', cand.seriesRaw, 3, { ensembleId: cand.bnfEnsembleId });
      } else if (cand.collectionRaw && cand.volumeNumber) {
        registerSeriesVote('bnf_collection_numbered', cand.collectionRaw, 2.2, { ensembleId: cand.bnfEnsembleId });
      }

      const fields = parseMarcFieldsFromXml(recXml);
      for (const f of fields) {
        const getSf = (c: string) => f.subfields.find((s) => s.code === c)?.value || '';
        if (f.tag === '100' || f.tag === '700') {
          const cleaned = cleanAuthor([getSf('a'), getSf('m')].filter(Boolean).join(', '));
          const role = getSf('4').toLowerCase();
          if (cleaned) {
            if (role.includes('440') || role.includes('ill') || role.includes('dessin')) {
              if (!illustrators.includes(cleaned)) illustrators.push(cleaned);
            } else if (role.includes('690') || role.includes('scén')) {
              if (!scriptwriters.includes(cleaned)) scriptwriters.push(cleaned);
            }
            if (!authors.includes(cleaned)) authors.push(cleaned);
          }
        } else if (f.tag === '676') {
          deweyCode = deweyCode || getSf('a');
        } else if (f.tag === '606' || f.tag === '608' || f.tag === '610') {
          if (getSf('a')) rawSubjects.push(getSf('a'));
          if (getSf('x')) rawSubjects.push(getSf('x'));
        } else if (f.tag === '830') {
          const d = getSf('a');
          if (d && d.length > description.length) description = d;
        }
      }
    }
  }

  // 2. Inventaire.io (API Publique Lecture Seule sans auth) + Wikidata
  if (invRes.status === 'fulfilled' && (invRes.value as any)?.entities) {
    const ents = (invRes.value as any).entities as Record<string, any>;
    const edEnt = ents[`isbn:${isbn13}`] || Object.values(ents).find((e: any) => e?.type === 'edition');
    if (edEnt) {
      sourcesHit.push('inventaire');
      const edTitle = cleanTitle(edEnt.claims?.['wdt:P1476']?.[0] || edEnt.labels?.fr || edEnt.labels?.en || '');
      if (edTitle) {
        rawTitles.push(edTitle);
        anchorTitle = anchorTitle || edTitle;
      }
      const rawImg = edEnt.image?.url || edEnt.claims?.['invp:P2']?.[0];
      const invCoverUrl =
        typeof rawImg === 'string' && rawImg.trim()
          ? `https://inventaire.io/img/entities/300x300/${rawImg.split('/').pop()}`
          : undefined;

      const workUri = edEnt.claims?.['wdt:P629']?.[0];
      const workEnt = workUri ? ents[workUri] : undefined;
      if (typeof workUri === 'string') {
        inventaireWorkUri = workUri;
        if (workUri.startsWith('wd:')) wikidataWorkQid = workUri.slice(3);
      }

      let invVol = '';
      let invSeries = '';
      if (workEnt) {
        const wDesc = workEnt.descriptions?.fr || workEnt.descriptions?.en;
        if (typeof wDesc === 'string' && wDesc.length > description.length) description = wDesc;
        const ord = workEnt.claims?.['wdt:P1545']?.[0];
        if (ord) invVol = normalizeSeriesNumber(String(ord));

        const authorRefs = workEnt.claims?.['wdt:P50'];
        if (Array.isArray(authorRefs)) {
          for (const aUri of authorRefs) {
            const aEnt = ents[String(aUri)];
            const aLabel = aEnt?.labels?.fr || aEnt?.labels?.en;
            if (aLabel) {
              const ca = cleanAuthor(String(aLabel));
              if (ca && !authors.includes(ca)) authors.push(ca);
            }
          }
        }

        const serieUri = workEnt.claims?.['wdt:P179']?.[0];
        if (typeof serieUri === 'string' && serieUri.startsWith('wd:')) {
          wikidataSeriesQid = serieUri.slice(3);
        }
        const serieEnt = serieUri ? ents[serieUri] : undefined;
        if (serieEnt) {
          invSeries = cleanSeriesName(serieEnt.labels?.fr || serieEnt.labels?.en || serieEnt.label || '');
          if (invSeries) {
            registerSeriesVote('inventaire_p179', invSeries, 3, { wikidataQid: wikidataSeriesQid });
          }
        }
      }

      if (edTitle) {
        sisterEditions.push({
          source: 'inventaire',
          isbn13,
          title: edTitle,
          seriesRaw: invSeries || undefined,
          volumeNumber: invVol || undefined,
          coverUrl: invCoverUrl,
          wikidataWorkQid,
          wikidataSeriesQid,
          language: 'fr'
        });
      }
    }
  }

  // 3. Google Books (FR prioritaire + éditions sœurs éventuelles)
  if (gbRes.status === 'fulfilled' && Array.isArray((gbRes.value as any)?.items)) {
    const items = (gbRes.value as any).items as any[];
    if (items.length > 0) sourcesHit.push('google_books');
    for (const item of items) {
      const info = item?.volumeInfo;
      if (!info) continue;
      if (info.language && !isStrictFrenchLanguage(info.language)) continue;
      const t = cleanTitle(info.title || '');
      if (!t) continue;
      anchorTitle = anchorTitle || t;
      rawTitles.push(t);
      if (Array.isArray(info.authors)) {
        for (const a of info.authors) {
          const ca = cleanAuthor(String(a));
          if (ca && !authors.includes(ca)) authors.push(ca);
        }
      }
      if (typeof info.description === 'string' && info.description.trim().length > description.length + 25) {
        description = info.description.trim();
      }
      if (Array.isArray(info.categories)) rawSubjects.push(...info.categories);
      const thumb = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail;
      const gbCoverUrl = thumb ? String(thumb).replace(/^http:\/\//i, 'https://') : undefined;
      const parsedFromGbTitle = parseSeriesFromTitle(t);
      if (parsedFromGbTitle.series) {
        registerSeriesVote('google_books', parsedFromGbTitle.series, 1.5);
      }
      const ids = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [];
      const gbIsbn13 =
        ids.find((x: any) => x.type === 'ISBN_13')?.identifier ||
        isbnUtil.toIsbn13(ids.find((x: any) => x.type === 'ISBN_10')?.identifier || '') ||
        isbn13;
      sisterEditions.push({
        source: 'google_books',
        isbn13: isbnUtil.isValidBookBarcode(gbIsbn13) ? gbIsbn13 : undefined,
        title: parsedFromGbTitle.title || t,
        seriesRaw: parsedFromGbTitle.series,
        volumeNumber: parsedFromGbTitle.seriesNumber,
        publisher: info.publisher ? cleanPublisher(info.publisher) : undefined,
        publishDate: info.publishedDate ? cleanPublishDate(info.publishedDate) : undefined,
        pageCount: info.pageCount,
        coverUrl: gbCoverUrl,
        language: info.language || 'fr'
      });
    }
  }

  // 4. OpenLibrary
  if (olRes.status === 'fulfilled' && olRes.value) {
    const key = Object.keys(olRes.value as Record<string, unknown>)[0];
    const olBook = key ? (olRes.value as Record<string, any>)[key] : null;
    if (olBook?.title) {
      sourcesHit.push('openlibrary');
      const t = cleanTitle(olBook.title);
      anchorTitle = anchorTitle || t;
      rawTitles.push(t);
      if (Array.isArray(olBook.authors)) {
        for (const a of olBook.authors) {
          const ca = cleanAuthor(a?.name || '');
          if (ca && !authors.includes(ca)) authors.push(ca);
        }
      }
      if (Array.isArray(olBook.subjects)) {
        for (const s of olBook.subjects) {
          const sName = typeof s === 'string' ? s : s?.name;
          if (typeof sName === 'string' && sName.trim()) rawSubjects.push(sName.trim());
        }
      }
      const olCoverUrl = olBook.cover?.large || olBook.cover?.medium;
      const parsedFromOl = parseSeriesFromTitle(t);
      sisterEditions.push({
        source: 'openlibrary',
        isbn13,
        title: parsedFromOl.title || t,
        seriesRaw: parsedFromOl.series,
        volumeNumber: parsedFromOl.seriesNumber,
        publisher: olBook.publishers?.[0]?.name ? cleanPublisher(olBook.publishers[0].name) : undefined,
        publishDate: olBook.publish_date ? cleanPublishDate(olBook.publish_date) : undefined,
        pageCount: olBook.number_of_pages,
        coverUrl: olCoverUrl,
        language: 'fr'
      });
    }
  }

  if (!anchorTitle) {
    tracer?.record(
      'C3',
      'multi_source_discovery',
      'warn',
      `Aucune source externe n'a résolu l'ISBN ${isbn13}`,
      { isbn13, sourcesHit },
      Date.now() - start
    );
    return null;
  }

  // 5. Phase C3-bis : Découverte rapide des Éditions Sœurs FR sur BnF + Wikidata direct
  // Permet de récupérer le n° de tome manquant sur une réédition ou toutes les éditions d'une même œuvre !
  const parsedAnchor = parseSeriesFromTitle(anchorTitle);
  const searchTitleClean = (parsedAnchor.title || anchorTitle).replace(/["()]/g, ' ').trim();

  const sisterLookups: Promise<void>[] = [];

  if (searchTitleClean.length >= 3) {
    sisterLookups.push(
      (async () => {
        try {
          const firstAuthorLast = authors[0] ? authors[0].split(/[,\s]+/)[0].replace(/["()]/g, '') : '';
          const cql = firstAuthorLast
            ? `(bib.title all "${searchTitleClean}") and (bib.author all "${firstAuthorLast}")`
            : `(bib.title all "${searchTitleClean}")`;
          const sruUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=12&startRecord=1`;
          const res = await fetch(sruUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
          if (!res.ok) return;
          const xml = await res.text();
          const recs = xml.split('<srw:record>').slice(1);
          const normTarget = normalizeTextKey(parsedAnchor.title || anchorTitle);

          for (const rec of recs) {
            const cand = extractMarcRecordMetadata(rec);
            if (!cand || !isStrictFrenchLanguage(cand.language)) continue;
            const normCandTitle = normalizeTextKey(parseSeriesFromTitle(cand.title).title || cand.title);
            const titleSimilar =
              normCandTitle === normTarget ||
              normCandTitle.includes(normTarget) ||
              normTarget.includes(normCandTitle) ||
              (normTarget.length >= 5 && getLevenshteinDistance(normCandTitle, normTarget) <= 2);
            if (!titleSimilar) continue;
            sisterEditions.push(cand);
            if (cand.seriesRaw) {
              registerSeriesVote('bnf_sister_edition', cand.seriesRaw, 2, { ensembleId: cand.bnfEnsembleId });
            }
          }
        } catch {
          // non-bloquant
        }
      })()
    );
  }

  if (wikidataWorkQid) {
    sisterLookups.push(
      (async () => {
        try {
          const wdUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(wikidataWorkQid!)}&props=labels|descriptions|claims&languages=fr|en&format=json`;
          const res = await fetch(wdUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
          if (!res.ok) return;
          const json = (await res.json()) as any;
          const ent = json?.entities?.[wikidataWorkQid!];
          if (!ent) return;
          sourcesHit.push('wikidata');
          const p1545 = ent.claims?.P1545?.[0]?.mainsnak?.datavalue?.value;
          const p179Id = ent.claims?.P179?.[0]?.mainsnak?.datavalue?.value?.id;
          const p1545Ord = ent.claims?.P179?.[0]?.qualifiers?.P1545?.[0]?.mainsnak?.datavalue?.value;
          const wdVol = normalizeSeriesNumber(String(p1545Ord || p1545 || ''));
          if (p179Id && typeof p179Id === 'string') {
            wikidataSeriesQid = wikidataSeriesQid || p179Id;
            const wdSeriesRes = await fetch(
              `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(p179Id)}&props=labels|claims&languages=fr|en&format=json`,
              { headers: { 'User-Agent': USER_AGENT_BASE } }
            ).catch(() => null);
            if (wdSeriesRes?.ok) {
              const sJson = (await wdSeriesRes.json()) as any;
              const sEnt = sJson?.entities?.[p179Id];
              const sLabel = sEnt?.labels?.fr?.value || sEnt?.labels?.en?.value;
              const sBnfId = sEnt?.claims?.P268?.[0]?.mainsnak?.datavalue?.value;
              if (sLabel) {
                registerSeriesVote('wikidata_p179', String(sLabel), 3, {
                  wikidataQid: p179Id,
                  ensembleId: sBnfId ? String(sBnfId).replace(/\D/g, '') : undefined
                });
              }
            }
          }
          if (wdVol) {
            sisterEditions.push({
              source: 'wikidata',
              title: ent.labels?.fr?.value || anchorTitle,
              volumeNumber: wdVol,
              wikidataWorkQid,
              wikidataSeriesQid,
              language: 'fr'
            });
          }
        } catch {
          // non-bloquant
        }
      })()
    );
  }

  await Promise.allSettled(sisterLookups);

  const uniqueSources = Array.from(new Set(sourcesHit));
  tracer?.record(
    'C3',
    'multi_source_discovery',
    'ok',
    `Staging Payload (${uniqueSources.join('+')}) : « ${anchorTitle} », ${sisterEditions.length} édition(s) sœur(s), ${seriesCandidates.length} vote(s) série`,
    {
      isbn13,
      sourcesHit: uniqueSources,
      sisterIsbns: Array.from(new Set(sisterEditions.map((s) => s.isbn13).filter(Boolean))),
      seriesVotesCount: seriesCandidates.length
    },
    Date.now() - start
  );

  return {
    anchorIsbn13: isbn13,
    anchorTitle,
    language: 'fr',
    sisterEditions,
    seriesCandidates,
    authors,
    illustrators,
    scriptwriters,
    publisher: publisher || undefined,
    publishDate: publishDate || undefined,
    pageCount,
    description: description || undefined,
    deweyCode: deweyCode || undefined,
    rawSubjects,
    rawTitles,
    wikidataWorkQid,
    wikidataSeriesQid,
    inventaireWorkUri,
    sourcesHit: uniqueSources
  };
}

// ============================================================================
// COUCHE 4 : CONSOLIDATION POST-COLLECTE (DOUBLES = INTÉGRALES, VOTE SÉRIE, HÉRITAGE TOME -> HORS-SÉRIE)
// ============================================================================

export function detectIntegralAndIncludedVolumes(payload: StagingPayload): {
  isIntegral: boolean;
  isDoubleAlbum: boolean;
  doubleSubTitles: string[];
  includedVolumeNumbers: string[];
} {
  const allTexts = [payload.anchorTitle, ...payload.rawTitles];
  const combined = allTexts.join(' | ');

  // 1. Détection explicite d'intégrale / coffret / omnibus / plage de tomes
  const hasExplicitIntegralKeyword = /(?:l['’]?\s*int[ée]grale|\bint[ée]grale\b|\bcoffret\b|\bomnibus\b|\bcompil\b|\btomes?\s+\d+\s*(?:[àa]|et|&|-|\/)\s*\d+)/i.test(
    combined
  );

  const nums = new Set<string>();
  const rangeMatch = /\b(\d{1,2})\s*(?:[àa]|-|au)\s*(\d{1,2})\b/i.exec(combined);
  if (rangeMatch) {
    const startN = parseInt(rangeMatch[1], 10);
    const endN = parseInt(rangeMatch[2], 10);
    if (startN > 0 && endN > startN && endN - startN <= 15) {
      for (let i = startN; i <= endN; i++) nums.add(String(i));
    }
  }
  const pairMatch = /\b(?:tomes?|vol\.?)\s*(\d{1,2})\s*(?:et|&|\/|\+)\s*(\d{1,2})\b/i.exec(combined);
  if (pairMatch) {
    nums.add(String(parseInt(pairMatch[1], 10)));
    nums.add(String(parseInt(pairMatch[2], 10)));
  }

  // 2. Détection Album Double (ex: "Astérix le Gaulois / La serpe d'or" ou "Titre A ; Titre B")
  let isDoubleAlbum = false;
  let doubleSubTitles: string[] = [];
  const primaryTitle = payload.anchorTitle || payload.rawTitles[0] || '';
  const slashParts = primaryTitle
    .split(/\s+\/\s+|\s+;\s+/)
    .map((p) => cleanTitle(p))
    .filter((p) => p.length >= 4 && !/^(?:ed\.?|edition|tome|vol)/i.test(p));

  if (
    slashParts.length >= 2 &&
    slashParts.length <= 4 &&
    normalizeTextKey(slashParts[0]) !== normalizeTextKey(slashParts[1]) &&
    (!payload.pageCount || payload.pageCount >= 64)
  ) {
    isDoubleAlbum = true;
    doubleSubTitles = slashParts;
  }

  const isIntegral = hasExplicitIntegralKeyword || isDoubleAlbum || nums.size >= 2;
  return {
    isIntegral,
    isDoubleAlbum,
    doubleSubTitles,
    includedVolumeNumbers: Array.from(nums).sort((a, b) => Number(a) - Number(b))
  };
}

export function electCanonicalSeriesFromVotes(candidates: SeriesVoteCandidate[]): {
  coreKey: string;
  canonicalName: string;
  aliases: string[];
  confidenceRatio: number;
  ensembleIds: string[];
  wikidataQids: string[];
} | null {
  if (!candidates.length) return null;

  const clusters = new Map<
    string,
    {
      totalWeight: number;
      names: Map<string, number>;
      ensembleIds: Set<string>;
      wikidataQids: Set<string>;
    }
  >();

  let totalAllWeights = 0;
  for (const c of candidates) {
    totalAllWeights += c.weight;
    let bucket = clusters.get(c.coreKey);
    if (!bucket) {
      bucket = {
        totalWeight: 0,
        names: new Map(),
        ensembleIds: new Set(),
        wikidataQids: new Set()
      };
      clusters.set(c.coreKey, bucket);
    }
    bucket.totalWeight += c.weight;
    bucket.names.set(c.cleanDisplay, (bucket.names.get(c.cleanDisplay) || 0) + c.weight);
    if (c.rawName && c.rawName !== c.cleanDisplay) {
      bucket.names.set(c.rawName, bucket.names.get(c.rawName) || 0.1);
    }
    if (c.ensembleId) bucket.ensembleIds.add(c.ensembleId);
    if (c.wikidataQid) bucket.wikidataQids.add(c.wikidataQid);
  }

  const ranked = Array.from(clusters.entries()).sort((a, b) => b[1].totalWeight - a[1].totalWeight);
  const [bestCoreKey, bestCluster] = ranked[0];
  const confidenceRatio = totalAllWeights > 0 ? bestCluster.totalWeight / totalAllWeights : 1;

  // Préférer la forme sans suffixe éditorial avec le plus fort poids
  const sortedNames = Array.from(bestCluster.names.entries()).sort((a, b) => b[1] - a[1]);
  const canonicalName = sortedNames[0]?.[0] || bestCoreKey;
  const aliases = Array.from(bestCluster.names.keys()).filter((n) => n && n !== canonicalName);

  return {
    coreKey: bestCoreKey,
    canonicalName,
    aliases,
    confidenceRatio,
    ensembleIds: Array.from(bestCluster.ensembleIds),
    wikidataQids: Array.from(bestCluster.wikidataQids)
  };
}

export async function consolidateBookLayer4(
  db: DatabaseBinding,
  payload: StagingPayload,
  options: {
    sourceChannel: SourceChannel;
    libraryId?: string | null;
    action?: 'owned' | 'wishlist' | 'preview';
    tracer?: PipelineTracer;
  }
): Promise<V4BookRecord> {
  const start = Date.now();
  const now = new Date().toISOString();
  const tracer = options.tracer;

  // 1. Détection Intégrale & Album Double AVANT indexation
  const integralCheck = detectIntegralAndIncludedVolumes(payload);

  // 2. Vote majoritaire par cluster sur la Série Canonique
  const electedSeries = electCanonicalSeriesFromVotes(payload.seriesCandidates);
  if (electedSeries && electedSeries.confidenceRatio < 0.6) {
    tracer?.record(
      'C4',
      'series_majority_vote',
      'warn',
      `Consensus série fragile (${Math.round(electedSeries.confidenceRatio * 100)}% < 60%) pour « ${electedSeries.canonicalName} »`,
      { candidates: payload.seriesCandidates, electedSeries }
    );
  }

  // Upsert dans v4_series si série élue
  let seriesId: string | null = null;
  let seriesName: string | null = null;
  if (electedSeries) {
    const existingSeries = await db
      .prepare('SELECT * FROM v4_series WHERE normalized_core_key = ? LIMIT 1')
      .bind(electedSeries.coreKey)
      .first<Record<string, any>>();

    if (existingSeries) {
      seriesId = String(existingSeries.id);
      seriesName = String(existingSeries.canonical_name);
      const prevAliases = safeJsonParse<string[]>(existingSeries.aliases_json, []);
      const prevEns = safeJsonParse<string[]>(existingSeries.bnf_ensemble_ids_json, []);
      const prevAuthors = safeJsonParse<string[]>(existingSeries.primary_authors_json, []);
      const mergedAliases = Array.from(new Set([...prevAliases, ...electedSeries.aliases, electedSeries.canonicalName])).filter(
        (a) => a !== seriesName
      );
      const mergedEns = Array.from(new Set([...prevEns, ...electedSeries.ensembleIds]));
      const mergedAuthors = Array.from(new Set([...prevAuthors, ...payload.authors]));
      const mergedWdQid = existingSeries.wikidata_qid || electedSeries.wikidataQids[0] || payload.wikidataSeriesQid || null;

      await db
        .prepare(
          `UPDATE v4_series
           SET aliases_json = ?, bnf_ensemble_ids_json = ?, primary_authors_json = ?, wikidata_qid = COALESCE(wikidata_qid, ?), updated_at = ?
           WHERE id = ?`
        )
        .bind(
          JSON.stringify(mergedAliases),
          JSON.stringify(mergedEns),
          JSON.stringify(mergedAuthors),
          mergedWdQid,
          now,
          seriesId
        )
        .run();
    } else {
      seriesId = `ser_${electedSeries.coreKey.replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 7)}`;
      seriesName = electedSeries.canonicalName;
      await db
        .prepare(
          `INSERT INTO v4_series
            (id, canonical_name, normalized_core_key, aliases_json, primary_authors_json, wikidata_qid, bnf_ensemble_ids_json, is_complete_expanded, known_volumes_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
        )
        .bind(
          seriesId,
          seriesName,
          electedSeries.coreKey,
          JSON.stringify(electedSeries.aliases),
          JSON.stringify(payload.authors),
          electedSeries.wikidataQids[0] || payload.wikidataSeriesQid || null,
          JSON.stringify(electedSeries.ensembleIds),
          now,
          now
        )
        .run();
    }
  }

  // 3. Règle CRITIQUE d'Héritage de Volume sur TOUTES les éditions sœurs FR AVANT classification Hors-Série !
  let inheritedVolStr = '';
  for (const s of payload.sisterEditions) {
    if (s.volumeNumber) {
      const n = normalizeSeriesNumber(s.volumeNumber);
      if (n && /^\d+$/.test(n) && Number(n) > 0) {
        inheritedVolStr = n;
        break;
      }
    }
  }
  if (!inheritedVolStr) {
    for (const t of payload.rawTitles) {
      const p = parseSeriesFromTitle(t);
      if (p.seriesNumber && /^\d+$/.test(p.seriesNumber) && Number(p.seriesNumber) > 0) {
        inheritedVolStr = p.seriesNumber;
        break;
      }
    }
  }

  const parsedAnchor = parseSeriesFromTitle(payload.anchorTitle);
  let canonicalTitle = cleanTitle(parsedAnchor.title || payload.anchorTitle);
  if (canonicalTitle && seriesName) {
    // Retirer un éventuel préfixe "Astérix - " si déjà égal à la série
    const escapedSeries = seriesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = canonicalTitle.replace(new RegExp(`^${escapedSeries}\\s*[-:–]\\s*`, 'i'), '').trim();
    if (stripped.length >= 3) canonicalTitle = stripped;
  }

  const isExplicitHs = /\b(hors[- ]s[ée]rie|sp[ée]cial|hs\b|coulisses|making[- ]of|tome\s*0\b)/i.test(
    payload.rawTitles.join(' ')
  );
  let volumeNumber: number | null =
    !integralCheck.isIntegral && !isExplicitHs && inheritedVolStr ? parseInt(inheritedVolStr, 10) : null;
  if (volumeNumber !== null && (!Number.isFinite(volumeNumber) || volumeNumber <= 0)) {
    volumeNumber = null;
  }
  const volumeLabel = volumeNumber !== null ? String(volumeNumber) : null;

  // Règle Hors-Série appliquée STRICTEMENT en fin de pipeline :
  // Si appartient à une série, non-intégrale, et qu'AUCUNE édition sœur FR / Wikidata n'a fourni de numéro de tome
  const isHorsSerie = Boolean(
    seriesId && !integralCheck.isIntegral && (isExplicitHs || volumeNumber === null)
  );
  const horsSerieLabel = isHorsSerie ? (isExplicitHs ? 'HS' : 'Hors-Série') : null;

  // 4. Classification catégorie & sous-genres
  const classification = classifyBookMetadata({
    title: canonicalTitle,
    series: seriesName || undefined,
    publisher: payload.publisher,
    deweyCode: payload.deweyCode,
    rawSubjects: payload.rawSubjects,
    description: payload.description
  });

  // 5. Agrégation de tous les ISBN FR sœurs + éditionsCatalog + couverture anti-1x1
  const knownIsbnsSet = new Set<string>([payload.anchorIsbn13]);
  const editionsCatalogMap = new Map<string, EditionCatalogEntry>();
  let bnfCoverCandidate: string | undefined;
  let gbCoverCandidate: string | undefined;
  let olCoverCandidate: string | undefined;
  let invCoverCandidate: string | undefined;

  for (const s of payload.sisterEditions) {
    if (s.isbn13 && isbnUtil.isValidBookBarcode(s.isbn13)) {
      knownIsbnsSet.add(s.isbn13);
      if (!editionsCatalogMap.has(s.isbn13)) {
        editionsCatalogMap.set(s.isbn13, {
          isbn13: s.isbn13,
          publisher: s.publisher,
          publicationYear: s.publishDate,
          coverUrl: s.coverUrl
        });
      }
    }
    if (s.source === 'bnf' && s.coverUrl && !bnfCoverCandidate) bnfCoverCandidate = s.coverUrl;
    if (s.source === 'google_books' && s.coverUrl && !gbCoverCandidate) gbCoverCandidate = s.coverUrl;
    if (s.source === 'openlibrary' && s.coverUrl && !olCoverCandidate) olCoverCandidate = s.coverUrl;
    if (s.source === 'inventaire' && s.coverUrl && !invCoverCandidate) invCoverCandidate = s.coverUrl;
  }
  if (!editionsCatalogMap.has(payload.anchorIsbn13)) {
    editionsCatalogMap.set(payload.anchorIsbn13, {
      isbn13: payload.anchorIsbn13,
      publisher: payload.publisher,
      publicationYear: payload.publishDate
    });
  }

  const selectedCoverUrl =
    (await resolveBestCoverUrl(payload.anchorIsbn13, {
      bnfCoverUrl: bnfCoverCandidate,
      gbCoverUrl: gbCoverCandidate,
      olCoverUrl: olCoverCandidate,
      invCoverUrl: invCoverCandidate,
      title: canonicalTitle,
      author: payload.authors[0]
    })) ||
    bnfCoverCandidate ||
    gbCoverCandidate ||
    invCoverCandidate ||
    olCoverCandidate ||
    null;

  // 6. Clé canonique FRBR & Idempotence (anti-doublon à l'échelle de l'Œuvre)
  const normTitle = normalizeTextKey(canonicalTitle);
  const seriesCoreKey = electedSeries?.coreKey || '';
  const workCanonicalId = integralCheck.isIntegral
    ? `integral:${seriesCoreKey || normTitle}:${integralCheck.includedVolumeNumbers.join('-') || payload.anchorIsbn13}`
    : seriesId && volumeNumber !== null && !isHorsSerie
      ? `series:${seriesCoreKey}:vol:${volumeNumber}`
      : payload.wikidataWorkQid
        ? `wd:${payload.wikidataWorkQid}`
        : `work:${normTitle}:${normalizeTextKey(payload.authors[0] || payload.anchorIsbn13)}`;

  // Vérifier si ce Work existe déjà (par work_canonical_id, ou par series_id + volume_number, ou par l'un des ISBNs connus)
  let existingBook = await db
    .prepare('SELECT * FROM books WHERE work_canonical_id = ? LIMIT 1')
    .bind(workCanonicalId)
    .first<Record<string, any>>();

  if (!existingBook && seriesId && volumeNumber !== null && !isHorsSerie && !integralCheck.isIntegral) {
    existingBook = await db
      .prepare('SELECT * FROM books WHERE series_id = ? AND volume_number = ? AND is_integral = 0 LIMIT 1')
      .bind(seriesId, volumeNumber)
      .first<Record<string, any>>();
  }

  let bookId = existingBook ? String(existingBook.id) : `bk_${generateTraceId('').replace(/^_/, '')}_${Math.random().toString(36).slice(2, 6)}`;
  let existingParentIntegrals: ParentIntegralRef[] = existingBook
    ? safeJsonParse<ParentIntegralRef[]>(existingBook.parent_integrals_json, [])
    : [];
  let integralMeta: IntegralMetadata = existingBook
    ? parseIntegralMetadataDb(existingBook.integral_metadata_json)
    : { includedVolumeNumbers: [], includedWorkIds: [], includedIsbns: [] };

  if (integralCheck.isIntegral) {
    integralMeta.includedVolumeNumbers = Array.from(
      new Set([...integralMeta.includedVolumeNumbers, ...integralCheck.includedVolumeNumbers])
    );
  }

  // Fusion des ISBNs connus et catalogue d'éditions
  if (existingBook) {
    for (const k of safeJsonParse<string[]>(existingBook.known_isbns_json, [])) knownIsbnsSet.add(k);
    for (const e of safeJsonParse<EditionCatalogEntry[]>(existingBook.editions_catalog_json, [])) {
      if (e.isbn13 && !editionsCatalogMap.has(e.isbn13)) editionsCatalogMap.set(e.isbn13, e);
    }
  }

  const finalKnownIsbns = Array.from(knownIsbnsSet);
  const finalEditionsCatalog = Array.from(editionsCatalogMap.values());
  const effectiveCover = selectedCoverUrl || existingBook?.selected_cover_url || null;

  // Synchronisation bidirectionnelle avec les Intégrales <-> Tomes unitaires
  if (integralCheck.isIntegral && seriesId) {
    const childQuery = await db
      .prepare('SELECT id, volume_number, canonical_title, known_isbns_json, parent_integrals_json FROM books WHERE series_id = ? AND is_integral = 0')
      .bind(seriesId)
      .all<Record<string, any>>();
    const intRef: ParentIntegralRef = {
      integralBookId: bookId,
      title: canonicalTitle,
      isbn13: payload.anchorIsbn13
    };
    for (const child of childQuery.results || []) {
      const childVolMatch =
        child.volume_number !== null && integralMeta.includedVolumeNumbers.includes(String(child.volume_number));
      const childDoubleMatch =
        integralCheck.isDoubleAlbum &&
        integralCheck.doubleSubTitles.some((st) => normalizeTextKey(st) === normalizeTextKey(String(child.canonical_title)));
      if (childVolMatch || childDoubleMatch) {
        integralMeta.includedWorkIds = Array.from(new Set([...integralMeta.includedWorkIds, String(child.id)]));
        for (const cIsbn of safeJsonParse<string[]>(child.known_isbns_json, [])) {
          integralMeta.includedIsbns = Array.from(new Set([...integralMeta.includedIsbns, cIsbn]));
        }
        if (child.volume_number !== null) {
          integralMeta.includedVolumeNumbers = Array.from(
            new Set([...integralMeta.includedVolumeNumbers, String(child.volume_number)])
          );
        }
        const childParents = safeJsonParse<ParentIntegralRef[]>(child.parent_integrals_json, []);
        if (!childParents.some((p) => p.integralBookId === bookId)) {
          childParents.push(intRef);
          await db
            .prepare('UPDATE books SET parent_integrals_json = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(childParents), now, child.id)
            .run();
        }
      }
    }
  } else if (!integralCheck.isIntegral && seriesId && volumeNumber !== null) {
    const intRows = await db
      .prepare('SELECT id, canonical_title, known_isbns_json, integral_metadata_json FROM books WHERE series_id = ? AND is_integral = 1')
      .bind(seriesId)
      .all<Record<string, any>>();
    for (const intRow of intRows.results || []) {
      const meta = parseIntegralMetadataDb(intRow.integral_metadata_json);
      if (meta.includedVolumeNumbers.includes(String(volumeNumber)) || meta.includedWorkIds.includes(bookId)) {
        const intIsbns = safeJsonParse<string[]>(intRow.known_isbns_json, []);
        if (!existingParentIntegrals.some((p) => p.integralBookId === intRow.id)) {
          existingParentIntegrals.push({
            integralBookId: String(intRow.id),
            title: String(intRow.canonical_title),
            isbn13: intIsbns[0] || ''
          });
        }
        meta.includedWorkIds = Array.from(new Set([...meta.includedWorkIds, bookId]));
        meta.includedIsbns = Array.from(new Set([...meta.includedIsbns, ...finalKnownIsbns]));
        await db
          .prepare('UPDATE books SET integral_metadata_json = ?, updated_at = ? WHERE id = ?')
          .bind(serializeIntegralMetadataDb(meta), now, intRow.id)
          .run();
      }
    }
  }

  // Pont rétro-compatible avec `catalog_entities` V2/V3 (SeriesView / BookDetailView / Notifications)
  const legacyEditionUri = existingBook?.legacy_entity_uri || `isbn:${payload.anchorIsbn13}`;
  let legacySeriesUri: string | undefined;
  const legacyAuthorUris: string[] = [];
  try {
    for (const aName of payload.authors) {
      legacyAuthorUris.push(
        await upsertCatalogEntity(db, {
          entityType: 'human',
          label: aName,
          claims: { 'wdt:P31': ['wd:Q5'] }
        })
      );
    }
    if (seriesName) {
      legacySeriesUri = await upsertCatalogEntity(db, {
        entityType: 'serie',
        label: seriesName,
        mainCategory: classification.mainCategory,
        subgenres: classification.subgenres,
        authorUris: legacyAuthorUris,
        claims: {
          'wdt:P31': ['wd:Q277759'],
          ...(electedSeries?.ensembleIds.length ? { 'wdt:P268': electedSeries.ensembleIds } : {}),
          ...(payload.wikidataSeriesQid ? { 'invp:wikidataSeriesUri': [`wd:${payload.wikidataSeriesQid}`] } : {})
        }
      });
    }
    const legacyWorkUri = await upsertCatalogEntity(db, {
      entityType: 'work',
      label: canonicalTitle,
      seriesUri: legacySeriesUri,
      seriesNumber: volumeLabel || undefined,
      authorUris: legacyAuthorUris,
      mainCategory: classification.mainCategory,
      subgenres: classification.subgenres,
      imageUrl: effectiveCover || undefined,
      descriptions: payload.description ? { fr: payload.description } : {},
      claims: {
        'wdt:P31': ['wd:Q47461344'],
        ...(legacySeriesUri ? { 'wdt:P179': [legacySeriesUri] } : {}),
        ...(volumeLabel ? { 'wdt:P1545': [volumeLabel] } : {})
      }
    });
    await upsertCatalogEntity(db, {
      uri: legacyEditionUri,
      entityType: 'edition',
      label: canonicalTitle,
      isbn13: payload.anchorIsbn13,
      workUri: legacyWorkUri,
      seriesUri: legacySeriesUri,
      seriesNumber: volumeLabel || undefined,
      authorUris: legacyAuthorUris,
      mainCategory: classification.mainCategory,
      subgenres: classification.subgenres,
      imageUrl: effectiveCover || undefined,
      descriptions: payload.description ? { fr: payload.description } : {},
      claims: {
        'wdt:P629': [legacyWorkUri],
        'wdt:P212': [payload.anchorIsbn13],
        'wdt:P1476': [canonicalTitle],
        ...(payload.publishDate ? { 'wdt:P577': [payload.publishDate] } : {}),
        ...(payload.pageCount ? { 'wdt:P1104': [payload.pageCount] } : {})
      }
    });
  } catch {
    // Non-bloquant si tables V2 absentes dans certains tests isolés
  }

  // Upsert du livre consolidé dans `books`
  if (existingBook) {
    await db
      .prepare(
        `UPDATE books SET
          canonical_title = ?, normalized_title = ?, series_id = ?, series_name = ?,
          volume_number = ?, volume_label = ?, is_hors_serie = ?, hors_serie_label = ?,
          is_integral = ?, integral_metadata_json = ?, parent_integrals_json = ?,
          authors_json = ?, known_isbns_json = ?, editions_catalog_json = ?,
          selected_cover_url = ?, main_category = ?, subgenres_json = ?,
          legacy_entity_uri = COALESCE(legacy_entity_uri, ?), updated_at = ?
         WHERE id = ?`
      )
      .bind(
        canonicalTitle,
        normTitle,
        seriesId,
        seriesName,
        volumeNumber,
        volumeLabel,
        isHorsSerie ? 1 : 0,
        horsSerieLabel,
        integralCheck.isIntegral ? 1 : 0,
        serializeIntegralMetadataDb(integralMeta),
        JSON.stringify(existingParentIntegrals),
        JSON.stringify(payload.authors),
        JSON.stringify(finalKnownIsbns),
        JSON.stringify(finalEditionsCatalog),
        effectiveCover,
        classification.mainCategory,
        JSON.stringify(classification.subgenres),
        legacyEditionUri,
        now,
        bookId
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO books
          (id, work_canonical_id, canonical_title, normalized_title, series_id, series_name,
           volume_number, volume_label, is_hors_serie, hors_serie_label, is_integral,
           integral_metadata_json, parent_integrals_json, authors_json, language,
           known_isbns_json, editions_catalog_json, selected_cover_url, main_category,
           subgenres_json, legacy_entity_uri, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fr', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        bookId,
        workCanonicalId,
        canonicalTitle,
        normTitle,
        seriesId,
        seriesName,
        volumeNumber,
        volumeLabel,
        isHorsSerie ? 1 : 0,
        horsSerieLabel,
        integralCheck.isIntegral ? 1 : 0,
        serializeIntegralMetadataDb(integralMeta),
        JSON.stringify(existingParentIntegrals),
        JSON.stringify(payload.authors),
        JSON.stringify(finalKnownIsbns),
        JSON.stringify(finalEditionsCatalog),
        effectiveCover,
        classification.mainCategory,
        JSON.stringify(classification.subgenres),
        legacyEditionUri,
        now,
        now
      )
      .run();
  }

  // Indexation O(1) de TOUS les ISBN FR sœurs vers `book_id`
  const idxStmts = finalKnownIsbns.map((kIsbn) =>
    db
      .prepare(
        `INSERT INTO book_isbn_index (isbn13, book_id, is_integral, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(isbn13) DO UPDATE SET book_id = excluded.book_id, is_integral = excluded.is_integral`
      )
      .bind(kIsbn, bookId, integralCheck.isIntegral ? 1 : 0, now)
  );
  if (idxStmts.length > 0) await db.batch(idxStmts);

  // Mise à jour v4_library_books + library_items si libraryId + action != preview
  if (options.libraryId && options.action && options.action !== 'preview') {
    await linkBookToLibrary(db, {
      libraryId: options.libraryId,
      bookId,
      legacyEntityUri: legacyEditionUri,
      isOwned: options.action === 'owned',
      isWished: options.action === 'wishlist',
      sourceChannel: options.sourceChannel,
      coverUrl: effectiveCover
    });
  }

  const savedRow = await db.prepare('SELECT * FROM books WHERE id = ? LIMIT 1').bind(bookId).first<Record<string, any>>();
  const record = savedRow ? mapBookRow(savedRow) : mapBookRow({
    id: bookId,
    work_canonical_id: workCanonicalId,
    canonical_title: canonicalTitle,
    normalized_title: normTitle,
    series_id: seriesId,
    series_name: seriesName,
    volume_number: volumeNumber,
    volume_label: volumeLabel,
    is_hors_serie: isHorsSerie ? 1 : 0,
    hors_serie_label: horsSerieLabel,
    is_integral: integralCheck.isIntegral ? 1 : 0,
    integral_metadata_json: serializeIntegralMetadataDb(integralMeta),
    parent_integrals_json: JSON.stringify(existingParentIntegrals),
    authors_json: JSON.stringify(payload.authors),
    language: 'fr',
    known_isbns_json: JSON.stringify(finalKnownIsbns),
    editions_catalog_json: JSON.stringify(finalEditionsCatalog),
    selected_cover_url: effectiveCover,
    main_category: classification.mainCategory,
    subgenres_json: JSON.stringify(classification.subgenres),
    legacy_entity_uri: legacyEditionUri,
    updated_at: now
  });

  tracer?.record(
    'C4',
    'consolidation',
    'ok',
    `Consolidé « ${record.canonicalTitle} » (${record.seriesName || 'One-shot'} ${record.volumeLabel ? `#${record.volumeLabel}` : record.isHorsSerie ? 'HS' : ''}) — ${record.knownIsbns.length} ISBN(s) indexé(s)`,
    {
      bookId: record.id,
      workCanonicalId: record.workCanonicalId,
      seriesName: record.seriesName,
      volumeNumber: record.volumeNumber,
      isHorsSerie: record.isHorsSerie,
      isIntegral: record.isIntegral,
      knownIsbnsCount: record.knownIsbns.length,
      hasCover: Boolean(record.selectedCoverUrl)
    },
    Date.now() - start
  );

  return record;
}

export async function linkBookToLibrary(
  db: DatabaseBinding,
  params: {
    libraryId: string;
    bookId: string;
    legacyEntityUri?: string | null;
    isOwned: boolean;
    isWished: boolean;
    sourceChannel?: string;
    coverUrl?: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO v4_library_books
        (library_id, book_id, is_owned, is_wished, source_channel, selected_cover_url, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, book_id) DO UPDATE SET
         is_owned = MAX(v4_library_books.is_owned, excluded.is_owned),
         is_wished = CASE WHEN excluded.is_owned = 1 THEN 0 ELSE excluded.is_wished END,
         selected_cover_url = COALESCE(excluded.selected_cover_url, v4_library_books.selected_cover_url),
         updated_at = excluded.updated_at`
    )
    .bind(
      params.libraryId,
      params.bookId,
      params.isOwned ? 1 : 0,
      params.isWished ? 1 : 0,
      params.sourceChannel || null,
      params.coverUrl || null,
      now,
      now
    )
    .run();

  if (params.legacyEntityUri && (params.isOwned || params.isWished)) {
    const legacyStatus = params.isOwned ? 'owned' : 'wishlist';
    try {
      const existingLegacy = await db
        .prepare(
          'SELECT id FROM library_items WHERE library_id = ? AND (edition_id = ? OR work_id = ?) AND deleted_at IS NULL LIMIT 1'
        )
        .bind(params.libraryId, params.legacyEntityUri, params.legacyEntityUri)
        .first<{ id: string }>();

      if (existingLegacy?.id) {
        await db
          .prepare('UPDATE library_items SET ownership_status = ?, updated_at = ? WHERE id = ?')
          .bind(legacyStatus, now, existingLegacy.id)
          .run();
      } else {
        const itemId = `itm_${params.libraryId}_${params.bookId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        await db
          .prepare(
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, acquired_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            itemId,
            params.libraryId,
            params.legacyEntityUri,
            params.legacyEntityUri,
            legacyStatus,
            params.isOwned ? now : null,
            now,
            now
          )
          .run();
      }
    } catch {
      // Ignore si table V2 library_items absente dans test unitaire isolé
    }
  }
}

// ============================================================================
// COUCHE 5 : SQUELETTE RAPIDE DE SÉRIE (5A) + FILE `enrichment_queue` (5B)
// ============================================================================

export async function enqueueOrExpandSeriesLayer5(
  db: DatabaseBinding,
  book: V4BookRecord,
  tracer?: PipelineTracer
): Promise<number> {
  if (!book.seriesId || !book.seriesName) return 0;
  const start = Date.now();
  const now = new Date().toISOString();

  const sRow = await db
    .prepare('SELECT * FROM v4_series WHERE id = ? LIMIT 1')
    .bind(book.seriesId)
    .first<Record<string, any>>();
  if (!sRow || Number(sRow.is_complete_expanded) === 1) return 0;

  const ensembleIds = safeJsonParse<string[]>(sRow.bnf_ensemble_ids_json, []);
  const discoveredSkeleton: Array<{ title: string; volumeNumber?: number; isbn13?: string; coverUrl?: string }> = [];

  // Phase 5A : 1 seule requête ciblée BnF `bib.ens2bib` (très économe en sous-requêtes Cloudflare !)
  const targetEnsId = ensembleIds[0];
  if (targetEnsId) {
    try {
      const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(`bib.ens2bib any "${targetEnsId}"`)}&recordSchema=intermarcxchange&maximumRecords=30&startRecord=1`;
      const res = await fetch(bnfUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
      if (res.ok) {
        const xml = await res.text();
        for (const rec of xml.split('<srw:record>').slice(1)) {
          const cand = extractMarcRecordMetadata(rec);
          if (!cand || !cand.isbn13 || !isStrictFrenchLanguage(cand.language)) continue;
          const vNum = cand.volumeNumber && /^\d+$/.test(cand.volumeNumber) ? parseInt(cand.volumeNumber, 10) : undefined;
          discoveredSkeleton.push({
            title: cleanTitle(parseSeriesFromTitle(cand.title).title || cand.title),
            volumeNumber: vNum,
            isbn13: cand.isbn13,
            coverUrl: cand.coverUrl
          });
        }
      }
    } catch {
      // Non-bloquant
    }
  }

  let queuedCount = 0;
  for (const skel of discoveredSkeleton) {
    if (!skel.isbn13) continue;
    const already = await db
      .prepare('SELECT book_id FROM book_isbn_index WHERE isbn13 = ? LIMIT 1')
      .bind(skel.isbn13)
      .first<{ book_id: string }>();
    if (already) continue;

    // Squelette léger immédiat dans books + book_isbn_index puis enrichissement complet mis en queue pour le CRON
    const skelCanonId = skel.volumeNumber
      ? `series:${sRow.normalized_core_key}:vol:${skel.volumeNumber}`
      : `work:${normalizeTextKey(skel.title)}:${skel.isbn13}`;
    const skelBookId = `bk_${generateTraceId('').replace(/^_/, '')}_${Math.random().toString(36).slice(2, 6)}`;

    await db
      .prepare(
        `INSERT OR IGNORE INTO books
          (id, work_canonical_id, canonical_title, normalized_title, series_id, series_name,
           volume_number, volume_label, is_hors_serie, is_integral, authors_json, language,
           known_isbns_json, editions_catalog_json, selected_cover_url, main_category, subgenres_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'fr', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        skelBookId,
        skelCanonId,
        skel.title,
        normalizeTextKey(skel.title),
        book.seriesId,
        book.seriesName,
        skel.volumeNumber ?? null,
        skel.volumeNumber ? String(skel.volumeNumber) : null,
        skel.volumeNumber ? 0 : 1,
        JSON.stringify(book.authors),
        JSON.stringify([skel.isbn13]),
        JSON.stringify([{ isbn13: skel.isbn13, coverUrl: skel.coverUrl }]),
        skel.coverUrl || null,
        book.mainCategory,
        JSON.stringify(book.subgenres),
        now,
        now
      )
      .run();

    const insertedOrExisting = await db
      .prepare('SELECT id FROM books WHERE work_canonical_id = ? LIMIT 1')
      .bind(skelCanonId)
      .first<{ id: string }>();

    if (insertedOrExisting?.id) {
      await db
        .prepare('INSERT OR IGNORE INTO book_isbn_index (isbn13, book_id, is_integral, created_at) VALUES (?, ?, 0, ?)')
        .bind(skel.isbn13, insertedOrExisting.id, now)
        .run();

      await db
        .prepare(
          `INSERT INTO enrichment_queue (book_id, isbn13, series_id, priority, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, 5, 'pending', 0, ?, ?)
           ON CONFLICT(isbn13) DO NOTHING`
        )
        .bind(insertedOrExisting.id, skel.isbn13, book.seriesId, now, now)
        .run();
      queuedCount++;
    }
  }

  await db
    .prepare(
      `UPDATE v4_series
       SET is_complete_expanded = 1,
           known_volumes_count = (SELECT COUNT(*) FROM books WHERE series_id = ?),
           series_checked_at = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(book.seriesId, now, now, book.seriesId)
    .run();

  tracer?.record(
    'C5',
    'series_skeleton_and_queue',
    'ok',
    `Squelette série « ${book.seriesName} » : ${discoveredSkeleton.length} tome(s) détecté(s), ${queuedCount} mis en file enrichment_queue`,
    { seriesId: book.seriesId, discovered: discoveredSkeleton.length, queuedCount },
    Date.now() - start
  );
  return queuedCount;
}

/**
 * Phase 5B exécutée par `workers/release-cron` : dépile N éléments de `enrichment_queue`
 * en arrière-plan (Couche 3 + Couche 4 complète) sans saturer les sous-requêtes Cloudflare.
 */
export async function drainEnrichmentQueueBatch(
  db: DatabaseBinding,
  limit = 3
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const safeLimit = Math.min(8, Math.max(1, Math.trunc(limit)));
  const pending = await db
    .prepare(
      `SELECT id, book_id, isbn13, attempts
       FROM enrichment_queue
       WHERE status = 'pending' AND attempts < 3
       ORDER BY priority DESC, id ASC
       LIMIT ?`
    )
    .bind(safeLimit)
    .all<{ id: number; book_id: string | null; isbn13: string; attempts: number }>();

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const row of pending.results || []) {
    processed++;
    const now = new Date().toISOString();
    const tracer = new PipelineTracer({ sourceChannel: 'cron_enrichment' });
    await db
      .prepare("UPDATE enrichment_queue SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();

    try {
      const staging = await discoverMultiSourceLayer3(row.isbn13, tracer);
      if (!staging) {
        await db
          .prepare("UPDATE enrichment_queue SET status = CASE WHEN attempts >= 3 THEN 'error' ELSE 'pending' END, last_error = ?, updated_at = ? WHERE id = ?")
          .bind('Aucune donnée C3', new Date().toISOString(), row.id)
          .run();
        failed++;
      } else {
        await consolidateBookLayer4(db, staging, {
          sourceChannel: 'canal_1_barcode',
          action: 'preview',
          tracer
        });
        await db
          .prepare("UPDATE enrichment_queue SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
          .bind(new Date().toISOString(), row.id)
          .run();
        succeeded++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur C5';
      await db
        .prepare("UPDATE enrichment_queue SET status = CASE WHEN attempts >= 3 THEN 'error' ELSE 'pending' END, last_error = ?, updated_at = ? WHERE id = ?")
        .bind(msg.slice(0, 300), new Date().toISOString(), row.id)
        .run();
      tracer.record('CRON', 'enrichment_queue_item', 'error', msg, { isbn13: row.isbn13 });
      failed++;
    } finally {
      await tracer.flush(db);
    }
  }

  return { processed, succeeded, failed };
}

/**
 * Passe CRON silencieuse : redécouvre de nouveaux ISBN d'éditions sœurs FR ou intégrales
 * pour les livres existants dans `books` et les indexe dans `book_isbn_index` / `parent_integrals`
 * sans créer de bruit dans les notifications.
 */
export async function runSilentEditionDiscoveryPass(
  db: DatabaseBinding,
  limit = 2
): Promise<{ checkedBooks: number; newIsbnsIndexed: number }> {
  const safeLimit = Math.min(5, Math.max(1, Math.trunc(limit)));
  const candidates = await db
    .prepare(
      `SELECT id, canonical_title, authors_json, known_isbns_json, series_id, volume_number, is_integral
       FROM books
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .bind(safeLimit)
    .all<Record<string, any>>();

  let checkedBooks = 0;
  let newIsbnsIndexed = 0;
  const now = new Date().toISOString();

  for (const row of candidates.results || []) {
    checkedBooks++;
    const title = String(row.canonical_title || '').replace(/["()]/g, ' ').trim();
    const authors = safeJsonParse<string[]>(row.authors_json, []);
    const firstAuthorLast = authors[0] ? authors[0].split(/[,\s]+/)[0].replace(/["()]/g, '') : '';
    if (title.length < 3) continue;

    try {
      const cql = firstAuthorLast
        ? `(bib.title all "${title}") and (bib.author all "${firstAuthorLast}")`
        : `(bib.title all "${title}")`;
      const sruUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=10&startRecord=1`;
      const res = await fetch(sruUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
      if (!res.ok) continue;
      const xml = await res.text();
      const existingIsbns = new Set(safeJsonParse<string[]>(row.known_isbns_json, []));
      const added: string[] = [];

      for (const rec of xml.split('<srw:record>').slice(1)) {
        const cand = extractMarcRecordMetadata(rec);
        if (!cand?.isbn13 || !isStrictFrenchLanguage(cand.language)) continue;
        if (!isbnUtil.isValidBookBarcode(cand.isbn13) || existingIsbns.has(cand.isbn13)) continue;
        if (normalizeTextKey(cand.title) !== normalizeTextKey(row.canonical_title)) continue;
        existingIsbns.add(cand.isbn13);
        added.push(cand.isbn13);
      }

      if (added.length > 0) {
        await db
          .prepare('UPDATE books SET known_isbns_json = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(Array.from(existingIsbns)), now, row.id)
          .run();
        const stmts = added.map((isbn13) =>
          db
            .prepare(
              'INSERT OR IGNORE INTO book_isbn_index (isbn13, book_id, is_integral, created_at) VALUES (?, ?, ?, ?)'
            )
            .bind(isbn13, row.id, Number(row.is_integral) === 1 ? 1 : 0, now)
        );
        await db.batch(stmts);
        newIsbnsIndexed += added.length;
      } else {
        await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
      }
    } catch {
      // Silencieux : ne bloque jamais le CRON
    }
  }

  return { checkedBooks, newIsbnsIndexed };
}

// ============================================================================
// ORCHESTRATEUR D'INGESTION UNIFIÉ (COUCHES 2 -> 5 SUR CONTRAT PIVOT C1)
// ============================================================================

export async function runV4IngestionPipeline(
  db: DatabaseBinding,
  params: {
    isbns: string[];
    sourceChannel: SourceChannel;
    libraryId?: string | null;
    userId?: string | null;
    action?: 'owned' | 'wishlist' | 'preview';
    traceId?: string;
  }
): Promise<IngestBatchResult> {
  const tracer = new PipelineTracer({
    traceId: params.traceId,
    userId: params.userId,
    sourceChannel: params.sourceChannel
  });

  const cleanInputs = Array.from(new Set(params.isbns.map((s) => String(s || '').trim()).filter(Boolean)));
  tracer.record('C1', 'pivot_received', 'ok', `Réception ${cleanInputs.length} ISBN(s) depuis ${params.sourceChannel}`, {
    isbns: cleanInputs,
    action: params.action || 'preview'
  });

  const results: IngestSingleResult[] = [];
  let subrequestBudgetUsed = 0;

  for (const rawInput of cleanInputs) {
    const norm = normalizeIsbnWithPressFallback(rawInput);
    if (norm.isbn13Candidates.length === 0) {
      tracer.record('C1', 'isbn_validation', 'warn', `Format ISBN invalide ignoré : ${rawInput}`, { rawInput });
      results.push({
        inputIsbn: rawInput,
        normalizedIsbn13: null,
        layer2Status: 'FULL_MISS',
        book: null,
        ownedIntegralMatches: [],
        includedOwnedWorkIds: [],
        error: 'Format ISBN invalide'
      });
      continue;
    }

    // 1. Tester les candidats en Couche 2 (index O(1))
    let resolvedL2: Layer2CheckResult | null = null;
    let activeIsbn13 = norm.isbn13Candidates[0];
    for (const cand of norm.isbn13Candidates) {
      const l2 = await checkBookIndexLayer2(db, cand, params.libraryId, tracer);
      if (l2.status !== 'FULL_MISS') {
        resolvedL2 = l2;
        activeIsbn13 = cand;
        break;
      }
    }

    if (resolvedL2 && resolvedL2.book) {
      // Lier à la bibliothèque si nouvel ajout demandé et pas déjà couvert/possédé
      if (
        params.libraryId &&
        params.action &&
        params.action !== 'preview' &&
        (resolvedL2.status === 'LOCAL_UNOWNED' || resolvedL2.status === 'SERVER_CATALOG_HIT')
      ) {
        await linkBookToLibrary(db, {
          libraryId: params.libraryId,
          bookId: resolvedL2.book.id,
          legacyEntityUri: resolvedL2.book.legacyEntityUri,
          isOwned: params.action === 'owned',
          isWished: params.action === 'wishlist',
          sourceChannel: params.sourceChannel,
          coverUrl: resolvedL2.book.selectedCoverUrl
        });
      }

      results.push({
        inputIsbn: rawInput,
        normalizedIsbn13: activeIsbn13,
        pressEanExtrapolatedFrom: norm.isPressEan ? norm.cleanRaw : undefined,
        layer2Status: resolvedL2.status,
        book: resolvedL2.book,
        ownedIntegralMatches: resolvedL2.ownedIntegralMatches,
        includedOwnedWorkIds: resolvedL2.includedOwnedWorkIds
      });
      continue;
    }

    // 2. FULL_MISS -> Si lot important (>3 miss dans la même requête HTTP), empiler au-delà pour respecter la limite de sous-requêtes Workers
    if (subrequestBudgetUsed >= 3) {
      await db
        .prepare(
          `INSERT INTO enrichment_queue (book_id, isbn13, series_id, priority, status, attempts, created_at, updated_at)
           VALUES (NULL, ?, NULL, 10, 'pending', 0, ?, ?)
           ON CONFLICT(isbn13) DO UPDATE SET priority = 10, status = 'pending', updated_at = excluded.updated_at`
        )
        .bind(activeIsbn13, new Date().toISOString(), new Date().toISOString())
        .run();
      tracer.record('C5', 'deferred_ingest', 'warn', `Lot volumineux : ISBN ${activeIsbn13} mis en file prioritaire`, {
        isbn13: activeIsbn13
      });
      results.push({
        inputIsbn: rawInput,
        normalizedIsbn13: activeIsbn13,
        pressEanExtrapolatedFrom: norm.isPressEan ? norm.cleanRaw : undefined,
        layer2Status: 'FULL_MISS',
        book: null,
        ownedIntegralMatches: [],
        includedOwnedWorkIds: []
      });
      continue;
    }

    subrequestBudgetUsed++;
    let staging: StagingPayload | null = null;
    for (const cand of norm.isbn13Candidates) {
      staging = await discoverMultiSourceLayer3(cand, tracer);
      if (staging) {
        activeIsbn13 = cand;
        break;
      }
    }

    if (!staging) {
      results.push({
        inputIsbn: rawInput,
        normalizedIsbn13: activeIsbn13,
        pressEanExtrapolatedFrom: norm.isPressEan ? norm.cleanRaw : undefined,
        layer2Status: 'FULL_MISS',
        book: null,
        ownedIntegralMatches: [],
        includedOwnedWorkIds: [],
        error: 'Livre introuvable dans BnF, Inventaire.io, Wikidata, Google Books et OpenLibrary.'
      });
      continue;
    }

    const consolidated = await consolidateBookLayer4(db, staging, {
      sourceChannel: params.sourceChannel,
      libraryId: params.libraryId,
      action: params.action,
      tracer
    });

    // Couche 5 : Squelette rapide + file d'attente (seulement si une seule requête/peu d'ISBN pour garder de la marge)
    let queuedCount = 0;
    if (subrequestBudgetUsed <= 2) {
      queuedCount = await enqueueOrExpandSeriesLayer5(db, consolidated, tracer);
    }

    // Re-vérifier Couche 2 après consolidation pour remonter d'éventuelles détections bidirectionnelles (intégrale trouvée a posteriori)
    const postCheck = params.libraryId
      ? await checkBookIndexLayer2(db, activeIsbn13, params.libraryId)
      : null;

    results.push({
      inputIsbn: rawInput,
      normalizedIsbn13: activeIsbn13,
      pressEanExtrapolatedFrom: norm.isPressEan ? norm.cleanRaw : undefined,
      layer2Status:
        postCheck?.status === 'INCLUDED_IN_INTEGRAL' ||
        postCheck?.status === 'PARTIAL_INTEGRAL_OWNED' ||
        postCheck?.status === 'FULL_INTEGRAL_OWNED'
          ? postCheck.status
          : 'FULL_MISS',
      book: consolidated,
      ownedIntegralMatches: postCheck?.ownedIntegralMatches || [],
      includedOwnedWorkIds: postCheck?.includedOwnedWorkIds || [],
      seriesExpandedQueued: queuedCount
    });
  }

  await tracer.flush(db);

  return {
    traceId: tracer.traceId,
    sourceChannel: params.sourceChannel,
    results
  };
}
