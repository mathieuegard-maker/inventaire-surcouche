// src/core/services/v4/v4-shared.ts
// Types, helpers réseau, normalisation ISBN et mappers partagés du pipeline FRBR V4.

import type { EditionCatalogEntry, IntegralMetadata, ParentIntegralRef } from '../../types';
import { cleanTitle, normalizeTextKey } from '../../resolvers/bnf.resolver';
import { isbnUtil } from '../../utils/isbn.util';

export const USER_AGENT_BASE = 'BiblioCollectionPWA/4.0 (mathieu.egard@gmail.com)';

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
  wishedByUserId?: string | null;
  wishedByName?: string | null;
  updatedAt: string;
}

export interface SisterEditionCandidate {
  source: 'bnf' | 'inventaire' | 'wikidata' | 'openlibrary' | 'google_books';
  isbn13?: string;
  title: string;
  authors?: string[];
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

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseIntegralMetadataDb(raw: string | null | undefined): IntegralMetadata {
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

export function serializeIntegralMetadataDb(meta: IntegralMetadata): string {
  return JSON.stringify({
    included_volume_numbers: Array.from(new Set(meta.includedVolumeNumbers)),
    included_work_ids: Array.from(new Set(meta.includedWorkIds)),
    included_isbns: Array.from(new Set(meta.includedIsbns))
  });
}

export function mapBookRow(row: Record<string, any>): V4BookRecord {
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
export function applyLibraryOverridesToBook(
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

export function isStrictFrenchLanguage(lang?: string): boolean {
  if (!lang) return true; // BnF / sources sans balise explicite tolérées seulement si pas marquées étrangères
  const low = lang.trim().toLowerCase();
  return low === 'fr' || low === 'fre' || low === 'fra' || low.startsWith('fr-') || low === 'french';
}


export function isPlausibleVolumeNumberStr(vol?: string): boolean {
  if (!vol) return false;
  if (/^\d+$/.test(vol)) {
    const n = Number(vol);
    return n > 0 && n <= 150;
  }
  return vol.length <= 6;
}

export function isIntegralCandidateTitleOrPages(
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

