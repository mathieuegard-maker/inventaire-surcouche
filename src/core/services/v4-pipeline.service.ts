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
  isBookOrPressEan13,
  isFrancophoneBookIsbn13,
  isNonBookMarcType,
  normalizeSeriesNumber,
  normalizeTextKey,
  parseSeriesFromTitle
} from '../resolvers/bnf.resolver';
import { classifyBookMetadata } from '../utils/category-classifier.util';
import { isbnUtil } from '../utils/isbn.util';
import {
  isEditorialPaperbackCollectionName,
  stripEditorialCollectionSuffixes
} from '../utils/series-matcher.util';
import {
  areDistinctSeriesWorkTitles,
  fetchCanonicalSeriesIndex,
  isCleanerCanonicalSeriesName,
  resolveCanonicalVolumeNumber,
  type CanonicalSeriesIndex
} from '../resolvers/series-canonical.resolver';
import { getLevenshteinDistance } from '../utils/string.util';
import { resolveBestCoverUrl, upsertCatalogEntity } from './d1-gateway.service';
import { generateTraceId, PipelineTracer } from './pipeline-logger.service';

const USER_AGENT_BASE = 'BiblioCollectionPWA/4.0 (mathieu.egard@gmail.com)';

// Circuit-breaker mémoire Google Books (évite les 100 % HTTP 429 sur IP partagée Cloudflare)
const GOOGLE_BOOKS_COOLDOWN_MS = 15 * 60 * 1000;
let googleBooksCooldownUntil = 0;

export function isGoogleBooksCircuitOpen(): boolean {
  return Date.now() < googleBooksCooldownUntil;
}

export function tripGoogleBooksCircuit(ms = GOOGLE_BOOKS_COOLDOWN_MS): void {
  googleBooksCooldownUntil = Date.now() + ms;
}

export function resetGoogleBooksCircuit(): void {
  googleBooksCooldownUntil = 0;
}

/**
 * Exécute un fetch() portable avec AbortController (timeout) et 1 retry automatique
 * sur erreur réseau ou HTTP 525 / 502 / 503 / 504 (fréquent sur le handshake SSL Cloudflare <-> BnF SRU).
 */
export async function fetchWithTimeoutAndRetry(
  url: string,
  options?: {
    timeoutMs?: number;
    retriesOn5xx?: number;
    headers?: Record<string, string>;
  }
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? 4500;
  const maxRetries = options?.retriesOn5xx ?? 1;
  const headers = { 'User-Agent': USER_AGENT_BASE, ...(options?.headers || {}) };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if ((res.status === 525 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Network timeout or error');
}

/**
 * Extrait proprement le nom de famille d'un auteur pour une requête CQL `bib.author` BnF,
 * qu'il soit au format "Prénom Nom" ("René Goscinny", "J. K. Rowling") ou "Nom, Prénom" ("Goscinny, René").
 */
export function extractAuthorLastNameForBnfCql(rawAuthor?: string): string {
  if (!rawAuthor) return '';
  const cleaned = rawAuthor
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/["()]/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.includes(',')) {
    const beforeComma = cleaned.split(',')[0].trim();
    const parts = beforeComma.split(/\s+/).filter(Boolean);
    return parts[parts.length - 1] || beforeComma;
  }
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.replace(/^[.'’]+|[.'’]+$/g, ''))
    .filter((w) => w.replace(/[^a-zA-ZÀ-ÿ]/g, '').length >= 2);
  return words.length > 0 ? words[words.length - 1] : '';
}

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
  hiddenSeriesIds?: string[];
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

export interface UserIngestHint {
  title?: string;
  series?: string;
  volumeNumber?: string;
  isIntegral?: boolean;
  includedVolumeNumbers?: string[];
  coverUrl?: string;
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
  wikidataWorkQids?: string[];
  wikidataSeriesQid?: string;
  inventaireWorkUri?: string;
  includedVolumeNumbersHint?: string[];
  integralOrdinalHint?: string;
  anchorIsIntegralHint?: boolean;
  sourcesHit: string[];
}

export interface Layer2CheckResult {
  status: Layer2Status;
  book: V4BookRecord | null;
  ownedIntegralMatches: ParentIntegralRef[];
  includedOwnedWorkIds: string[];
  staleSkeletonBookId?: string;
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

export interface LibraryBookOverrides {
  title?: string;
  authors?: string[];
  seriesId?: string | null;
  seriesName?: string | null;
  volumeNumber?: number | null;
  volumeLabel?: string | null;
  isHorsSerie?: boolean;
  publisher?: string;
  publicationYear?: string;
  mainCategory?: string;
  subgenres?: string[];
  hiddenFromSeriesIds?: string[];
}

/**
 * Option B : Applique les surcharges privées d'un foyer (`v4_library_books`) par-dessus
 * la fiche de référence commune (`books`), sans jamais altérer la fiche partagée des autres utilisateurs.
 */
function applyLibraryOverridesToBook(
  book: V4BookRecord,
  libSelectedCoverUrl?: string | null,
  customOverridesJson?: string | null
): V4BookRecord {
  const cleanCover = typeof libSelectedCoverUrl === 'string' && libSelectedCoverUrl.trim()
    ? libSelectedCoverUrl.trim()
    : null;
  const ov = customOverridesJson ? safeJsonParse<LibraryBookOverrides>(customOverridesJson, {}) : {};
  const hasOverrides = Boolean(cleanCover || Object.keys(ov).length > 0);
  if (!hasOverrides) return book;

  const nextEditions = [...book.editionsCatalog];
  if ((ov.publisher !== undefined || ov.publicationYear !== undefined) && nextEditions.length > 0) {
    nextEditions[0] = {
      ...nextEditions[0],
      ...(ov.publisher !== undefined ? { publisher: ov.publisher } : {}),
      ...(ov.publicationYear !== undefined ? { publicationYear: ov.publicationYear } : {})
    };
  }

  return {
    ...book,
    ...(ov.title ? { canonicalTitle: ov.title, normalizedTitle: normalizeTextKey(ov.title) } : {}),
    ...(Array.isArray(ov.authors) && ov.authors.length > 0 ? { authors: ov.authors } : {}),
    ...(ov.seriesId !== undefined ? { seriesId: ov.seriesId } : {}),
    ...(ov.seriesName !== undefined ? { seriesName: ov.seriesName } : {}),
    ...(ov.volumeNumber !== undefined ? { volumeNumber: ov.volumeNumber } : {}),
    ...(ov.volumeLabel !== undefined ? { volumeLabel: ov.volumeLabel } : {}),
    ...(ov.isHorsSerie !== undefined ? { isHorsSerie: ov.isHorsSerie } : {}),
    ...(ov.mainCategory !== undefined ? { mainCategory: ov.mainCategory } : {}),
    ...(Array.isArray(ov.subgenres) ? { subgenres: ov.subgenres } : {}),
    ...(Array.isArray(ov.hiddenFromSeriesIds) && ov.hiddenFromSeriesIds.length > 0
      ? { hiddenSeriesIds: ov.hiddenFromSeriesIds }
      : {}),
    editionsCatalog: nextEditions,
    ...(cleanCover ? { selectedCoverUrl: cleanCover } : {})
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

// ============================================================================
// COUCHE 3 : DÉCOUVERTE MULTI-SOURCES EN PARALLÈLE + ÉDITIONS SŒURS FR
// ============================================================================

function isPlausibleVolumeNumberStr(vol?: string): boolean {
  if (!vol) return false;
  if (/^\d+$/.test(vol)) {
    const n = Number(vol);
    return n > 0 && n <= 150;
  }
  return vol.length <= 6;
}

function isIntegralCandidateTitleOrPages(
  title: string,
  pageCount?: number,
  hasSeriesContext = false
): boolean {
  if (
    /(?:l['’]?\s*int[ée]grale|\bint[ée]grale\b|\bcoffret\b|\bomnibus\b|\bcompil\b|\bdouble\s+album\b|\b2\s+en\s+1\b|\btomes?\s+\d+\s*(?:[àa]|et|&|-|\/)\s*\d+)/i.test(
      title || ''
    )
  ) {
    return true;
  }
  if (!hasSeriesContext) return false;
  const slashParts = (title || '')
    .split(/\s+\/\s+|\s+;\s+/)
    .map((p) => cleanTitle(p))
    .filter((p) => p.length >= 4 && !/^(?:journal|enqu[êe]te|voyage|histoires|souvenirs|carnet|roman|ed\.?)/i.test(p));
  return slashParts.length >= 2 && (!pageCount || pageCount >= 64);
}

export function extractMarcRecordMetadata(
  recXml: string,
  fallbackIsbn?: string
): (SisterEditionCandidate & { _isIntegral?: boolean }) | null {
  const fields = parseMarcFieldsFromXml(recXml);
  if (!fields.length) return null;

  let isbn13 = fallbackIsbn || '';
  let hasPrimaryIsbn = false;
  let title = '';
  let series245 = '';
  let vol245 = '';
  let series460 = '';
  let vol460 = '';
  let ensId460 = '';
  let unnumberedEns = '';
  let unnumberedEnsId = '';
  let series290 = '';
  let vol290 = '';
  let series410 = '';
  let vol410 = '';
  let collectionRaw = '';
  let publisher = '';
  let publishDate = '';
  let pageCount: number | undefined;
  let coverUrl = '';
  let language = '';
  let isDualPages = false;
  let secondTitleHint = '';
  let explicitIntegralTag245 = false;
  let integralOrd245 = '';

  // En INTERMARC-B BnF (intermarcxchange), le code langue (ex: 'fre') se trouve aux positions 31..34 de la zone 008
  const cf008Match = /<(?:[\w-]+:)?controlfield\s+[^>]*tag="008"[^>]*>([^<]*)<\/(?:[\w-]+:)?controlfield>/i.exec(recXml);
  const cf008 = cf008Match ? cf008Match[1] : '';
  if (cf008.length >= 34) {
    const lang008 = cf008.substring(31, 34).trim().toLowerCase();
    if (/^[a-z]{3}$/.test(lang008)) language = lang008;
  }

  for (const f of fields) {
    const getSf = (c: string) => f.subfields.find((s) => s.code === c)?.value || '';
    if (f.tag === '020' || f.tag === '038') {
      const rawIsbn = isbnUtil.normalize(getSf('a'));
      const conv = rawIsbn.length === 10 ? isbnUtil.toIsbn13(rawIsbn) : rawIsbn;
      if (isbnUtil.isValidBookBarcode(conv) && isBookOrPressEan13(conv)) {
        if (!hasPrimaryIsbn || f.tag === '038') {
          isbn13 = conv;
          hasPrimaryIsbn = true;
        }
      }
    } else if (f.tag === '041' || f.tag === '101') {
      const lang = getSf('a').trim().toLowerCase();
      if (/^[a-z]{3}$/.test(lang) && !language) language = lang;
    } else if (f.tag === '950') {
      const coverId = getSf('a');
      if (coverId) {
        coverUrl = `https://catalogue.bnf.fr/couverture?idImage=${coverId}&couverture=1&appName=NE`;
      }
    } else if (f.tag === '245') {
      if (isNonBookMarcType(getSf('d'))) {
        return null;
      }
      const a = cleanTitle(getSf('a'));
      const b = cleanTitle(getSf('b'));
      const e = cleanTitle(getSf('e'));
      const h = cleanTitle(getSf('h'));
      const i = cleanTitle(getSf('i'));
      const p = cleanTitle(getSf('p'));
      const n = getSf('n');
      const u = getSf('u');
      if (b) secondTitleHint = b;
      const integralSource245 = `${e} ${b} ${i}`.trim();
      if (/\b(?:l['’]?\s*int[ée]grale|int[ée]grale|coffret|omnibus|compil)\b/i.test(integralSource245) && !/\b(?:texte|version)\s+int[ée]grale?\b/i.test(integralSource245)) {
        explicitIntegralTag245 = true;
        integralOrd245 = normalizeSeriesNumber(h || u || n || '');
      }
      if ((p || (i && !explicitIntegralTag245 && normalizeTextKey(i) !== normalizeTextKey(a))) && a) {
        const subTitle = p || i;
        series245 = series245 || cleanSeriesName(a);
        title = subTitle;
        if (n || u || (!explicitIntegralTag245 && h)) {
          vol245 = vol245 || normalizeSeriesNumber(n || u || h);
        }
      } else {
        title = title || a;
        if (explicitIntegralTag245 && title && !/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(title)) {
          title =
            integralOrd245 && /^\d+$/.test(integralOrd245)
              ? `${title} — Intégrale ${integralOrd245}`
              : `${title} — Intégrale`;
        }
        if (u || n || (!explicitIntegralTag245 && h)) {
          vol245 = vol245 || normalizeSeriesNumber(u || n || h);
        }
        if (e && /^(?:(?:tome|vol\.?|volume|épisode|n°)\s*\d+|\d{1,3})$/i.test(e.trim())) {
          vol245 = vol245 || normalizeSeriesNumber(e);
        }
      }
    } else if (f.tag === '460' || f.tag === '461') {
      const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
      const sVol = normalizeSeriesNumber(getSf('v'));
      const rawDigitsEns = getSf('3').replace(/\D/g, '');
      const sEnsId = rawDigitsEns.length >= 8 ? rawDigitsEns.slice(-8) : rawDigitsEns;
      const validBibEnsId = /^[34]\d{6,}$/.test(sEnsId) ? sEnsId : '';
      if (sTitle && sVol && !series460 && !isEditorialPaperbackCollectionName(sTitle)) {
        series460 = sTitle;
        vol460 = sVol;
        if (validBibEnsId) ensId460 = validBibEnsId;
      } else if (sTitle && !unnumberedEns && !isEditorialPaperbackCollectionName(sTitle)) {
        unnumberedEns = sTitle;
        if (validBibEnsId) unnumberedEnsId = validBibEnsId;
      }
    } else if (f.tag === '290') {
      const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
      const sVol = normalizeSeriesNumber(getSf('v'));
      if (
        sTitle &&
        sVol &&
        !series290 &&
        !isEditorialPaperbackCollectionName(sTitle) &&
        isPlausibleVolumeNumberStr(sVol)
      ) {
        series290 = sTitle;
        vol290 = sVol;
      } else if (sTitle && !collectionRaw) {
        collectionRaw = sTitle;
      }
    } else if (f.tag === '410' || f.tag === '295') {
      const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
      const sVol = normalizeSeriesNumber(getSf('v'));
      if (
        sTitle &&
        sVol &&
        !series410 &&
        !isEditorialPaperbackCollectionName(sTitle) &&
        isPlausibleVolumeNumberStr(sVol)
      ) {
        series410 = sTitle;
        vol410 = sVol;
      } else if (sTitle && !collectionRaw) {
        collectionRaw = sTitle;
      }
    } else if (f.tag === '260') {
      publisher = publisher || cleanPublisher(getSf('c') || getSf('b'));
      publishDate = publishDate || cleanPublishDate(getSf('d'));
    } else if (f.tag === '280') {
      const raw280 = getSf('a');
      if (/\d+\s*-\s*\d+\s*p\./i.test(raw280)) isDualPages = true;
      const m = /(\d+)\s*p\b/i.exec(raw280);
      if (m) pageCount = Number(m[1]);
    }
  }

  if (!title) return null;

  // Priorité stricte InterMarc : 460/461 > 245$p/$u > 290 (filtré) > 410/295 (filtré)
  let seriesRaw = '';
  let volumeNumber = '';
  let bnfEnsembleId = ensId460 || unnumberedEnsId;

  if (series460) {
    seriesRaw = series460;
    volumeNumber = vol460 || vol245;
  } else if (series245) {
    seriesRaw = series245;
    volumeNumber = vol245;
  } else if (series290) {
    seriesRaw = series290;
    volumeNumber = vol245 || vol290;
  } else if (series410) {
    seriesRaw = series410;
    volumeNumber = vol245 || vol410;
  } else if (vol245) {
    volumeNumber = vol245;
    if (unnumberedEns && !isEditorialPaperbackCollectionName(unnumberedEns)) {
      seriesRaw = unnumberedEns;
    }
  } else if (unnumberedEns && !collectionRaw) {
    collectionRaw = unnumberedEns;
  }

  const _isIntegral =
    explicitIntegralTag245 ||
    isDualPages ||
    Boolean(secondTitleHint && /\b(tomes?|albums?|int[ée]grale)\b/i.test(secondTitleHint)) ||
    isIntegralCandidateTitleOrPages(`${title} ${secondTitleHint}`, pageCount, Boolean(seriesRaw));

  if (isDualPages && secondTitleHint && !title.includes(secondTitleHint)) {
    title = `${title} / ${secondTitleHint}`;
  }

  return {
    source: 'bnf',
    isbn13: isbn13 || undefined,
    title,
    seriesRaw: seriesRaw || undefined,
    collectionRaw: collectionRaw || undefined,
    volumeNumber: _isIntegral ? undefined : (volumeNumber || undefined),
    publisher: publisher || undefined,
    publishDate: publishDate || undefined,
    pageCount,
    coverUrl: coverUrl || undefined,
    bnfEnsembleId: bnfEnsembleId || undefined,
    language: language || 'fre',
    _isIntegral
  };
}

export async function discoverMultiSourceLayer3(
  rawIsbn13: string,
  tracer?: PipelineTracer
): Promise<StagingPayload | null> {
  const start = Date.now();
  const isbn13 = isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn13)) || isbnUtil.normalize(rawIsbn13);
  if (!isbn13) return null;

  const bnfQuery = `bib.anywhere all "${isbn13}"`;
  const bnfAnchorUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(bnfQuery)}&recordSchema=intermarcxchange&maximumRecords=2`;
  const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn13)}&maxResults=4`;
  const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn13)}&jscmd=data&format=json`;
  const invUrl = `https://inventaire.io/api/entities?action=by-uris&uris=isbn:${encodeURIComponent(isbn13)}&attributes=info|labels|descriptions|claims|image&relatives=wdt:P629|wdt:P179|wdt:P50`;

  const fetchTrackedText = async (url: string) => {
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeoutAndRetry(url, { timeoutMs: 4500, retriesOn5xx: 1 });
      const text = r.ok ? await r.text() : await r.text().catch(() => '');
      return { ok: r.ok, status: r.status, ms: Date.now() - t0, data: r.ok ? text : '', err: r.ok ? undefined : text.slice(0, 180) };
    } catch (e: unknown) {
      return { ok: false, status: 0, ms: Date.now() - t0, data: '', err: e instanceof Error ? e.message : 'Network error' };
    }
  };
  const fetchTrackedJson = async (url: string) => {
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeoutAndRetry(url, { timeoutMs: 4500, retriesOn5xx: 0 });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { ok: false, status: r.status, ms: Date.now() - t0, data: null as any, err: txt.slice(0, 180) };
      }
      const json = await r.json().catch(() => null);
      return { ok: true, status: r.status, ms: Date.now() - t0, data: json, err: undefined };
    } catch (e: unknown) {
      return { ok: false, status: 0, ms: Date.now() - t0, data: null as any, err: e instanceof Error ? e.message : 'Network error' };
    }
  };

  const gbCircuitOpen = isGoogleBooksCircuitOpen();
  const [bnfRes, gbRes, olRes, invRes] = await Promise.all([
    fetchTrackedText(bnfAnchorUrl),
    gbCircuitOpen
      ? Promise.resolve({ ok: false, status: 429, ms: 0, data: null as any, err: 'circuit-breaker cooldown' })
      : fetchTrackedJson(gbUrl),
    fetchTrackedJson(olUrl),
    fetchTrackedJson(invUrl)
  ]);
  if (!gbCircuitOpen && gbRes.status === 429) {
    tripGoogleBooksCircuit();
  }

  const sisterEditions: SisterEditionCandidate[] = [];
  const seriesCandidates: SeriesVoteCandidate[] = [];
  const authors: string[] = [];
  const illustrators: string[] = [];
  const scriptwriters: string[] = [];
  const rawSubjects: string[] = [];
  const rawTitles: string[] = [];
  const sourcesHit: string[] = [];

  let anchorTitle = '';
  let anchorVolumeNumber = '';
  let anchorIsIntegral = false;
  let publisher = '';
  let publishDate = '';
  let pageCount: number | undefined;
  let description = '';
  let deweyCode = '';
  let wikidataWorkQid: string | undefined;
  const wikidataWorkQids: string[] = [];
  let wikidataSeriesQid: string | undefined;
  let inventaireWorkUri: string | undefined;
  const includedVolumeNumbersHint = new Set<string>();

  const registerSeriesVote = (
    source: string,
    rawName: string | undefined,
    weight: number,
    extra?: { ensembleId?: string; wikidataQid?: string }
  ) => {
    if (!rawName?.trim()) return;
    if (isEditorialPaperbackCollectionName(rawName)) return;
    const { coreKey, cleanDisplay } = stripEditorialCollectionSuffixes(cleanSeriesName(rawName));
    if (!coreKey || coreKey.length < 2) return;
    if (isEditorialPaperbackCollectionName(cleanDisplay)) return;
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
  const bnfExtractedSummary: any[] = [];
  if (bnfRes.ok && bnfRes.data) {
    const records = bnfRes.data.split('<srw:record>').slice(1);
    for (const recXml of records) {
      const cand = extractMarcRecordMetadata(recXml, isbn13);
      if (!cand) continue;
      sourcesHit.push('bnf');
      if (!isStrictFrenchLanguage(cand.language)) continue;
      sisterEditions.push(cand);
      anchorTitle = anchorTitle || cand.title;
      if (!anchorVolumeNumber && cand.volumeNumber) anchorVolumeNumber = cand.volumeNumber;
      if (cand._isIntegral) anchorIsIntegral = true;
      rawTitles.push(cand.title);
      publisher = publisher || cand.publisher || '';
      publishDate = publishDate || cand.publishDate || '';
      pageCount = pageCount || cand.pageCount;
      bnfExtractedSummary.push({
        title: cand.title,
        seriesRaw: cand.seriesRaw,
        volumeNumber: cand.volumeNumber,
        collectionRaw: cand.collectionRaw,
        isIntegral: Boolean(cand._isIntegral),
        lang: cand.language
      });

      if (cand.seriesRaw) {
        registerSeriesVote('bnf_anchor', cand.seriesRaw, 3, { ensembleId: cand.bnfEnsembleId });
      } else if (cand.collectionRaw && cand.volumeNumber && isPlausibleVolumeNumberStr(cand.volumeNumber)) {
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
  tracer?.record(
    'C3',
    'api_bnf',
    bnfRes.ok ? (bnfExtractedSummary.length ? 'ok' : 'warn') : 'error',
    `BnF SRU (${isbn13}) HTTP ${bnfRes.status} (${bnfRes.ms}ms) -> ${bnfExtractedSummary.length} notice(s)`,
    { request: { url: bnfAnchorUrl, query: bnfQuery }, status: bnfRes.status, results: bnfExtractedSummary, error: bnfRes.err },
    bnfRes.ms
  );

  // 2. Inventaire.io (API Publique Lecture Seule sans auth) + Wikidata
  let invSummary: Record<string, unknown> | null = null;
  if (invRes.ok && invRes.data?.entities) {
    const ents = invRes.data.entities as Record<string, any>;
    const edEnt = ents[`isbn:${isbn13}`] || Object.values(ents).find((e: any) => e?.type === 'edition');
    if (edEnt) {
      sourcesHit.push('inventaire');
      const edTitle = cleanTitle(edEnt.claims?.['wdt:P1476']?.[0] || edEnt.labels?.fr || edEnt.labels?.en || '');
      if (edTitle) {
        rawTitles.push(edTitle);
        if (!anchorTitle || (/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(edTitle) && !/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(anchorTitle))) {
          anchorTitle = edTitle;
        }
      }
      const rawImg = edEnt.image?.url || edEnt.claims?.['invp:P2']?.[0];
      const invCoverUrl =
        typeof rawImg === 'string' && rawImg.trim()
          ? `https://inventaire.io/img/entities/300x300/${rawImg.split('/').pop()}`
          : undefined;

      const workUris: string[] = Array.isArray(edEnt.claims?.['wdt:P629'])
        ? edEnt.claims['wdt:P629'].map(String).filter(Boolean)
        : [];
      const workUri = workUris[0];
      if (typeof workUri === 'string') {
        inventaireWorkUri = workUri;
        if (workUri.startsWith('wd:')) wikidataWorkQid = workUri.slice(3);
      }
      for (const wUri of workUris) {
        if (wUri.startsWith('wd:')) {
          const q = wUri.slice(3);
          if (!wikidataWorkQids.includes(q)) wikidataWorkQids.push(q);
        }
      }
      if (workUris.length > 1 || (edTitle && isIntegralCandidateTitleOrPages(edTitle, undefined, true))) {
        anchorIsIntegral = true;
      }

      const workEnt = workUri ? ents[workUri] : undefined;
      let invVol = '';
      let invSeries = '';
      for (const wUri of workUris) {
        const wEnt = ents[wUri];
        if (!wEnt) continue;
        const wDesc = wEnt.descriptions?.fr || wEnt.descriptions?.en;
        if (typeof wDesc === 'string' && wDesc.length > description.length) description = wDesc;
        const ord = wEnt.claims?.['wdt:P1545']?.[0];
        if (ord) {
          const normOrd = normalizeSeriesNumber(String(ord));
          if (normOrd && /^\d+$/.test(normOrd)) {
            if (workUris.length > 1) {
              includedVolumeNumbersHint.add(normOrd);
            } else {
              invVol = invVol || normOrd;
              if (!anchorVolumeNumber) anchorVolumeNumber = normOrd;
            }
          }
        }
        const authorRefs = wEnt.claims?.['wdt:P50'];
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
        const serieUri = wEnt.claims?.['wdt:P179']?.[0];
        if (typeof serieUri === 'string' && serieUri.startsWith('wd:')) {
          wikidataSeriesQid = wikidataSeriesQid || serieUri.slice(3);
        }
        const serieEnt = serieUri ? ents[serieUri] : undefined;
        if (serieEnt) {
          const sName = cleanSeriesName(serieEnt.labels?.fr || serieEnt.labels?.en || serieEnt.label || '');
          if (sName) {
            invSeries = invSeries || sName;
            registerSeriesVote('inventaire_p179', sName, 3, { wikidataQid: wikidataSeriesQid });
          }
        }
      }

      if (workEnt && !invSeries && !wikidataSeriesQid) {
        const sFallback = workEnt.claims?.['wdt:P179']?.[0];
        if (typeof sFallback === 'string' && sFallback.startsWith('wd:')) wikidataSeriesQid = sFallback.slice(3);
      }

      invSummary = {
        edTitle,
        workUri,
        workUrisCount: workUris.length,
        invVol,
        includedVols: Array.from(includedVolumeNumbersHint),
        invSeries,
        wikidataSeriesQid
      };
      if (edTitle) {
        sisterEditions.push({
          source: 'inventaire',
          isbn13,
          title: edTitle,
          seriesRaw: invSeries || undefined,
          volumeNumber: workUris.length <= 1 ? (invVol || undefined) : undefined,
          coverUrl: invCoverUrl,
          wikidataWorkQid: workUris.length <= 1 ? wikidataWorkQid : undefined,
          wikidataSeriesQid,
          language: 'fr'
        });
      }
    }
  }
  tracer?.record(
    'C3',
    'api_inventaire',
    invRes.ok ? (invSummary ? 'ok' : 'warn') : 'error',
    `Inventaire.io (${isbn13}) HTTP ${invRes.status} (${invRes.ms}ms) -> ${invSummary ? 'HIT' : 'Aucun'}`,
    { request: { url: invUrl }, status: invRes.status, result: invSummary, error: invRes.err },
    invRes.ms
  );

  // 3. Google Books (FR prioritaire + éditions sœurs éventuelles)
  const gbSummary: any[] = [];
  if (gbRes.ok && Array.isArray(gbRes.data?.items)) {
    const items = gbRes.data.items as any[];
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
      const candIntegralGb = isIntegralCandidateTitleOrPages(t, info.pageCount);
      gbSummary.push({ title: t, series: parsedFromGbTitle.series, vol: parsedFromGbTitle.seriesNumber, pages: info.pageCount });
      if (!anchorVolumeNumber || !parsedFromGbTitle.seriesNumber || parsedFromGbTitle.seriesNumber === anchorVolumeNumber) {
        if (candIntegralGb === anchorIsIntegral || !anchorTitle) {
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
    }
  }
  if (!gbCircuitOpen) {
    tracer?.record(
      'C3',
      'api_google_books',
      gbRes.ok ? (gbSummary.length ? 'ok' : 'warn') : gbRes.status === 429 ? 'warn' : 'error',
      gbRes.status === 429
        ? `Google Books (${isbn13}) HTTP 429 -> circuit-breaker activé 15 min`
        : `Google Books (${isbn13}) HTTP ${gbRes.status} (${gbRes.ms}ms) -> ${gbSummary.length} résultat(s)`,
      { request: { url: gbUrl }, status: gbRes.status, results: gbSummary, error: gbRes.err },
      gbRes.ms
    );
  }

  // 4. OpenLibrary
  let olSummary: Record<string, unknown> | null = null;
  if (olRes.ok && olRes.data) {
    const key = Object.keys(olRes.data as Record<string, unknown>)[0];
    const olBook = key ? (olRes.data as Record<string, any>)[key] : null;
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
      olSummary = { title: t, publisher: olBook.publishers?.[0]?.name, pages: olBook.number_of_pages };
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
  tracer?.record(
    'C3',
    'api_openlibrary',
    olRes.ok ? (olSummary ? 'ok' : 'warn') : 'error',
    `OpenLibrary (${isbn13}) HTTP ${olRes.status} (${olRes.ms}ms) -> ${olSummary ? 'HIT' : 'Aucun'}`,
    { request: { url: olUrl }, status: olRes.status, result: olSummary, error: olRes.err },
    olRes.ms
  );

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
  const effectiveAnchorVol = normalizeSeriesNumber(anchorVolumeNumber || parsedAnchor.seriesNumber || '');
  const effectiveAnchorIntegral =
    anchorIsIntegral ||
    wikidataWorkQids.length > 1 ||
    isIntegralCandidateTitleOrPages(anchorTitle, pageCount, seriesCandidates.length > 0);

  const sisterLookups: Promise<void>[] = [];

  if (searchTitleClean.length >= 3) {
    sisterLookups.push(
      (async () => {
        const s0 = Date.now();
        try {
          const firstAuthorLast = extractAuthorLastNameForBnfCql(authors[0]);
          const cql = firstAuthorLast
            ? `(bib.title all "${searchTitleClean}") and (bib.author all "${firstAuthorLast}") and (bib.doctype all "a")`
            : `(bib.title all "${searchTitleClean}") and (bib.doctype all "a")`;
          const sruUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=12&startRecord=1`;
          const res = await fetchWithTimeoutAndRetry(sruUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
          if (!res.ok) {
            tracer?.record(
              'C3',
              'api_bnf_sisters',
              'warn',
              `BnF Sœurs CQL HTTP ${res.status}`,
              { request: { url: sruUrl, cql }, status: res.status },
              Date.now() - s0
            );
            return;
          }
          const xml = await res.text();
          const recs = xml.split('<srw:record>').slice(1);
          const normTarget = normalizeTextKey(parsedAnchor.title || anchorTitle);
          let accepted = 0;
          let rejectedDiffVol = 0;
          let rejectedIntegralMismatch = 0;

          for (const rec of recs) {
            const cand = extractMarcRecordMetadata(rec);
            if (!cand || !isStrictFrenchLanguage(cand.language)) continue;
            if (cand.isbn13 && !isFrancophoneBookIsbn13(cand.isbn13)) continue;
            const candTitleClean = parseSeriesFromTitle(cand.title).title || cand.title;
            const normCandTitle = normalizeTextKey(candTitleClean);
            const titleSimilar =
              normCandTitle === normTarget ||
              normCandTitle.includes(normTarget) ||
              normTarget.includes(normCandTitle) ||
              (normTarget.length >= 5 && getLevenshteinDistance(normCandTitle, normTarget) <= 2);
            if (!titleSimilar) continue;

            // Garde critique anti-absorption entre tomes distincts (ex: Culottées T1 vs T2) ou Intégrale vs Tome
            const candVol = normalizeSeriesNumber(cand.volumeNumber || parseSeriesFromTitle(cand.title).seriesNumber || '');
            if (effectiveAnchorVol && candVol && candVol !== effectiveAnchorVol) {
              rejectedDiffVol++;
              continue;
            }
            // Si le tome ancre est numéroté mais la notice sœur n'a PAS de numéro ET porte un titre générique identique à la série
            // (ex: "Culottées", "Aya de Yopougon", "Mattéo"), ou inversement si l'ancre n'a pas de numéro mais la sœur en a un sur titre générique,
            // ne pas l'absorber (évite la contamination T1 <-> T2).
            const candSeriesCore = cand.seriesRaw ? stripEditorialCollectionSuffixes(cand.seriesRaw).coreKey : '';
            const normCandCore = stripEditorialCollectionSuffixes(candTitleClean).coreKey;
            const anchorSeriesCore = seriesCandidates[0]?.coreKey || '';
            const isGenericSeriesTitle =
              (candSeriesCore && normCandCore === candSeriesCore) ||
              (anchorSeriesCore && normCandCore === anchorSeriesCore);
            if (isGenericSeriesTitle && ((effectiveAnchorVol && !candVol) || (!effectiveAnchorVol && candVol))) {
              rejectedDiffVol++;
              continue;
            }
            if (Boolean(cand._isIntegral) !== effectiveAnchorIntegral) {
              rejectedIntegralMismatch++;
              continue;
            }

            sisterEditions.push(cand);
            accepted++;
            if (cand.seriesRaw) {
              registerSeriesVote('bnf_sister_edition', cand.seriesRaw, 2, { ensembleId: cand.bnfEnsembleId });
            }
          }

          tracer?.record(
            'C3',
            'api_bnf_sisters',
            'ok',
            `BnF Sœurs (${recs.length} reçue(s)) : ${accepted} retenue(s), ${rejectedDiffVol} écartée(s) autre tome, ${rejectedIntegralMismatch} autre format`,
            {
              request: { url: sruUrl, cql, anchorVol: effectiveAnchorVol, anchorIntegral: effectiveAnchorIntegral },
              status: res.status,
              totalRecords: recs.length,
              accepted,
              rejectedDiffVol,
              rejectedIntegralMismatch
            },
            Date.now() - s0
          );
        } catch (err: unknown) {
          tracer?.record(
            'C3',
            'api_bnf_sisters',
            'error',
            `Erreur BnF Sœurs : ${err instanceof Error ? err.message : String(err)}`,
            { searchTitleClean },
            Date.now() - s0
          );
        }
      })()
    );
  }

  const wdBatchIds = Array.from(new Set([wikidataWorkQid, ...wikidataWorkQids].filter(Boolean) as string[])).slice(0, 12);
  if (wdBatchIds.length > 0) {
    sisterLookups.push(
      (async () => {
        const w0 = Date.now();
        try {
          const wdUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(wdBatchIds.join('|'))}&props=labels|descriptions|claims&languages=fr|en&format=json`;
          const res = await fetch(wdUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
          if (!res.ok) return;
          const json = (await res.json()) as any;
          const ent = wikidataWorkQid ? json?.entities?.[wikidataWorkQid] : json?.entities?.[wdBatchIds[0]];
          if (!ent) return;
          sourcesHit.push('wikidata');

          // Extraire tous les P1545 sur l'ensemble des œuvres liées (crucial pour Intégrales multi-P629 !)
          const extractP1545FromEntity = (wObj: any): string => {
            const p179Claims = Array.isArray(wObj?.claims?.P179) ? wObj.claims.P179 : [];
            for (const claim of p179Claims) {
              const qVal = claim?.qualifiers?.P1545?.[0]?.mainsnak?.datavalue?.value;
              if (qVal !== undefined && qVal !== null && String(qVal).trim()) {
                return String(qVal);
              }
            }
            const directVal = wObj?.claims?.P1545?.[0]?.mainsnak?.datavalue?.value;
            return directVal !== undefined && directVal !== null ? String(directVal) : '';
          };
          const isMultiWorkIntegral = wdBatchIds.length > 1;
          for (const qId of wdBatchIds) {
            const wObj = json?.entities?.[qId];
            if (!wObj) continue;
            const qOrd = extractP1545FromEntity(wObj);
            const normQOrd = qOrd ? normalizeSeriesNumber(qOrd) : '';
            if (isMultiWorkIntegral && normQOrd && /^\d+$/.test(normQOrd)) {
              includedVolumeNumbersHint.add(normQOrd);
            }
          }

          const p179Id = ent.claims?.P179?.[0]?.mainsnak?.datavalue?.value?.id;
          const rawEntOrd = extractP1545FromEntity(ent);
          const wdVol = isMultiWorkIntegral ? '' : normalizeSeriesNumber(rawEntOrd);
          let wdSeriesLabel = '';
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
              const rawBnfP268 = sEnt?.claims?.P268?.[0]?.mainsnak?.datavalue?.value;
              const cleanBnfP268 = rawBnfP268 ? String(rawBnfP268).replace(/\D/g, '') : '';
              // Attention : P268 sur Wikidata est le plus souvent un identifiant d'AUTORITÉ BnF (commençant par 1, ex: 14573759 pour Astérix)
              // et NON une notice bibliographique d'ensemble 460$3 (commençant par 3 ou 4). Ne l'enregistrer en ensembleId que si c'est une notice biblio !
              const validBibEnsId = /^[34]\d{6,}$/.test(cleanBnfP268) ? cleanBnfP268 : undefined;
              if (sLabel) {
                wdSeriesLabel = String(sLabel);
                registerSeriesVote('wikidata_p179', wdSeriesLabel, 3, {
                  wikidataQid: p179Id,
                  ensembleId: validBibEnsId
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
          tracer?.record(
            'C3',
            'api_wikidata',
            'ok',
            `Wikidata (${wdBatchIds.join(',')}) HTTP ${res.status} -> série « ${wdSeriesLabel || 'aucune'} », tomes « ${isMultiWorkIntegral ? Array.from(includedVolumeNumbersHint).join(',') : wdVol || '-'} »`,
            {
              request: { url: wdUrl, qids: wdBatchIds },
              result: { wdSeriesLabel, wikidataSeriesQid, wdVol, includedVols: Array.from(includedVolumeNumbersHint) }
            },
            Date.now() - w0
          );
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
    wikidataWorkQid: wdBatchIds.length <= 1 ? wikidataWorkQid : undefined,
    wikidataWorkQids,
    wikidataSeriesQid,
    inventaireWorkUri,
    includedVolumeNumbersHint: Array.from(includedVolumeNumbersHint).sort((a, b) => Number(a) - Number(b)),
    anchorIsIntegralHint: effectiveAnchorIntegral,
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
  integralOrdinal?: string;
} {
  const allTexts = [payload.anchorTitle, ...payload.rawTitles];
  const combined = allTexts.join(' | ');
  const combinedWithoutTexteIntegral = combined.replace(/\b(?:texte|version)\s+int[ée]grale?\b/gi, ' ');
  const desc = payload.description || '';

  // 1. Détection explicite d'intégrale / coffret / omnibus / plage de tomes (hors mention "texte intégral")
  const hasExplicitIntegralKeyword = /(?:l['’]?\s*int[ée]grale|\bint[ée]grale?\b|\bcoffret\b|\bomnibus\b|\bcompil\b|\bdouble\s+album\b|\b2\s+en\s+1\b|\btomes?\s+\d+\s*(?:[àa]|et|&|-|\/)\s*\d+)/i.test(
    combinedWithoutTexteIntegral
  );

  const nums = new Set<string>(payload.includedVolumeNumbersHint || []);
  for (const srcText of [combinedWithoutTexteIntegral, desc]) {
    // Exiger un mot-clé de volume/tome/intégrale avant la plage numérique pour ne jamais confondre un titre historique ("14-18", "39-45") avec une intégrale !
    const rangeMatch = /(?:tomes?|volumes?|vol\.?|albums?|int[ée]grale|coffret)\s*[:.n°#]?\s*(\d{1,2})\s*(?:[àa]|-|au)\s*(\d{1,2})\b/i.exec(srcText);
    if (rangeMatch) {
      const startN = parseInt(rangeMatch[1], 10);
      const endN = parseInt(rangeMatch[2], 10);
      if (startN > 0 && endN > startN && endN - startN <= 15) {
        for (let i = startN; i <= endN; i++) nums.add(String(i));
      }
    }
    const pairMatch = /\b(?:tomes?|volumes?|vol\.?|albums?)\s*(\d{1,2})\s*(?:et|&|\/|\+|,)\s*(\d{1,2})(?:\s*(?:et|&|,)\s*(\d{1,2}))?\b/i.exec(srcText);
    if (pairMatch) {
      for (const grp of [pairMatch[1], pairMatch[2], pairMatch[3]]) {
        if (grp) nums.add(String(parseInt(grp, 10)));
      }
    }
  }

  // Numéro d'intégrale (ex: "Intégrale 1", "Intégrale 02", "Coffret 2")
  const ordMatch = /(?:l['’]?\s*int[ée]grale|int[ée]grale|coffret|omnibus)\s*(?:n°\s*)?0*(\d{1,2})\b/i.exec(combined);
  const integralOrdinal = ordMatch ? String(parseInt(ordMatch[1], 10)) : payload.integralOrdinalHint;

  // 2. Détection Album Double (ex: "Astérix le Gaulois / La serpe d'or", "Titre A ; Titre B", "Titre A suivi de Titre B")
  // Ne jamais déclencher sur un simple sous-titre de one-shot ("Journal", "Enquête", "Roman", etc.) !
  let isDoubleAlbum = false;
  let doubleSubTitles: string[] = [];
  const primaryTitle = payload.anchorTitle || payload.rawTitles[0] || '';
  const slashParts = primaryTitle
    .split(/\s+\/\s+|\s+;\s+|\s+suivi\s+de\s+/i)
    .map((p) => cleanTitle(p))
    .filter(
      (p) =>
        p.length >= 4 &&
        !/^(?:ed\.?|edition|tome|vol|journal|enqu[êe]te|voyage|histoires|souvenirs|carnet|roman|essai|biographie|m[ée]moires|une?\s)/i.test(p)
    );
  const looksLikeTwoDistinctTitles =
    slashParts.length >= 2 &&
    slashParts.length <= 4 &&
    (payload.seriesCandidates.length > 0 ||
      /\b(?:tomes?|albums?|double|2\s+en\s+1)\b/i.test(primaryTitle) ||
      slashParts.every((p) => /^[A-ZÀ-ÖØ-Þ"«]/.test(p) && p.split(/\s+/).length >= 2));

  if (
    looksLikeTwoDistinctTitles &&
    normalizeTextKey(slashParts[0]) !== normalizeTextKey(slashParts[1]) &&
    (!payload.pageCount || payload.pageCount >= 64)
  ) {
    isDoubleAlbum = true;
    doubleSubTitles = slashParts;
  }

  const isIntegral = Boolean(
    payload.anchorIsIntegralHint || hasExplicitIntegralKeyword || isDoubleAlbum || nums.size >= 2
  );
  return {
    isIntegral,
    isDoubleAlbum,
    doubleSubTitles,
    includedVolumeNumbers: Array.from(nums).sort((a, b) => Number(a) - Number(b)),
    integralOrdinal
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
    userHint?: UserIngestHint;
    replaceSkeletonBookId?: string;
  }
): Promise<V4BookRecord> {
  const start = Date.now();
  const now = new Date().toISOString();
  const tracer = options.tracer;
  const userHint = options.userHint;

  // 1. Détection Intégrale & Album Double AVANT indexation (avec éventuel arbitrage explicite utilisateur)
  const integralCheck = detectIntegralAndIncludedVolumes(payload);
  if (userHint?.isIntegral === true) {
    integralCheck.isIntegral = true;
    if (Array.isArray(userHint.includedVolumeNumbers) && userHint.includedVolumeNumbers.length > 0) {
      const mergedVols = new Set<string>(integralCheck.includedVolumeNumbers);
      for (const rawVol of userHint.includedVolumeNumbers) {
        const norm = normalizeSeriesNumber(String(rawVol));
        if (norm) mergedVols.add(norm);
      }
      integralCheck.includedVolumeNumbers = Array.from(mergedVols).sort((a, b) => Number(a) - Number(b));
    }
  } else if (userHint?.isIntegral === false) {
    integralCheck.isIntegral = false;
    integralCheck.isDoubleAlbum = false;
  }

  // Si l'utilisateur a spécifié ou corrigé le nom de série, l'injecter avec un poids fort
  const seriesVotePool = [...payload.seriesCandidates];
  if (userHint?.series?.trim()) {
    const { coreKey, cleanDisplay } = stripEditorialCollectionSuffixes(cleanSeriesName(userHint.series));
    if (coreKey.length >= 2) {
      seriesVotePool.push({
        source: 'user_hint',
        rawName: userHint.series.trim(),
        coreKey,
        cleanDisplay: cleanDisplay || cleanSeriesName(userHint.series),
        weight: 5
      });
    }
  }

  // 2. Vote majoritaire par cluster sur la Série Canonique
  const electedSeries = electCanonicalSeriesFromVotes(seriesVotePool);
  if (electedSeries && electedSeries.confidenceRatio < 0.6) {
    tracer?.record(
      'C4',
      'series_majority_vote',
      'warn',
      `Consensus série fragile (${Math.round(electedSeries.confidenceRatio * 100)}% < 60%) pour « ${electedSeries.canonicalName} »`,
      { candidates: payload.seriesCandidates, electedSeries }
    );
  }

  // Upsert dans v4_series si série élue (matching par coreKey OU bnfEnsembleId OU wikidataQid)
  let seriesId: string | null = null;
  let seriesName: string | null = null;
  let resolvedSeriesWdQid: string | null = null;
  let canonicalSeriesIndex: CanonicalSeriesIndex | null = null;
  if (electedSeries) {
    let existingSeries = await db
      .prepare('SELECT * FROM v4_series WHERE normalized_core_key = ? LIMIT 1')
      .bind(electedSeries.coreKey)
      .first<Record<string, any>>();

    if (!existingSeries && electedSeries.wikidataQids[0]) {
      existingSeries = await db
        .prepare('SELECT * FROM v4_series WHERE wikidata_qid = ? LIMIT 1')
        .bind(electedSeries.wikidataQids[0])
        .first<Record<string, any>>();
    }
    if (!existingSeries && electedSeries.ensembleIds[0]) {
      existingSeries = await db
        .prepare('SELECT * FROM v4_series WHERE bnf_ensemble_ids_json LIKE ? LIMIT 1')
        .bind(`%${electedSeries.ensembleIds[0]}%`)
        .first<Record<string, any>>();
    }

    resolvedSeriesWdQid =
      (existingSeries?.wikidata_qid as string | null) ||
      electedSeries.wikidataQids[0] ||
      payload.wikidataSeriesQid ||
      null;

    // Résolveur canonique de série (Wikidata P179/P1545) : ordre officiel des tomes + nom propre FR
    if (resolvedSeriesWdQid) {
      canonicalSeriesIndex = await fetchCanonicalSeriesIndex(resolvedSeriesWdQid).catch(() => null);
    }

    // Réutiliser un éventuel URI de série existant dans catalog_entities pour garantir l'unification V4 <-> V2
    let existingCatalogSeriesUri: string | null = null;
    if (!existingSeries) {
      try {
        const allCatSeries = await db
          .prepare("SELECT uri, label FROM catalog_entities WHERE entity_type = 'serie'")
          .all<{ uri: string; label: string }>();
        const matchedCat = (allCatSeries.results || []).find(
          (row) => stripEditorialCollectionSuffixes(row.label).coreKey === electedSeries.coreKey
        );
        if (matchedCat?.uri) existingCatalogSeriesUri = matchedCat.uri;
      } catch {
        // Ignore si catalog_entities absent
      }
    }

    if (existingSeries) {
      seriesId = String(existingSeries.id);
      const currentDbSeriesName = String(existingSeries.canonical_name);
      const cleanerCandidate =
        canonicalSeriesIndex?.canonicalSeriesName &&
        isCleanerCanonicalSeriesName(canonicalSeriesIndex.canonicalSeriesName, currentDbSeriesName)
          ? canonicalSeriesIndex.canonicalSeriesName
          : isCleanerCanonicalSeriesName(electedSeries.canonicalName, currentDbSeriesName)
            ? electedSeries.canonicalName
            : null;
      seriesName = cleanerCandidate || currentDbSeriesName;

      const prevAliases = safeJsonParse<string[]>(existingSeries.aliases_json, []);
      const prevEns = safeJsonParse<string[]>(existingSeries.bnf_ensemble_ids_json, []);
      const prevAuthors = safeJsonParse<string[]>(existingSeries.primary_authors_json, []);
      const mergedAliases = Array.from(
        new Set([...prevAliases, ...electedSeries.aliases, electedSeries.canonicalName, currentDbSeriesName])
      ).filter((a) => a && a !== seriesName);
      const mergedEns = Array.from(new Set([...prevEns, ...electedSeries.ensembleIds]));
      const mergedAuthors = Array.from(new Set([...prevAuthors, ...payload.authors]));
      const mergedWdQid = resolvedSeriesWdQid;

      await db
        .prepare(
          `UPDATE v4_series
           SET canonical_name = ?, aliases_json = ?, bnf_ensemble_ids_json = ?, primary_authors_json = ?, wikidata_qid = COALESCE(wikidata_qid, ?), updated_at = ?
           WHERE id = ?`
        )
        .bind(
          seriesName,
          JSON.stringify(mergedAliases),
          JSON.stringify(mergedEns),
          JSON.stringify(mergedAuthors),
          mergedWdQid,
          now,
          seriesId
        )
        .run();
    } else {
      seriesId =
        existingCatalogSeriesUri ||
        `ser_${electedSeries.coreKey.replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 7)}`;
      seriesName =
        canonicalSeriesIndex?.canonicalSeriesName &&
        isCleanerCanonicalSeriesName(canonicalSeriesIndex.canonicalSeriesName, electedSeries.canonicalName)
          ? canonicalSeriesIndex.canonicalSeriesName
          : electedSeries.canonicalName;
      await db
        .prepare(
          `INSERT INTO v4_series
            (id, canonical_name, normalized_core_key, aliases_json, primary_authors_json, wikidata_qid, bnf_ensemble_ids_json, is_complete_expanded, known_volumes_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
           ON CONFLICT(normalized_core_key) DO UPDATE SET
             canonical_name = excluded.canonical_name,
             wikidata_qid = COALESCE(v4_series.wikidata_qid, excluded.wikidata_qid),
             updated_at = excluded.updated_at`
        )
        .bind(
          seriesId,
          seriesName,
          electedSeries.coreKey,
          JSON.stringify(electedSeries.aliases),
          JSON.stringify(payload.authors),
          resolvedSeriesWdQid,
          JSON.stringify(electedSeries.ensembleIds),
          now,
          now
        )
        .run();
      const confirmedSeries = await db
        .prepare('SELECT id FROM v4_series WHERE normalized_core_key = ? LIMIT 1')
        .bind(electedSeries.coreKey)
        .first<{ id: string }>();
      if (confirmedSeries?.id) seriesId = String(confirmedSeries.id);
    }
  }

  // 3. Résolution canonique du numéro de tome (Arbitrage utilisateur > Index canonique Wikidata > Vote pondéré éditions sœurs > Titre)
  const resolvedVolume = resolveCanonicalVolumeNumber({
    userHintVolume: userHint?.volumeNumber,
    wikidataWorkQid: payload.wikidataWorkQid,
    canonicalSeriesIndex,
    sisterEditions: payload.sisterEditions,
    rawTitles: [payload.anchorTitle, ...payload.rawTitles],
    seriesName: seriesName || undefined
  });
  const inheritedVolStr = resolvedVolume.volumeNumber;

  const preferredRawTitle =
    (userHint?.title?.trim() ? userHint.title.trim() : '') ||
    (integralCheck.isIntegral
      ? [payload.anchorTitle, ...payload.rawTitles].find((t) =>
          /\b(?:l['’]?\s*int[ée]grale|int[ée]grale|coffret|omnibus)\b/i.test(t)
        ) || payload.anchorTitle
      : payload.anchorTitle);
  const parsedAnchor = parseSeriesFromTitle(preferredRawTitle);
  let canonicalTitle = cleanTitle(
    integralCheck.isIntegral && /\b(?:int[ée]grale|coffret|omnibus)\b/i.test(preferredRawTitle)
      ? preferredRawTitle
      : parsedAnchor.title || preferredRawTitle
  );
  if (canonicalTitle && seriesName) {
    const escapedSeries = seriesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = canonicalTitle.replace(new RegExp(`^${escapedSeries}\\s*[-:–]\\s*`, 'i'), '').trim();
    if (integralCheck.isIntegral) {
      // Conserver un libellé complet et distinctif pour les Intégrales (ex: "Aya de Yopougon — Intégrale 1")
      if (stripped.length >= 3 && /\b(?:int[ée]grale|coffret|omnibus|tomes?\s+\d+)/i.test(stripped)) {
        const cap = stripped.charAt(0).toUpperCase() + stripped.slice(1);
        canonicalTitle = cap.toLowerCase().includes(seriesName.toLowerCase()) ? cap : `${seriesName} — ${cap}`;
      } else if (!/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(canonicalTitle)) {
        canonicalTitle = integralCheck.integralOrdinal
          ? `${seriesName} — Intégrale ${integralCheck.integralOrdinal}`
          : `${seriesName} — Intégrale`;
      }
    } else if (stripped.length >= 3) {
      // Retirer un éventuel préfixe "Astérix - " si déjà égal à la série sur tome unitaire
      canonicalTitle = stripped;
    }
  }

  const hasAuthoritativeVolume =
    Boolean(userHint?.volumeNumber?.trim()) ||
    resolvedVolume.source === 'wikidata_series_index' ||
    resolvedVolume.source === 'weighted_vote';
  const isExplicitHs =
    !hasAuthoritativeVolume &&
    /\b(hors[- ]s[ée]rie|n°\s*sp[ée]cial|num[ée]ro\s+sp[ée]cial|hs\b|making[- ]of|artbook|tome\s*0\b)/i.test(
      payload.rawTitles.join(' ')
    );
  let volumeNumber: number | null =
    !integralCheck.isIntegral && !isExplicitHs && inheritedVolStr ? parseInt(inheritedVolStr, 10) : null;
  if (volumeNumber !== null && (!Number.isFinite(volumeNumber) || volumeNumber <= 0)) {
    volumeNumber = null;
  }

  let volumeLabel: string | null = volumeNumber !== null ? String(volumeNumber) : null;
  if (integralCheck.isIntegral) {
    const inc = integralCheck.includedVolumeNumbers;
    if (inc.length >= 2) {
      volumeLabel = `Int. T.${inc[0]}-${inc[inc.length - 1]}`;
    } else if (integralCheck.integralOrdinal) {
      volumeLabel = `Int. ${integralCheck.integralOrdinal}`;
    } else {
      volumeLabel = 'Intégrale';
    }
  }

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

  // 5. Agrégation de tous les ISBN FR sœurs + éditionsCatalog + couverture exacte de l'édition choisie en priorité
  const knownIsbnsSet = new Set<string>([payload.anchorIsbn13]);
  const editionsCatalogMap = new Map<string, EditionCatalogEntry>();
  let exactBnfCover: string | undefined;
  let exactGbCover: string | undefined;
  let exactOlCover: string | undefined;
  let exactInvCover: string | undefined;
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
    const isExactAnchor = s.isbn13 === payload.anchorIsbn13;
    if (s.source === 'bnf' && s.coverUrl) {
      if (isExactAnchor && !exactBnfCover) exactBnfCover = s.coverUrl;
      if (!bnfCoverCandidate) bnfCoverCandidate = s.coverUrl;
    }
    if (s.source === 'google_books' && s.coverUrl) {
      if (isExactAnchor && !exactGbCover) exactGbCover = s.coverUrl;
      if (!gbCoverCandidate) gbCoverCandidate = s.coverUrl;
    }
    if (s.source === 'openlibrary' && s.coverUrl) {
      if (isExactAnchor && !exactOlCover) exactOlCover = s.coverUrl;
      if (!olCoverCandidate) olCoverCandidate = s.coverUrl;
    }
    if (s.source === 'inventaire' && s.coverUrl) {
      if (isExactAnchor && !exactInvCover) exactInvCover = s.coverUrl;
      if (!invCoverCandidate) invCoverCandidate = s.coverUrl;
    }
  }
  bnfCoverCandidate = exactBnfCover || bnfCoverCandidate;
  gbCoverCandidate = exactGbCover || gbCoverCandidate;
  invCoverCandidate = exactInvCover || invCoverCandidate;
  olCoverCandidate = exactOlCover || olCoverCandidate;
  if (!editionsCatalogMap.has(payload.anchorIsbn13)) {
    editionsCatalogMap.set(payload.anchorIsbn13, {
      isbn13: payload.anchorIsbn13,
      publisher: payload.publisher,
      publicationYear: payload.publishDate,
      coverUrl: bnfCoverCandidate || invCoverCandidate || userHint?.coverUrl
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
    invCoverCandidate ||
    gbCoverCandidate ||
    olCoverCandidate ||
    userHint?.coverUrl ||
    null;

  // 6. Clé canonique FRBR & Idempotence (anti-doublon à l'échelle de l'Œuvre)
  const normTitle = normalizeTextKey(canonicalTitle);
  const seriesCoreKey = electedSeries?.coreKey || '';
  let workCanonicalId = integralCheck.isIntegral
    ? `integral:${seriesCoreKey || normTitle}:${integralCheck.includedVolumeNumbers.join('-') || (integralCheck.integralOrdinal ? `int${integralCheck.integralOrdinal}` : payload.anchorIsbn13)}`
    : seriesId && volumeNumber !== null && !isHorsSerie
      ? `series:${seriesCoreKey}:vol:${volumeNumber}`
      : payload.wikidataWorkQid
        ? `wd:${payload.wikidataWorkQid}`
        : `work:${normTitle}:${normalizeTextKey(payload.authors[0] || payload.anchorIsbn13)}`;

  // Vérifier si ce Work existe déjà (par work_canonical_id, ou par series_id + volume_number)
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

  // GARDE CRITIQUE ANTI-ÉCRASEMENT : si un livre existant dans la série porte déjà ce volume_number
  // mais avec un titre d'album DISTINCTIF incompatible (ex: "L'île noire" vs "L'étoile mystérieuse" sur Tintin #10),
  // ne JAMAIS écraser l'œuvre existante ni mélanger leurs ISBNs/couvertures !
  if (
    existingBook &&
    !integralCheck.isIntegral &&
    seriesId &&
    areDistinctSeriesWorkTitles(String(existingBook.canonical_title || ''), canonicalTitle, seriesName)
  ) {
    tracer?.record(
      'C4',
      'volume_collision_guard',
      'warn',
      `Collision de numéro évitée dans « ${seriesName} » #${volumeNumber} : « ${canonicalTitle} » ≠ « ${existingBook.canonical_title} »`,
      {
        seriesId,
        volumeNumber,
        existingBookId: existingBook.id,
        existingTitle: existingBook.canonical_title,
        incomingTitle: canonicalTitle,
        volumeSource: resolvedVolume.source
      }
    );
    workCanonicalId = payload.wikidataWorkQid
      ? `series:${seriesCoreKey}:wd:${payload.wikidataWorkQid}`
      : `series:${seriesCoreKey}:vol:${volumeNumber}:${normTitle.slice(0, 40)}`;
    existingBook = await db
      .prepare('SELECT * FROM books WHERE work_canonical_id = ? LIMIT 1')
      .bind(workCanonicalId)
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
    if (seriesName && seriesId) {
      legacySeriesUri = await upsertCatalogEntity(db, {
        uri: seriesId,
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
    const legacyWorkSeriesNumber = integralCheck.isIntegral ? undefined : volumeLabel || undefined;
    const legacyWorkUri = await upsertCatalogEntity(db, {
      entityType: 'work',
      label: canonicalTitle,
      seriesUri: legacySeriesUri,
      seriesNumber: legacyWorkSeriesNumber,
      authorUris: legacyAuthorUris,
      mainCategory: classification.mainCategory,
      subgenres: classification.subgenres,
      imageUrl: effectiveCover || undefined,
      descriptions: payload.description ? { fr: payload.description } : {},
      claims: {
        'wdt:P31': ['wd:Q47461344'],
        ...(legacySeriesUri ? { 'wdt:P179': [legacySeriesUri] } : {}),
        ...(legacyWorkSeriesNumber ? { 'wdt:P1545': [legacyWorkSeriesNumber] } : {})
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fr', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_canonical_id) DO UPDATE SET
           canonical_title = excluded.canonical_title,
           normalized_title = excluded.normalized_title,
           series_id = COALESCE(excluded.series_id, books.series_id),
           series_name = COALESCE(excluded.series_name, books.series_name),
           volume_number = COALESCE(excluded.volume_number, books.volume_number),
           volume_label = COALESCE(excluded.volume_label, books.volume_label),
           is_hors_serie = excluded.is_hors_serie,
           hors_serie_label = excluded.hors_serie_label,
           is_integral = excluded.is_integral,
           integral_metadata_json = excluded.integral_metadata_json,
           parent_integrals_json = excluded.parent_integrals_json,
           authors_json = excluded.authors_json,
           known_isbns_json = excluded.known_isbns_json,
           editions_catalog_json = excluded.editions_catalog_json,
           selected_cover_url = COALESCE(excluded.selected_cover_url, books.selected_cover_url),
           main_category = excluded.main_category,
           subgenres_json = excluded.subgenres_json,
           updated_at = excluded.updated_at`
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
    const confirmedBook = await db
      .prepare('SELECT id FROM books WHERE work_canonical_id = ? LIMIT 1')
      .bind(workCanonicalId)
      .first<{ id: string }>();
    if (confirmedBook?.id) bookId = String(confirmedBook.id);
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

  // Si ce livre remplace un squelette C5 périmé ou changé de format, migrer les liaisons bibliothèque pour ne jamais perdre l'utilisateur
  // GARDE CRITIQUE V4-01 : ne jamais supprimer `replaceSkeletonBookId` s'il s'agit d'un autre tome déjà consolidé/possédé ayant un titre distinct !
  if (options.replaceSkeletonBookId && options.replaceSkeletonBookId !== bookId) {
    try {
      const oldBookRow = await db
        .prepare('SELECT id, canonical_title, known_isbns_json FROM books WHERE id = ? LIMIT 1')
        .bind(options.replaceSkeletonBookId)
        .first<{ id: string; canonical_title: string; known_isbns_json: string }>();
      const oldIsbns = safeJsonParse<string[]>(oldBookRow?.known_isbns_json, []);
      const isDistinctConsolidatedWork =
        oldBookRow &&
        areDistinctSeriesWorkTitles(oldBookRow.canonical_title, canonicalTitle, seriesName) &&
        oldIsbns.some((i) => i !== payload.anchorIsbn13);

      if (isDistinctConsolidatedWork) {
        // Ne détacher que l'ISBN courant sans détruire l'autre tome !
        const remainingIsbns = oldIsbns.filter((i) => !finalKnownIsbns.includes(i));
        await db
          .prepare('UPDATE books SET known_isbns_json = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(remainingIsbns), now, options.replaceSkeletonBookId)
          .run();
      } else {
        const oldLinks = await db
          .prepare('SELECT library_id, is_owned, is_wished, source_channel, added_at FROM v4_library_books WHERE book_id = ?')
          .bind(options.replaceSkeletonBookId)
          .all<{ library_id: string; is_owned: number; is_wished: number; source_channel: string | null; added_at: string }>();
        for (const oldLink of oldLinks.results || []) {
          await db
            .prepare(
              `INSERT INTO v4_library_books (library_id, book_id, is_owned, is_wished, source_channel, selected_cover_url, added_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(library_id, book_id) DO UPDATE SET
                 is_owned = MAX(v4_library_books.is_owned, excluded.is_owned),
                 is_wished = MAX(v4_library_books.is_wished, excluded.is_wished),
                 selected_cover_url = COALESCE(excluded.selected_cover_url, v4_library_books.selected_cover_url),
                 updated_at = excluded.updated_at`
            )
            .bind(
              oldLink.library_id,
              bookId,
              oldLink.is_owned,
              oldLink.is_wished,
              oldLink.source_channel || options.sourceChannel,
              effectiveCover,
              oldLink.added_at || now,
              now
            )
            .run();
        }
        await db.prepare('DELETE FROM v4_library_books WHERE book_id = ?').bind(options.replaceSkeletonBookId).run();
        await db.prepare('UPDATE book_isbn_index SET book_id = ?, is_integral = ? WHERE book_id = ?').bind(bookId, integralCheck.isIntegral ? 1 : 0, options.replaceSkeletonBookId).run();
        await db.prepare('DELETE FROM books WHERE id = ?').bind(options.replaceSkeletonBookId).run();
      }
    } catch {
      // Non-bloquant en environnement mock minimal
    }
  }
  try {
    await db
      .prepare("UPDATE enrichment_queue SET book_id = ?, status = 'done', last_error = NULL, updated_at = ? WHERE isbn13 = ?")
      .bind(bookId, now, payload.anchorIsbn13)
      .run();
  } catch {
    // Non-bloquant
  }

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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               ownership_status = excluded.ownership_status,
               deleted_at = NULL,
               updated_at = excluded.updated_at`
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
  tracer?: PipelineTracer,
  options?: { force?: boolean }
): Promise<number> {
  if (!book.seriesId || !book.seriesName) return 0;
  const start = Date.now();
  const now = new Date().toISOString();

  const sRow = await db
    .prepare('SELECT * FROM v4_series WHERE id = ? LIMIT 1')
    .bind(book.seriesId)
    .first<Record<string, any>>();
  if (!sRow) return 0;
  if (!options?.force && Number(sRow.is_complete_expanded) === 1) return 0;

  const rawEnsembleIds = safeJsonParse<string[]>(sRow.bnf_ensemble_ids_json, []);
  // Ne conserver que les notices bibliographiques d'ensemble 460$3 (commençant par 3 ou 4, et non les autorités P268 commençant par 1)
  const validEnsembleIds = new Set<string>(
    rawEnsembleIds
      .map((id) => String(id).replace(/\D/g, ''))
      .filter((id) => /^[34]\d{6,}$/.test(id))
  );
  const seriesWdIndex = sRow.wikidata_qid
    ? await fetchCanonicalSeriesIndex(String(sRow.wikidata_qid)).catch(() => null)
    : null;
  const targetCoreKey = String(sRow.normalized_core_key || stripEditorialCollectionSuffixes(book.seriesName).coreKey);
  const discoveredByWorkKey = new Map<
    string,
    {
      title: string;
      volumeNumber?: number;
      isbn13: string;
      coverUrl?: string;
      isIntegral?: boolean;
      score: number;
    }
  >();

  const registerCandidateFromRecord = (rec: string, isFromEns2Bib: boolean) => {
    const cand = extractMarcRecordMetadata(rec);
    if (!cand || !cand.isbn13 || !isStrictFrenchLanguage(cand.language)) return;
    if (!isFrancophoneBookIsbn13(cand.isbn13)) return;
    if (cand.bnfEnsembleId && /^[34]\d{6,}$/.test(cand.bnfEnsembleId)) {
      const candCore = cand.seriesRaw ? stripEditorialCollectionSuffixes(cand.seriesRaw).coreKey : '';
      if (isFromEns2Bib || (candCore && (candCore === targetCoreKey || candCore.includes(targetCoreKey) || targetCoreKey.includes(candCore)))) {
        validEnsembleIds.add(cand.bnfEnsembleId);
      }
    }

    if (!isFromEns2Bib) {
      const candSeriesCore = cand.seriesRaw ? stripEditorialCollectionSuffixes(cand.seriesRaw).coreKey : '';
      const candTitleCore = stripEditorialCollectionSuffixes(cand.title).coreKey;
      const matchesSeries =
        (candSeriesCore &&
          (candSeriesCore === targetCoreKey ||
            candSeriesCore.includes(targetCoreKey) ||
            targetCoreKey.includes(candSeriesCore) ||
            (targetCoreKey.length >= 4 && getLevenshteinDistance(candSeriesCore, targetCoreKey) <= 2))) ||
        (candTitleCore && (candTitleCore === targetCoreKey || candTitleCore.startsWith(`${targetCoreKey} `)));
      if (!matchesSeries) return;
    }

    const isIntSkel = Boolean(cand._isIntegral);
    let cleanSkelTitle = cleanTitle(isIntSkel ? cand.title : parseSeriesFromTitle(cand.title).title || cand.title);
    if (cleanSkelTitle && book.seriesName && !isIntSkel) {
      const escapedSeries = book.seriesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = cleanSkelTitle.replace(new RegExp(`^${escapedSeries}\\s*[-:–]\\s*`, 'i'), '').trim();
      if (stripped.length >= 3) cleanSkelTitle = stripped;
    }

    const resolvedSkelVol = !isIntSkel
      ? resolveCanonicalVolumeNumber({
          canonicalSeriesIndex: seriesWdIndex,
          sisterEditions: [cand],
          rawTitles: [cleanSkelTitle, cand.title],
          seriesName: book.seriesName || undefined
        }).volumeNumber
      : '';
    const vNum =
      !isIntSkel && resolvedSkelVol && /^\d+$/.test(resolvedSkelVol)
        ? parseInt(resolvedSkelVol, 10)
        : undefined;

    let candScore = 0;
    if (cand.coverUrl) candScore += 25;
    if (cand.isbn13.startsWith('9782') || cand.isbn13.startsWith('97910')) candScore += 15;
    if (cand.publishDate && /^\d{4}$/.test(cand.publishDate)) {
      candScore += Math.min(35, Math.max(0, (parseInt(cand.publishDate, 10) - 1950) * 0.4));
    }

    const baseKey = isIntSkel
      ? `int:${normalizeTextKey(cleanSkelTitle)}`
      : vNum !== undefined
        ? `vol:${vNum}`
        : `title:${normalizeTextKey(cleanSkelTitle)}`;
    const existing = discoveredByWorkKey.get(baseKey);
    if (
      existing &&
      vNum !== undefined &&
      areDistinctSeriesWorkTitles(existing.title, cleanSkelTitle, book.seriesName)
    ) {
      const altKey = `${baseKey}:${normalizeTextKey(cleanSkelTitle).slice(0, 32)}`;
      const altExisting = discoveredByWorkKey.get(altKey);
      if (!altExisting || candScore > altExisting.score) {
        discoveredByWorkKey.set(altKey, {
          title: cleanSkelTitle,
          volumeNumber: vNum,
          isbn13: cand.isbn13,
          coverUrl: cand.coverUrl || altExisting?.coverUrl,
          isIntegral: isIntSkel,
          score: candScore
        });
      }
      return;
    }

    if (!existing || candScore > existing.score) {
      discoveredByWorkKey.set(baseKey, {
        title: cleanSkelTitle,
        volumeNumber: vNum,
        isbn13: cand.isbn13,
        coverUrl: cand.coverUrl || existing?.coverUrl,
        isIntegral: isIntSkel,
        score: candScore
      });
    } else if (!existing.coverUrl && cand.coverUrl) {
      existing.coverUrl = cand.coverUrl;
    }
  };

  // Phase 5A-1 : Requête BnF `bib.ens2bib` si un ensemble bibliographique 460$3 valide est connu
  if (validEnsembleIds.size > 0) {
    try {
      const ensQuery = Array.from(validEnsembleIds)
        .slice(0, 4)
        .map((id) => `bib.ens2bib any "${id}"`)
        .join(' or ');
      const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(`(${ensQuery}) and (bib.doctype all "a")`)}&recordSchema=intermarcxchange&maximumRecords=45&startRecord=1`;
      const res = await fetchWithTimeoutAndRetry(bnfUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
      if (res.ok) {
        const xml = await res.text();
        for (const rec of xml.split('<srw:record>').slice(1)) {
          registerCandidateFromRecord(rec, true);
        }
      }
    } catch {
      // Non-bloquant
    }
  }

  // Phase 5A-2 : Repli/complément automatique BnF SRU :
  // - si `ens2bib` a retourné < 3 tomes (Astérix sans 460$3), requête avec puis sans auteur ;
  // - ou si < 30 tomes ET auteur connu : passe ciblée `(Série + Auteur)` pour récupérer les tomes récents oubliés du 460$3
  //   (ex: Animal Jack T.11 « Nuit sans sommeil » catalogué en 295$a / 295$v sans 460$3).
  if (discoveredByWorkKey.size < 30) {
    const cleanSeriesQuery = book.seriesName.replace(/["()]/g, ' ').trim();
    const primaryAuthors = safeJsonParse<string[]>(sRow.primary_authors_json, []);
    const firstAuthorLast = extractAuthorLastNameForBnfCql(book.authors[0] || primaryAuthors[0]);
    const prevEnsCount = validEnsembleIds.size;

    const runSeriesFallbackCql = async (cql: string) => {
      try {
        const sruUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=45&startRecord=1`;
        const res = await fetchWithTimeoutAndRetry(sruUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
        if (!res.ok) return;
        const xml = await res.text();
        for (const rec of xml.split('<srw:record>').slice(1)) {
          registerCandidateFromRecord(rec, false);
        }
      } catch {
        // Non-bloquant
      }
    };

    if (cleanSeriesQuery.length >= 2) {
      if (firstAuthorLast) {
        await runSeriesFallbackCql(
          `(bib.anywhere all "${cleanSeriesQuery}") and (bib.author all "${firstAuthorLast}") and (bib.doctype all "a")`
        );
      }
      if (discoveredByWorkKey.size < 3) {
        await runSeriesFallbackCql(`(bib.anywhere all "${cleanSeriesQuery}") and (bib.doctype all "a")`);
      }
      // Si la passe de repli a permis de découvrir de vrais 460$3 (ensemble bibliographique), aspirer tous les tomes rattachés !
      if (validEnsembleIds.size > prevEnsCount && discoveredByWorkKey.size < 18) {
        try {
          const ensQuery = Array.from(validEnsembleIds)
            .slice(0, 4)
            .map((id) => `bib.ens2bib any "${id}"`)
            .join(' or ');
          const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(`(${ensQuery}) and (bib.doctype all "a")`)}&recordSchema=intermarcxchange&maximumRecords=50&startRecord=1`;
          const res = await fetchWithTimeoutAndRetry(bnfUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
          if (res.ok) {
            const xml = await res.text();
            for (const rec of xml.split('<srw:record>').slice(1)) {
              registerCandidateFromRecord(rec, true);
            }
          }
        } catch {
          // Non-bloquant
        }
      }
    }
  }

  const discoveredSkeleton = Array.from(discoveredByWorkKey.values());
  let queuedCount = 0;
  for (const skel of discoveredSkeleton) {
    if (!skel.isbn13) continue;
    const already = await db
      .prepare('SELECT book_id FROM book_isbn_index WHERE isbn13 = ? LIMIT 1')
      .bind(skel.isbn13)
      .first<{ book_id: string }>();
    if (already) continue;

    // Squelette léger immédiat dans books + book_isbn_index puis enrichissement complet mis en queue pour le CRON
    let skelCanonId = skel.isIntegral
      ? `integral:${sRow.normalized_core_key}:${skel.isbn13}`
      : skel.volumeNumber
        ? `series:${sRow.normalized_core_key}:vol:${skel.volumeNumber}`
        : `work:${normalizeTextKey(skel.title)}:${skel.isbn13}`;

    // Vérifier si un tome existe déjà sur cette clé canonique (ou ce numéro de tome dans la série)
    let existingWork = await db
      .prepare('SELECT id, canonical_title, known_isbns_json FROM books WHERE work_canonical_id = ? LIMIT 1')
      .bind(skelCanonId)
      .first<{ id: string; canonical_title: string; known_isbns_json: string }>();
    if (!existingWork && !skel.isIntegral && skel.volumeNumber) {
      existingWork = await db
        .prepare('SELECT id, canonical_title, known_isbns_json FROM books WHERE series_id = ? AND volume_number = ? AND is_integral = 0 LIMIT 1')
        .bind(book.seriesId, skel.volumeNumber)
        .first<{ id: string; canonical_title: string; known_isbns_json: string }>();
    }

    if (existingWork) {
      if (
        !skel.isIntegral &&
        areDistinctSeriesWorkTitles(existingWork.canonical_title, skel.title, book.seriesName)
      ) {
        // Deux albums distincts portant le même numéro dans des éditions différentes : créer une clé séparée sans écraser le tome existant
        skelCanonId = `series:${sRow.normalized_core_key}:vol:${skel.volumeNumber}:${normalizeTextKey(skel.title).slice(0, 40)}`;
        existingWork = await db
          .prepare('SELECT id, canonical_title, known_isbns_json FROM books WHERE work_canonical_id = ? LIMIT 1')
          .bind(skelCanonId)
          .first<{ id: string; canonical_title: string; known_isbns_json: string }>();
      }
    }

    if (existingWork?.id) {
      // Le tome existe déjà dans `books` : indexer cet ISBN supplémentaire sur l'œuvre existante SANS l'envoyer en replaceSkeletonBookId !
      const prevIsbns = safeJsonParse<string[]>(existingWork.known_isbns_json, []);
      if (!prevIsbns.includes(skel.isbn13)) {
        prevIsbns.push(skel.isbn13);
        await db
          .prepare('UPDATE books SET known_isbns_json = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(prevIsbns), now, existingWork.id)
          .run();
      }
      await db
        .prepare('INSERT OR IGNORE INTO book_isbn_index (isbn13, book_id, is_integral, created_at) VALUES (?, ?, ?, ?)')
        .bind(skel.isbn13, existingWork.id, skel.isIntegral ? 1 : 0, now)
        .run();
      continue;
    }

    const skelBookId = `bk_${generateTraceId('').replace(/^_/, '')}_${Math.random().toString(36).slice(2, 6)}`;
    const skelVolLabel = skel.isIntegral ? 'Intégrale' : skel.volumeNumber ? String(skel.volumeNumber) : null;

    await db
      .prepare(
        `INSERT OR IGNORE INTO books
          (id, work_canonical_id, canonical_title, normalized_title, series_id, series_name,
           volume_number, volume_label, is_hors_serie, is_integral, authors_json, language,
           known_isbns_json, editions_catalog_json, selected_cover_url, main_category, subgenres_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fr', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        skelBookId,
        skelCanonId,
        skel.title,
        normalizeTextKey(skel.title),
        book.seriesId,
        book.seriesName,
        skel.isIntegral ? null : skel.volumeNumber ?? null,
        skelVolLabel,
        skel.isIntegral || skel.volumeNumber ? 0 : 1,
        skel.isIntegral ? 1 : 0,
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
        .prepare('INSERT OR IGNORE INTO book_isbn_index (isbn13, book_id, is_integral, created_at) VALUES (?, ?, ?, ?)')
        .bind(skel.isbn13, insertedOrExisting.id, skel.isIntegral ? 1 : 0, now)
        .run();

      if (insertedOrExisting.id === skelBookId) {
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
  }

  const totalCountRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM books WHERE series_id = ?')
    .bind(book.seriesId)
    .first<{ cnt: number }>();
  const finalSeriesCount = Number(totalCountRow?.cnt || 0);
  const markExpanded = discoveredSkeleton.length > 0 || finalSeriesCount > 1 ? 1 : 0;

  await db
    .prepare(
      `UPDATE v4_series
       SET is_complete_expanded = ?,
           bnf_ensemble_ids_json = ?,
           known_volumes_count = ?,
           series_checked_at = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      markExpanded,
      JSON.stringify(Array.from(validEnsembleIds)),
      finalSeriesCount,
      now,
      now,
      book.seriesId
    )
    .run();

  tracer?.record(
    'C5',
    'series_skeleton_and_queue',
    'ok',
    `Squelette série « ${book.seriesName} » : ${discoveredSkeleton.length} tome(s) détecté(s), ${queuedCount} mis en file enrichment_queue (total série: ${finalSeriesCount})`,
    { seriesId: book.seriesId, discovered: discoveredSkeleton.length, queuedCount, finalSeriesCount },
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
  const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await db
    .prepare(
      `UPDATE enrichment_queue
       SET status = CASE WHEN attempts >= 3 THEN 'error' ELSE 'pending' END,
           last_error = COALESCE(last_error, 'Timeout processing > 15m')
       WHERE status = 'processing' AND updated_at < ?`
    )
    .bind(staleCutoff)
    .run()
    .catch(() => {});

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
          tracer,
          replaceSkeletonBookId: row.book_id || undefined
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
    const firstAuthorLast = extractAuthorLastNameForBnfCql(authors[0]);
    if (title.length < 3) {
      await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
      continue;
    }

    try {
      const cql = firstAuthorLast
        ? `(bib.title all "${title}") and (bib.author all "${firstAuthorLast}") and (bib.doctype all "a")`
        : `(bib.title all "${title}") and (bib.doctype all "a")`;
      const sruUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=10&startRecord=1`;
      const res = await fetchWithTimeoutAndRetry(sruUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
      if (!res.ok) {
        await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
        continue;
      }
      const xml = await res.text();
      const existingIsbns = new Set(safeJsonParse<string[]>(row.known_isbns_json, []));
      const added: string[] = [];
      const rowIsIntegral = Number(row.is_integral) === 1;
      const rowVolStr = row.volume_number !== null && row.volume_number !== undefined ? String(row.volume_number) : '';

      for (const rec of xml.split('<srw:record>').slice(1)) {
        const cand = extractMarcRecordMetadata(rec);
        if (!cand?.isbn13 || !isStrictFrenchLanguage(cand.language)) continue;
        if (!isbnUtil.isValidBookBarcode(cand.isbn13) || !isFrancophoneBookIsbn13(cand.isbn13) || existingIsbns.has(cand.isbn13)) continue;
        if (Boolean(cand._isIntegral) !== rowIsIntegral) continue;
        const candVol = normalizeSeriesNumber(cand.volumeNumber || parseSeriesFromTitle(cand.title).seriesNumber || '');
        if (rowVolStr && candVol && candVol !== rowVolStr) continue;
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
            .bind(isbn13, row.id, rowIsIntegral ? 1 : 0, now)
        );
        await db.batch(stmts);
        newIsbnsIndexed += added.length;
      } else {
        await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
      }
    } catch {
      await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run().catch(() => {});
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
    hints?: Record<string, UserIngestHint>;
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
    let staleSkeletonBookId: string | undefined;
    const rawUserHint = params.hints?.[rawInput] || params.hints?.[activeIsbn13];
    for (const cand of norm.isbn13Candidates) {
      const candHint = params.hints?.[cand] || rawUserHint;
      const l2 = await checkBookIndexLayer2(db, cand, params.libraryId, tracer, { userHint: candHint });
      if (l2.staleSkeletonBookId) staleSkeletonBookId = l2.staleSkeletonBookId;
      if (l2.status !== 'FULL_MISS') {
        resolvedL2 = l2;
        activeIsbn13 = cand;
        break;
      }
    }

    if (resolvedL2 && resolvedL2.book) {
      // Lier à la bibliothèque si nouvel ajout demandé et pas déjà intégralement couvert/possédé
      if (
        params.libraryId &&
        params.action &&
        params.action !== 'preview' &&
        (resolvedL2.status === 'LOCAL_UNOWNED' ||
          resolvedL2.status === 'SERVER_CATALOG_HIT' ||
          (params.action === 'owned' && resolvedL2.status === 'PARTIAL_INTEGRAL_OWNED'))
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

      // Si la série du livre n'a pas encore été étendue en Couche 5, l'étendre même sur un HIT Couche 2 !
      if (resolvedL2.book.seriesId && subrequestBudgetUsed <= 2) {
        await enqueueOrExpandSeriesLayer5(db, resolvedL2.book, tracer).catch(() => 0);
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

    // Consolider d'abord en mode preview pour que postCheck puisse détecter INCLUDED_IN_INTEGRAL / PARTIAL_INTEGRAL_OWNED avant liaison bibliothèque
    const consolidated = await consolidateBookLayer4(db, staging, {
      sourceChannel: params.sourceChannel,
      libraryId: params.libraryId,
      action: 'preview',
      tracer,
      userHint: params.hints?.[activeIsbn13] || rawUserHint,
      replaceSkeletonBookId: staleSkeletonBookId
    });

    // Re-vérifier Couche 2 après consolidation pour remonter d'éventuelles détections bidirectionnelles (intégrale trouvée a posteriori)
    const postCheck = params.libraryId
      ? await checkBookIndexLayer2(db, activeIsbn13, params.libraryId)
      : null;

    if (
      params.libraryId &&
      params.action &&
      params.action !== 'preview' &&
      (!postCheck ||
        postCheck.status === 'LOCAL_UNOWNED' ||
        postCheck.status === 'SERVER_CATALOG_HIT' ||
        (params.action === 'owned' && postCheck.status === 'PARTIAL_INTEGRAL_OWNED'))
    ) {
      await linkBookToLibrary(db, {
        libraryId: params.libraryId,
        bookId: consolidated.id,
        legacyEntityUri: consolidated.legacyEntityUri,
        isOwned: params.action === 'owned',
        isWished: params.action === 'wishlist',
        sourceChannel: params.sourceChannel,
        coverUrl: consolidated.selectedCoverUrl
      });
    }

    // Couche 5 : Squelette rapide + file d'attente
    let queuedCount = 0;
    if (subrequestBudgetUsed <= 3) {
      queuedCount = await enqueueOrExpandSeriesLayer5(db, consolidated, tracer);
    }

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

// ============================================================================
// SYNCHRONISATION DIFFÉRENTIELLE & LECTURE V4 PURE (books + v4_series + v4_library_books)
// ============================================================================

export interface V4SyncBookItem {
  book: V4BookRecord;
  ownershipStatus: 'owned' | 'wish' | 'none';
}

export interface V4SyncResponse {
  books: V4SyncBookItem[];
  serverTime: string;
}

export interface V4SeriesBooksResponse {
  series: {
    id: string;
    canonicalName: string;
    wikidataQid?: string | null;
    aliases: string[];
  } | null;
  books: V4SyncBookItem[];
}

/**
 * Retourne les fiches Livre consolidées V4 liées à la bibliothèque de l'utilisateur
 * (livres possédés, wishlist, ET tous les autres tomes des séries suivies),
 * avec filtrage différentiel optionnel par `since` (ISO-8601).
 */
export async function syncV4LibraryBooks(
  db: DatabaseBinding,
  params: { libraryId: string; since?: string | null }
): Promise<V4SyncResponse> {
  const serverTime = new Date().toISOString();
  const since = params.since?.trim() || null;

  // 1. Récupérer tous les liens bibliothèque de l'utilisateur (avec ses surcharges privées)
  const linkRows = await db
    .prepare(
      `SELECT book_id, is_owned, is_wished, selected_cover_url, custom_overrides_json, updated_at
       FROM v4_library_books
       WHERE library_id = ?`
    )
    .bind(params.libraryId)
    .all<{
      book_id: string;
      is_owned: number;
      is_wished: number;
      selected_cover_url?: string | null;
      custom_overrides_json?: string | null;
      updated_at: string;
    }>();

  const statusByBookId = new Map<
    string,
    {
      status: 'owned' | 'wish' | 'none';
      selectedCoverUrl?: string | null;
      customOverridesJson?: string | null;
      updatedAt: string;
    }
  >();
  for (const row of linkRows.results || []) {
    const status: 'owned' | 'wish' | 'none' =
      Number(row.is_owned) === 1 ? 'owned' : Number(row.is_wished) === 1 ? 'wish' : 'none';
    statusByBookId.set(String(row.book_id), {
      status,
      selectedCoverUrl: row.selected_cover_url ?? null,
      customOverridesJson: row.custom_overrides_json ?? null,
      updatedAt: String(row.updated_at || '')
    });
  }

  // 2. Récupérer les livres directement liés (possédés/souhaités/modifiés en privé) + tous les livres des séries suivies par l'utilisateur
  const bookRows = await db
    .prepare(
      `SELECT DISTINCT b.*
       FROM books b
       LEFT JOIN v4_library_books lb ON lb.book_id = b.id AND lb.library_id = ?
       WHERE (lb.book_id IS NOT NULL AND (lb.is_owned = 1 OR lb.is_wished = 1 OR lb.custom_overrides_json IS NOT NULL))
          OR (
            b.series_id IS NOT NULL
            AND b.series_id IN (
              SELECT DISTINCT b2.series_id
              FROM books b2
              JOIN v4_library_books lb2 ON lb2.book_id = b2.id
              WHERE lb2.library_id = ? AND (lb2.is_owned = 1 OR lb2.is_wished = 1) AND b2.series_id IS NOT NULL
            )
          )
       ORDER BY b.updated_at DESC
       LIMIT 600`
    )
    .bind(params.libraryId, params.libraryId)
    .all<Record<string, any>>();

  const items: V4SyncBookItem[] = [];
  for (const row of bookRows.results || []) {
    const link = statusByBookId.get(String(row.id));
    const book = applyLibraryOverridesToBook(
      mapBookRow(row),
      link?.selectedCoverUrl,
      link?.customOverridesJson
    );
    const maxUpdatedAt = link && link.updatedAt > book.updatedAt ? link.updatedAt : book.updatedAt;
    if (since && maxUpdatedAt && maxUpdatedAt <= since) {
      continue;
    }
    items.push({
      book,
      ownershipStatus: link?.status || 'none'
    });
  }

  return {
    books: items,
    serverTime
  };
}

/**
 * Retourne directement tous les tomes V4 consolidés d'une série (`books` + statut de possession),
 * sans passer par l'ancien modèle V2 `catalog_entities` / `series-list`.
 */
export async function getV4SeriesBooks(
  db: DatabaseBinding,
  params: { seriesId: string; libraryId?: string | null }
): Promise<V4SeriesBooksResponse> {
  const sRow = await db
    .prepare('SELECT id, canonical_name, wikidata_qid, aliases_json, is_complete_expanded, primary_authors_json FROM v4_series WHERE id = ? LIMIT 1')
    .bind(params.seriesId)
    .first<Record<string, any>>();

  const querySeriesBookRows = () =>
    db
      .prepare(
        `SELECT b.*,
                COALESCE(lb.is_owned, 0) AS lib_is_owned,
                COALESCE(lb.is_wished, 0) AS lib_is_wished,
                lb.selected_cover_url AS lib_selected_cover_url,
                lb.custom_overrides_json AS lib_custom_overrides_json
         FROM books b
         LEFT JOIN v4_library_books lb ON lb.book_id = b.id AND lb.library_id = ?
         WHERE b.series_id = ?
            OR (lb.library_id = ? AND lb.custom_overrides_json LIKE ?)
         ORDER BY b.is_integral ASC, b.is_hors_serie ASC, COALESCE(b.volume_number, 9999) ASC, b.canonical_title ASC`
      )
      .bind(params.libraryId || '__none__', params.seriesId, params.libraryId || '__none__', `%${params.seriesId}%`)
      .all<Record<string, any>>();

  let bookRows = await querySeriesBookRows();
  const initialRows = bookRows.results || [];
  const unownedCount = initialRows.filter((r) => Number(r.lib_is_owned) === 0 && Number(r.is_integral) === 0).length;

  // Si la série n'a pas encore été étendue (ou si seuls les tomes possédés étaient présents suite à un lot volumineux ou un ancien P268 d'autorité),
  // lancer immédiatement l'expansion Couche 5 (avec repli SRU série) afin que TOUS les tomes de la collection soient téléchargés !
  if (sRow && (Number(sRow.is_complete_expanded) === 0 || initialRows.length <= 1 || unownedCount === 0)) {
    const seedBook: V4BookRecord = initialRows[0]
      ? mapBookRow(initialRows[0])
      : {
          id: `seed_${sRow.id}`,
          workCanonicalId: `seed:${sRow.id}`,
          canonicalTitle: String(sRow.canonical_name),
          normalizedTitle: normalizeTextKey(String(sRow.canonical_name)),
          seriesId: String(sRow.id),
          seriesName: String(sRow.canonical_name),
          volumeNumber: 1,
          volumeLabel: '1',
          isHorsSerie: false,
          horsSerieLabel: null,
          isIntegral: false,
          integralMetadata: { includedVolumeNumbers: [], includedWorkIds: [], includedIsbns: [] },
          parentIntegrals: [],
          authors: safeJsonParse<string[]>(sRow.primary_authors_json, []),
          language: 'fr',
          knownIsbns: [],
          editionsCatalog: [],
          selectedCoverUrl: null,
          mainCategory: 'BD',
          subgenres: [],
          legacyEntityUri: null,
          updatedAt: new Date().toISOString()
        };
    await enqueueOrExpandSeriesLayer5(db, seedBook, undefined, { force: true }).catch(() => 0);
    bookRows = await querySeriesBookRows();
  }

  const items: V4SyncBookItem[] = (bookRows.results || [])
    .map((row) => {
      const ownershipStatus: 'owned' | 'wish' | 'none' =
        Number(row.lib_is_owned) === 1 ? 'owned' : Number(row.lib_is_wished) === 1 ? 'wish' : 'none';
      return {
        book: applyLibraryOverridesToBook(
          mapBookRow(row),
          row.lib_selected_cover_url ?? null,
          row.lib_custom_overrides_json ?? null
        ),
        ownershipStatus
      };
    })
    .filter(
      (item) =>
        item.book.seriesId === params.seriesId &&
        !(item.book.hiddenSeriesIds || []).includes(params.seriesId)
    );

  return {
    series: sRow
      ? {
          id: String(sRow.id),
          canonicalName: String(sRow.canonical_name),
          wikidataQid: sRow.wikidata_qid ?? null,
          aliases: safeJsonParse<string[]>(sRow.aliases_json, [])
        }
      : null,
    books: items
  };
}

/**
 * Option B : Enregistre les modifications éditées par l'utilisateur (`BookEdit.vue`) uniquement
 * comme surcharges privées de son foyer (`v4_library_books.selected_cover_url` + `custom_overrides_json`),
 * en laissant la fiche de référence commune (`books`) immuable pour les autres utilisateurs.
 */
export async function updateV4BookMetadata(
  db: DatabaseBinding,
  params: {
    bookId?: string | null;
    uri?: string | null;
    isbn13?: string | null;
    libraryId?: string | null;
    title?: string;
    authors?: string[];
    series?: string;
    seriesId?: string | null;
    seriesNumber?: string;
    publisher?: string;
    publishDate?: string;
    coverUrl?: string;
    genres?: string[];
  }
): Promise<V4BookRecord | null> {
  const now = new Date().toISOString();
  let existingRow: Record<string, any> | null = null;

  if (params.bookId) {
    existingRow = await db.prepare('SELECT * FROM books WHERE id = ? LIMIT 1').bind(params.bookId).first();
  }
  if (!existingRow && params.uri) {
    existingRow = await db
      .prepare('SELECT * FROM books WHERE legacy_entity_uri = ? LIMIT 1')
      .bind(params.uri)
      .first();
  }
  if (!existingRow && params.isbn13) {
    const cleanIsbn = isbnUtil.normalize(params.isbn13);
    if (cleanIsbn) {
      existingRow = await db
        .prepare(
          `SELECT b.*
           FROM book_isbn_index bi
           JOIN books b ON b.id = bi.book_id
           WHERE bi.isbn13 = ?
           LIMIT 1`
        )
        .bind(cleanIsbn)
        .first();
    }
  }
  if (!existingRow && params.uri?.startsWith('isbn:')) {
    const cleanIsbn = isbnUtil.normalize(params.uri.slice(5));
    if (cleanIsbn) {
      existingRow = await db
        .prepare(
          `SELECT b.*
           FROM book_isbn_index bi
           JOIN books b ON b.id = bi.book_id
           WHERE bi.isbn13 = ?
           LIMIT 1`
        )
        .bind(cleanIsbn)
        .first();
    }
  }

  if (!existingRow) return null;

  const bookId = String(existingRow.id);
  const baseBook = mapBookRow(existingRow);

  // Si aucun libraryId n'est fourni, ne pas altérer la table centrale `books`
  if (!params.libraryId) {
    return baseBook;
  }

  const existingLink = await db
    .prepare(
      'SELECT is_owned, is_wished, selected_cover_url, custom_overrides_json FROM v4_library_books WHERE library_id = ? AND book_id = ? LIMIT 1'
    )
    .bind(params.libraryId, bookId)
    .first<{
      is_owned: number;
      is_wished: number;
      selected_cover_url?: string | null;
      custom_overrides_json?: string | null;
    }>();

  const currentOverrides = existingLink?.custom_overrides_json
    ? safeJsonParse<LibraryBookOverrides>(existingLink.custom_overrides_json, {})
    : {};

  const nextOverrides: LibraryBookOverrides = { ...currentOverrides };

  if (params.title?.trim() && params.title.trim() !== baseBook.canonicalTitle) {
    nextOverrides.title = params.title.trim();
  } else if (params.title?.trim() === baseBook.canonicalTitle) {
    delete nextOverrides.title;
  }

  if (Array.isArray(params.authors) && params.authors.length > 0) {
    const cleanAuthors = params.authors.map((a) => a.trim()).filter(Boolean);
    if (cleanAuthors.length > 0) {
      nextOverrides.authors = cleanAuthors;
    }
  }

  // Gestion série privée du foyer (création/résolution non destructrice de v4_series si nouvelle série saisie)
  let nextSeriesId: string | null = (nextOverrides.seriesId !== undefined ? nextOverrides.seriesId : baseBook.seriesId) ?? null;
  if (params.series !== undefined) {
    const cleanSeries = params.series.trim();
    if (!cleanSeries) {
      nextSeriesId = null;
      nextOverrides.seriesId = null;
      nextOverrides.seriesName = null;
    } else {
      const { coreKey, cleanDisplay } = stripEditorialCollectionSuffixes(cleanSeriesName(cleanSeries));
      const targetName = cleanDisplay || cleanSeries;
      let sRow = params.seriesId
        ? await db.prepare('SELECT id, canonical_name FROM v4_series WHERE id = ? LIMIT 1').bind(params.seriesId).first<Record<string, any>>()
        : null;
      if (!sRow && coreKey) {
        sRow = await db.prepare('SELECT id, canonical_name FROM v4_series WHERE normalized_core_key = ? LIMIT 1').bind(coreKey).first<Record<string, any>>();
      }
      if (sRow) {
        nextSeriesId = String(sRow.id);
        nextOverrides.seriesId = nextSeriesId;
        nextOverrides.seriesName = String(sRow.canonical_name);
      } else {
        nextSeriesId = params.seriesId || `ser_${(coreKey || normalizeTextKey(targetName)).replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 7)}`;
        nextOverrides.seriesId = nextSeriesId;
        nextOverrides.seriesName = targetName;
        await db
          .prepare(
            `INSERT OR IGNORE INTO v4_series
              (id, canonical_name, normalized_core_key, aliases_json, primary_authors_json, bnf_ensemble_ids_json, is_complete_expanded, known_volumes_count, created_at, updated_at)
             VALUES (?, ?, ?, '[]', ?, '[]', 0, 1, ?, ?)`
          )
          .bind(nextSeriesId, targetName, coreKey || normalizeTextKey(targetName), JSON.stringify(nextOverrides.authors || baseBook.authors), now, now)
          .run();
      }
    }
  }

  // Gestion numéro de tome privée
  const isRowIntegral = Number(existingRow.is_integral) === 1;
  if (params.seriesNumber !== undefined) {
    const cleanNum = params.seriesNumber.trim();
    if (!nextSeriesId || !cleanNum) {
      nextOverrides.volumeNumber = null;
      nextOverrides.volumeLabel = isRowIntegral ? baseBook.volumeLabel : null;
      nextOverrides.isHorsSerie = Boolean(nextSeriesId && !isRowIntegral);
    } else if (isRowIntegral) {
      nextOverrides.volumeNumber = null;
      nextOverrides.volumeLabel = cleanNum;
      nextOverrides.isHorsSerie = false;
    } else {
      const normNum = normalizeSeriesNumber(cleanNum);
      if (normNum && /^\d+$/.test(normNum)) {
        const parsed = parseInt(normNum, 10);
        nextOverrides.volumeNumber = parsed;
        nextOverrides.volumeLabel = String(parsed);
        nextOverrides.isHorsSerie = false;
      } else {
        nextOverrides.volumeNumber = null;
        nextOverrides.volumeLabel = cleanNum;
        nextOverrides.isHorsSerie = true;
      }
    }
  }

  if (params.publisher !== undefined) {
    nextOverrides.publisher = params.publisher.trim() || undefined;
  }
  if (params.publishDate !== undefined) {
    nextOverrides.publicationYear = params.publishDate.trim() || undefined;
  }

  if (Array.isArray(params.genres) && params.genres.length > 0) {
    nextOverrides.mainCategory = params.genres[0];
    nextOverrides.subgenres = params.genres.slice(1);
  }

  const nextCoverUrl =
    params.coverUrl !== undefined
      ? params.coverUrl.trim() || null
      : (existingLink?.selected_cover_url ?? null);

  const overridesJson = JSON.stringify(nextOverrides);

  await db
    .prepare(
      `INSERT INTO v4_library_books (library_id, book_id, is_owned, is_wished, source_channel, selected_cover_url, custom_overrides_json, added_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual_edit', ?, ?, ?, ?)
       ON CONFLICT(library_id, book_id) DO UPDATE SET
         selected_cover_url = excluded.selected_cover_url,
         custom_overrides_json = excluded.custom_overrides_json,
         updated_at = excluded.updated_at`
    )
    .bind(
      params.libraryId,
      bookId,
      existingLink ? Number(existingLink.is_owned) : 0,
      existingLink ? Number(existingLink.is_wished) : 0,
      nextCoverUrl,
      overridesJson,
      now,
      now
    )
    .run();

  // Propager les genres modifiés uniquement aux autres tomes de la série DANS LA BIBLIOTHÈQUE DU FOYER (`v4_library_books`)
  if (Array.isArray(params.genres) && params.genres.length > 0 && nextSeriesId) {
    const siblingLinks = await db
      .prepare(
        `SELECT lb.book_id, lb.custom_overrides_json
         FROM v4_library_books lb
         JOIN books b ON b.id = lb.book_id
         WHERE lb.library_id = ? AND b.series_id = ? AND lb.book_id != ?`
      )
      .bind(params.libraryId, nextSeriesId, bookId)
      .all<{ book_id: string; custom_overrides_json?: string | null }>()
      .catch(() => ({ results: [] as Array<{ book_id: string; custom_overrides_json?: string | null }> }));

    for (const sib of siblingLinks.results || []) {
      const sibOv = sib.custom_overrides_json
        ? safeJsonParse<LibraryBookOverrides>(sib.custom_overrides_json, {})
        : {};
      sibOv.mainCategory = params.genres[0];
      sibOv.subgenres = params.genres.slice(1);
      await db
        .prepare(
          'UPDATE v4_library_books SET custom_overrides_json = ?, updated_at = ? WHERE library_id = ? AND book_id = ?'
        )
        .bind(JSON.stringify(sibOv), now, params.libraryId, sib.book_id)
        .run()
        .catch(() => {});
    }
  }

  return applyLibraryOverridesToBook(baseBook, nextCoverUrl, overridesJson);
}

/**
 * Option B : Exclut un tome d'une série uniquement pour le foyer (`v4_library_books`),
 * sans impacter la série commune des autres utilisateurs.
 * - Si le tome est non possédé, l'ajoute à `hiddenFromSeriesIds` (disparaît de la série du foyer).
 * - Si `detachOwned` est vrai (tome possédé/souhaité mal classé), le détache également en one-shot (`seriesId = null`).
 */
export async function excludeBookFromSeriesForLibrary(
  db: DatabaseBinding,
  params: {
    libraryId: string;
    seriesId: string;
    bookId?: string | null;
    uri?: string | null;
    isbn13?: string | null;
    detachOwned?: boolean;
  }
): Promise<V4BookRecord | null> {
  if (!params.libraryId || !params.seriesId) return null;
  const now = new Date().toISOString();

  let existingRow: Record<string, any> | null = null;
  if (params.bookId) {
    existingRow = await db.prepare('SELECT * FROM books WHERE id = ? LIMIT 1').bind(params.bookId).first();
  }
  if (!existingRow && params.uri) {
    existingRow = await db.prepare('SELECT * FROM books WHERE legacy_entity_uri = ? LIMIT 1').bind(params.uri).first();
  }
  const cleanIsbn = params.isbn13
    ? isbnUtil.normalize(params.isbn13)
    : params.uri?.startsWith('isbn:')
      ? isbnUtil.normalize(params.uri.slice(5))
      : '';
  if (!existingRow && cleanIsbn) {
    existingRow = await db
      .prepare(
        `SELECT b.*
         FROM book_isbn_index bi
         JOIN books b ON b.id = bi.book_id
         WHERE bi.isbn13 = ?
         LIMIT 1`
      )
      .bind(cleanIsbn)
      .first();
  }
  if (!existingRow) return null;

  const bookId = String(existingRow.id);
  const baseBook = mapBookRow(existingRow);

  const existingLink = await db
    .prepare(
      'SELECT is_owned, is_wished, selected_cover_url, custom_overrides_json FROM v4_library_books WHERE library_id = ? AND book_id = ? LIMIT 1'
    )
    .bind(params.libraryId, bookId)
    .first<{
      is_owned: number;
      is_wished: number;
      selected_cover_url?: string | null;
      custom_overrides_json?: string | null;
    }>();

  const currentOv = existingLink?.custom_overrides_json
    ? safeJsonParse<LibraryBookOverrides>(existingLink.custom_overrides_json, {})
    : {};
  const hiddenSet = new Set<string>(currentOv.hiddenFromSeriesIds || []);
  hiddenSet.add(params.seriesId);

  const nextOv: LibraryBookOverrides = {
    ...currentOv,
    hiddenFromSeriesIds: Array.from(hiddenSet)
  };
  if (params.detachOwned || (existingLink && (Number(existingLink.is_owned) === 1 || Number(existingLink.is_wished) === 1))) {
    nextOv.seriesId = null;
    nextOv.seriesName = null;
    nextOv.volumeNumber = null;
    nextOv.volumeLabel = null;
    nextOv.isHorsSerie = false;
  }

  const overridesJson = JSON.stringify(nextOv);
  await db
    .prepare(
      `INSERT INTO v4_library_books (library_id, book_id, is_owned, is_wished, source_channel, selected_cover_url, custom_overrides_json, added_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual_edit', ?, ?, ?, ?)
       ON CONFLICT(library_id, book_id) DO UPDATE SET
         custom_overrides_json = excluded.custom_overrides_json,
         updated_at = excluded.updated_at`
    )
    .bind(
      params.libraryId,
      bookId,
      existingLink ? Number(existingLink.is_owned) : 0,
      existingLink ? Number(existingLink.is_wished) : 0,
      existingLink?.selected_cover_url ?? null,
      overridesJson,
      now,
      now
    )
    .run();

  return applyLibraryOverridesToBook(baseBook, existingLink?.selected_cover_url ?? null, overridesJson);
}
