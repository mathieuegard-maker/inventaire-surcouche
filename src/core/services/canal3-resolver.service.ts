// src/core/services/canal3-resolver.service.ts
// Service Back-End utilitaire du Canal 3 (résolution Texte / OCR -> ISBN-13 FR + alternatives d'éditions)
// 100 % portable sur DatabaseBinding + fetch() standard (zéro dépendance propriétaire Cloudflare).

import type { DatabaseBinding } from '../adapters/storage-db.interface';
import {
  cleanAuthor,
  cleanPublishDate,
  cleanPublisher,
  cleanTitle,
  isFrancophoneBookIsbn13,
  normalizeSeriesNumber,
  normalizeTextKey,
  parseIntermarcRecord,
  parseSeriesFromTitle,
  type BnfHintQuery
} from '../resolvers/bnf.resolver';
import { rankCanal3Consensus, type Canal3RankedOption, type Canal3ScoredInput } from '../bibliographic/canal3-consensus';
import type { ExternalBookMetadata } from '../types';
import { imageUtil } from '../utils/image.util';
import { isbnUtil } from '../utils/isbn.util';
import { PipelineTracer } from './pipeline-logger.service';
import {
  extractAuthorLastNameForBnfCql,
  fetchWithTimeoutAndRetry,
  isGoogleBooksCircuitOpen,
  searchLocalBooksForCanal3,
  tripGoogleBooksCircuit,
  type SourceChannel
} from './v4-pipeline.service';

const USER_AGENT_BASE = 'BiblioCollectionPWA/4.0 (mathieu.egard@gmail.com)';

export type Canal3ResolutionOption = Canal3RankedOption;

export interface Canal3ResolveResponse {
  isbn13?: string;
  knownIsbns?: string[];
  meta?: ExternalBookMetadata;
  sourcesCount: number;
  isDoubt: boolean;
  alternatives: Canal3ResolutionOption[];
  resolvedVia: 'server_d1' | 'multi_source' | 'none';
}

function normalizeToIsbn13(raw?: string): string | undefined {
  if (!raw || !isbnUtil.isValidFormat(raw)) return undefined;
  const clean = isbnUtil.normalize(raw);
  if (!clean) return undefined;
  return clean.length === 10 ? isbnUtil.toIsbn13(clean) : clean;
}

async function fetchBnfByCql(cql: string, maxRecords = 18): Promise<ExternalBookMetadata[]> {
  const url = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=${maxRecords}&startRecord=1`;
  try {
    const res = await fetchWithTimeoutAndRetry(url, { timeoutMs: 4800, retriesOn5xx: 1 });
    if (!res.ok) return [];
    const xml = await res.text();
    const records = xml.split('<srw:record>').slice(1);
    const out: ExternalBookMetadata[] = [];
    for (const rec of records) {
      const parsed = parseIntermarcRecord(rec, { includeIntegrals: true });
      if (!parsed || !parsed.isbn) continue;
      const isbn13 = normalizeToIsbn13(parsed.isbn);
      if (!isbn13 || !isFrancophoneBookIsbn13(isbn13)) continue;
      if (parsed._lang && parsed._lang !== 'fre') continue;
      out.push({ ...parsed, isbn: isbn13 });
    }
    return out;
  } catch {
    return [];
  }
}

async function searchBnfServerByHints(hints: BnfHintQuery): Promise<ExternalBookMetadata[]> {
  const cleanTerm = (val?: string) => (val || '').replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim();
  const title = cleanTerm(hints.title);
  const series = cleanTerm(hints.series);
  const vol = normalizeSeriesNumber(hints.volumeNumber);
  const authorLast = extractAuthorLastNameForBnfCql(hints.author || hints.illustrator);
  const publisher = cleanTerm(hints.publisher);

  const queries: string[] = [];
  if (title && publisher) {
    const clauses = [`(bib.title all "${title}")`, `(bib.publisher all "${publisher}")`, `(bib.doctype all "a")`];
    if (authorLast) clauses.splice(1, 0, `(bib.author all "${authorLast}")`);
    queries.push(clauses.join(' and '));
  }
  if (title && authorLast) {
    queries.push(`(bib.title all "${title}") and (bib.author all "${authorLast}") and (bib.doctype all "a")`);
  }
  if (series && vol) {
    const combinedSeriesTitle = title && normalizeTextKey(title) !== normalizeTextKey(series)
      ? `${series} ${title} ${vol}`
      : `${series} ${vol}`;
    const clauses = [`(bib.anywhere all "${combinedSeriesTitle}")`, `(bib.doctype all "a")`];
    if (authorLast) clauses.splice(1, 0, `(bib.author all "${authorLast}")`);
    if (publisher) clauses.splice(1, 0, `(bib.publisher all "${publisher}")`);
    queries.push(clauses.join(' and '));
  } else if (title && vol && !series) {
    const pubClause = publisher ? ` and (bib.publisher all "${publisher}")` : '';
    queries.push(`(bib.anywhere all "${title} ${vol}")${pubClause} and (bib.doctype all "a")`);
  }
  if (title && queries.length === 0) {
    queries.push(`(bib.title all "${title}") and (bib.doctype all "a")`);
  }

  const primaryResults = await Promise.all(queries.slice(0, 2).map((cql) => fetchBnfByCql(cql, 18)));
  let merged = primaryResults.flat();

  // Repli sans contrainte d'auteur ni d'éditeur (et en conservant titre + série) si trop peu de résultats
  if (merged.length < 2 && (title || series)) {
    const distinctParts: string[] = [];
    if (series) distinctParts.push(series);
    if (title && normalizeTextKey(title) !== normalizeTextKey(series)) distinctParts.push(title);
    if (vol) distinctParts.push(vol);
    const fallbackTerm = distinctParts.join(' ').trim();
    if (fallbackTerm) {
      const fallbackCql = `(bib.anywhere all "${fallbackTerm}") and (bib.doctype all "a")`;
      const fallback = await fetchBnfByCql(fallbackCql, 18);
      merged = [...merged, ...fallback];
    }
    // Second repli sur les mots significatifs >= 4 lettres si l'OCR contenait un mot parasite
    if (merged.length === 0 && (title || series)) {
      const sigWords = `${series} ${title}`
        .split(/\s+/)
        .map((w) => w.replace(/[^a-zA-ZÀ-ÿ0-9]/g, ''))
        .filter((w) => w.length >= 4)
        .slice(0, 3);
      if (sigWords.length >= 1) {
        const relaxedTerm = [...sigWords, vol].filter(Boolean).join(' ').trim();
        const relaxed = await fetchBnfByCql(`(bib.anywhere all "${relaxedTerm}") and (bib.doctype all "a")`, 15);
        merged = [...merged, ...relaxed];
      }
    }
  }

  // Déduplication par ISBN-13
  const byIsbn = new Map<string, ExternalBookMetadata>();
  for (const m of merged) {
    if (!byIsbn.has(m.isbn)) byIsbn.set(m.isbn, m);
  }
  return Array.from(byIsbn.values());
}

async function searchOpenLibraryServerByHints(hints: BnfHintQuery): Promise<ExternalBookMetadata[]> {
  const qParts = [hints.series, hints.title, hints.volumeNumber, hints.author].filter(Boolean);
  const q = qParts.join(' ').trim();
  if (q.length < 2) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3200);
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=8&fields=title,author_name,isbn,publisher,first_publish_year,cover_i`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT_BASE },
      signal: controller.signal
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { docs?: any[] };
    const out: ExternalBookMetadata[] = [];
    for (const doc of data.docs || []) {
      const isbns: string[] = Array.isArray(doc.isbn) ? doc.isbn : [];
      const frIsbn = isbns
        .map((raw) => normalizeToIsbn13(String(raw)))
        .find((c): c is string => Boolean(c && isFrancophoneBookIsbn13(c)));
      if (!frIsbn) continue;
      const rawTitle = cleanTitle(String(doc.title || ''));
      if (!rawTitle) continue;
      const parsed = parseSeriesFromTitle(rawTitle);
      const coverUrl = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined;
      out.push({
        isbn: frIsbn,
        title: parsed.title || rawTitle,
        authors: Array.isArray(doc.author_name) ? doc.author_name.map((a: any) => cleanAuthor(String(a))).filter(Boolean) : [],
        publisher: Array.isArray(doc.publisher) && doc.publisher[0] ? cleanPublisher(String(doc.publisher[0])) : undefined,
        publishDate: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
        coverUrl,
        series: parsed.series,
        seriesNumber: parsed.seriesNumber
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchGoogleBooksServerByHints(hints: BnfHintQuery): Promise<ExternalBookMetadata[]> {
  if (isGoogleBooksCircuitOpen()) return [];
  const qParts = [hints.series, hints.title, hints.volumeNumber, hints.author].filter(Boolean);
  const q = qParts.join(' ').trim();
  if (q.length < 2) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&langRestrict=fr&maxResults=6`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT_BASE },
      signal: controller.signal
    });
    if (res.status === 429) {
      tripGoogleBooksCircuit();
      return [];
    }
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: any[] };
    const out: ExternalBookMetadata[] = [];
    for (const item of data.items || []) {
      const info = item?.volumeInfo;
      if (!info?.title) continue;
      const ids: any[] = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [];
      const rawIsbn =
        ids.find((x) => x.type === 'ISBN_13')?.identifier ||
        ids.find((x) => x.type === 'ISBN_10')?.identifier;
      const frIsbn = normalizeToIsbn13(rawIsbn);
      if (!frIsbn || !isFrancophoneBookIsbn13(frIsbn)) continue;
      const rawTitle = cleanTitle(String(info.title));
      const parsed = parseSeriesFromTitle(rawTitle);
      const thumb = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail;
      out.push({
        isbn: frIsbn,
        title: parsed.title || rawTitle,
        authors: Array.isArray(info.authors) ? info.authors.map((a: any) => cleanAuthor(String(a))).filter(Boolean) : [],
        publisher: info.publisher ? cleanPublisher(String(info.publisher)) : undefined,
        publishDate: info.publishedDate ? cleanPublishDate(String(info.publishedDate)) : undefined,
        pageCount: info.pageCount,
        coverUrl: thumb ? String(thumb).replace(/^http:\/\//i, 'https://') : undefined,
        series: parsed.series,
        seriesNumber: parsed.seriesNumber
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Résout une requête Canal 3 (texte libre ou fiche OCR Canal 4) côté Back-End :
 * Passe 1 : D1 local (`books` / `v4_series`),
 * Passe 2 : BnF SRU + OpenLibrary (+ Google Books si circuit fermé), scoring & consensus multi-sources.
 */
export async function resolveBookHintsCanal3(
  db: DatabaseBinding,
  hints: BnfHintQuery,
  options: {
    aiConfidence?: 'high' | 'medium' | 'low';
    sourceChannel?: SourceChannel;
    userId?: string | null;
    skipLocalD1?: boolean;
  } = {}
): Promise<Canal3ResolveResponse> {
  const start = Date.now();
  const tracer = new PipelineTracer({
    userId: options.userId || null,
    sourceChannel: options.sourceChannel || 'canal_4_ai_photo'
  });

  // Passe 1 : Recherche D1 locale (< 20 ms, 0 appel API externe)
  if (!options.skipLocalD1) {
    const localHits = await searchLocalBooksForCanal3(db, {
      title: hints.title,
      series: hints.series,
      author: hints.author,
      volumeNumber: hints.volumeNumber
    }).catch(() => []);

    const bestLocal = localHits[0];
    if (bestLocal && bestLocal.score >= 55 && bestLocal.isbn13) {
      const fallbacks = imageUtil.buildCoverCandidates(bestLocal.isbn13, [bestLocal.coverUrl]);
      const meta: ExternalBookMetadata = {
        isbn: bestLocal.isbn13,
        title: bestLocal.title,
        authors: bestLocal.authors,
        coverUrl: bestLocal.coverUrl || fallbacks[0],
        coverFallbackUrls: fallbacks,
        series: bestLocal.seriesName,
        seriesNumber: bestLocal.volumeNumber !== null && bestLocal.volumeNumber !== undefined ? String(bestLocal.volumeNumber) : undefined
      };
      const alt: Canal3ResolutionOption = {
        isbn13: bestLocal.isbn13,
        title: meta.title,
        authors: meta.authors,
        coverUrl: meta.coverUrl,
        coverFallbackUrls: fallbacks,
        series: meta.series,
        seriesNumber: meta.seriesNumber,
        score: bestLocal.score,
        sourcesCount: 1
      };
      tracer.record(
        'C3',
        'canal3_server_resolve',
        'ok',
        `Canal 3 D1-HIT (${hints.title || hints.series || '?'}${hints.volumeNumber ? ` #${hints.volumeNumber}` : ''}) -> ${bestLocal.isbn13}`,
        { hints, localHit: bestLocal },
        Date.now() - start
      );
      await tracer.flush(db).catch(() => {});
      return {
        isbn13: bestLocal.isbn13,
        knownIsbns: [bestLocal.isbn13],
        meta,
        sourcesCount: 1,
        isDoubt: false,
        alternatives: [alt],
        resolvedVia: 'server_d1'
      };
    }
  }

  // Passe 2 : Multi-source parallèle côté serveur (BnF SRU + OpenLibrary + Google Books si actif)
  const [bnfList, olList, gbList] = await Promise.all([
    searchBnfServerByHints(hints),
    searchOpenLibraryServerByHints(hints),
    searchGoogleBooksServerByHints(hints)
  ]);

  const inputs: Canal3ScoredInput[] = [
    ...bnfList.map((meta) => ({ source: 'bnf' as const, meta })),
    ...olList.map((meta) => ({ source: 'openlibrary' as const, meta })),
    ...gbList.map((meta) => ({ source: 'google' as const, meta }))
  ];
  const consensus = rankCanal3Consensus({
    inputs,
    hints,
    aiConfidence: options.aiConfidence
  });

  if (!consensus.isbn13 || !consensus.meta) {
    tracer.record(
      'C3',
      'canal3_server_resolve',
      'warn',
      `Canal 3 serveur échec sur « ${hints.title || hints.series || '?'} » (BnF:${bnfList.length}/OL:${olList.length}/GB:${gbList.length})`,
      { hints, bnfCount: bnfList.length, olCount: olList.length, gbCount: gbList.length },
      Date.now() - start
    );
    await tracer.flush(db).catch(() => {});
    return { sourcesCount: 0, isDoubt: false, alternatives: [], resolvedVia: 'none' };
  }

  tracer.record(
    'C3',
    'canal3_server_resolve',
    consensus.isDoubt ? 'warn' : 'ok',
    `Canal 3 serveur (${hints.title || hints.series || '?'}${hints.volumeNumber ? ` #${hints.volumeNumber}` : ''}) -> ${consensus.isbn13} (score ${Math.round(consensus.topScore)}, BnF:${bnfList.length}/OL:${olList.length}/GB:${gbList.length})`,
    {
      hints,
      selected: {
        isbn13: consensus.isbn13,
        title: consensus.meta.title,
        series: consensus.meta.series,
        vol: consensus.meta.seriesNumber,
        score: consensus.topScore
      },
      alternativesCount: consensus.alternatives.length
    },
    Date.now() - start
  );
  await tracer.flush(db).catch(() => {});

  return {
    isbn13: consensus.isbn13,
    knownIsbns: consensus.knownIsbns,
    meta: consensus.meta,
    sourcesCount: consensus.sourcesCount,
    isDoubt: consensus.isDoubt,
    alternatives: consensus.alternatives,
    resolvedVia: 'multi_source'
  };
}
