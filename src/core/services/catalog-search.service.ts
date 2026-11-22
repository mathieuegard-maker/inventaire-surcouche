// src/core/services/catalog-search.service.ts
// Moteur backend dédié à la Recherche Catalogue exhaustive (distinct du Canal 3 OCR mono-livre).
// Retourne deux blocs structurés : `series` (séries correspondantes) et `books` (œuvres/albums distincts),
// sans court-circuit à 1 résultat ni plafond OCR à 10 fiches.
// 100 % portable sur DatabaseBinding + fetch() standard.

import type { DatabaseBinding } from '../adapters/storage-db.interface';
import { isEditorialOrPublisherCollection } from '../bibliographic/work-identity';
import {
  cleanSeriesName,
  isFrancophoneBookIsbn13,
  normalizeSeriesNumber,
  normalizeTextKey,
  parseIntermarcRecord
} from '../resolvers/bnf.resolver';
import { stripEditorialCollectionSuffixes } from '../utils/series-matcher.util';
import { imageUtil } from '../utils/image.util';
import { isbnUtil } from '../utils/isbn.util';
import {
  extractAuthorLastNameForBnfCql,
  fetchWithTimeoutAndRetry,
  scheduleBnfSruCall
} from './v4-pipeline.service';

export interface CatalogSearchQuery {
  q?: string;
  title?: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  edition?: string;
  publisher?: string;
}

export interface CatalogSearchSeriesHit {
  id: string;
  name: string;
  coreKey: string;
  authors: string[];
  coverUrl?: string;
  volumesCount: number;
  ownedCount: number;
  source: 'local' | 'bnf' | 'inventaire';
  isMaterializedInLocal: boolean;
}

export interface CatalogSearchBookHit {
  uri: string;
  bookId?: string;
  isbn13?: string;
  title: string;
  authors: string[];
  publisher?: string;
  publishDate?: string;
  series?: string;
  seriesId?: string;
  seriesNumber?: string;
  coverUrl?: string;
  coverFallbackUrls?: string[];
  isIntegral?: boolean;
  includedVolumeNumbers?: string[];
  ownershipStatus: 'owned' | 'wish' | 'none';
  source: 'local' | 'bnf' | 'openlibrary';
  score: number;
}

export interface CatalogSearchResponse {
  series: CatalogSearchSeriesHit[];
  books: CatalogSearchBookHit[];
  totalSeries: number;
  totalBooks: number;
}

const USER_AGENT = 'BiblioCollectionPWA/4.0 (mathieu.egard@gmail.com)';

function safeJsonArray<T = string>(raw?: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanCqlTerm(val?: string): string {
  return String(val || '')
    .replace(/['’"()!?,;:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeToIsbn13(raw?: string): string | undefined {
  if (!raw || !isbnUtil.isValidFormat(raw)) return undefined;
  const clean = isbnUtil.normalize(raw);
  if (!clean) return undefined;
  return clean.length === 10 ? isbnUtil.toIsbn13(clean) : clean;
}

async function fetchBnfCatalogRecords(cql: string, maxRecords = 45): Promise<
  Array<{
    isbn13: string;
    title: string;
    authors: string[];
    series?: string;
    seriesNumber?: string;
    publisher?: string;
    publishDate?: string;
    coverUrl?: string;
    isIntegral?: boolean;
    includedVolumeNumbers?: string[];
  }>
> {
  const url = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=${maxRecords}&startRecord=1`;
  try {
    await scheduleBnfSruCall(220);
    const res = await fetchWithTimeoutAndRetry(url, { timeoutMs: 6500, retriesOn5xx: 1 });
    if (!res.ok) return [];
    const xml = await res.text();
    const records = xml.split('<srw:record>').slice(1);
    const out: Array<{
      isbn13: string;
      title: string;
      authors: string[];
      series?: string;
      seriesNumber?: string;
      publisher?: string;
      publishDate?: string;
      coverUrl?: string;
      isIntegral?: boolean;
      includedVolumeNumbers?: string[];
    }> = [];

    for (const rec of records) {
      const parsed = parseIntermarcRecord(rec, { includeIntegrals: true });
      if (!parsed || !parsed.isbn) continue;
      const isbn13 = normalizeToIsbn13(parsed.isbn);
      if (!isbn13 || !isFrancophoneBookIsbn13(isbn13)) continue;
      if (parsed._lang && parsed._lang !== 'fre') continue;

      const rawSeries = parsed.series?.trim();
      const cleanedSeries =
        rawSeries && !isEditorialOrPublisherCollection(rawSeries, parsed.publisher)
          ? stripEditorialCollectionSuffixes(cleanSeriesName(rawSeries)).cleanDisplay || rawSeries
          : undefined;

      out.push({
        isbn13,
        title: parsed.title || 'Titre inconnu',
        authors: parsed.authors || [],
        series: cleanedSeries,
        seriesNumber: parsed.seriesNumber,
        publisher: parsed.publisher,
        publishDate: parsed.publishDate,
        coverUrl: parsed.coverUrl,
        isIntegral: Boolean(parsed.isIntegral || parsed._isIntegral)
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function searchInventaireSeriesPublic(term: string): Promise<
  Array<{ id: string; name: string; coverUrl?: string }>
> {
  const clean = term.trim();
  if (clean.length < 2) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const url = `https://inventaire.io/api/search?types=series&search=${encodeURIComponent(clean)}&lang=fr&limit=12`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: Array<Record<string, any>> };
    const out: Array<{ id: string; name: string; coverUrl?: string }> = [];
    for (const r of data.results || []) {
      const uri = String(r.uri || '').trim();
      const label = String(r.label || '').trim();
      if (!uri || !label) continue;
      const rawImg = typeof r.image === 'string' ? r.image : r.image?.url;
      const coverUrl = rawImg
        ? rawImg.startsWith('http')
          ? rawImg
          : `https://inventaire.io${rawImg.startsWith('/') ? '' : '/'}${rawImg}`
        : undefined;
      out.push({ id: uri, name: label, coverUrl });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function buildWorkDedupKey(book: {
  title: string;
  series?: string;
  seriesNumber?: string;
  authors: string[];
  isIntegral?: boolean;
}): string {
  const seriesKey = book.series ? stripEditorialCollectionSuffixes(cleanSeriesName(book.series)).coreKey : '';
  const volNorm = normalizeSeriesNumber(book.seriesNumber);
  if (seriesKey && volNorm && !book.isIntegral) {
    return `sv:${seriesKey}#${volNorm}`;
  }
  const titleKey = normalizeTextKey(book.title);
  const authorKey = book.authors[0] ? normalizeTextKey(book.authors[0]).split(' ').pop() || '' : '';
  return `ta:${seriesKey}|${titleKey}|${authorKey}|${book.isIntegral ? 'int' : 'std'}`;
}

export async function searchCatalogExhaustive(
  db: DatabaseBinding,
  query: CatalogSearchQuery,
  libraryId?: string | null
): Promise<CatalogSearchResponse> {
  const q = cleanCqlTerm(query.q);
  const title = cleanCqlTerm(query.title);
  const series = cleanCqlTerm(query.series);
  const vol = normalizeSeriesNumber(query.volumeNumber);
  const author = cleanCqlTerm(query.author);
  const edition = cleanCqlTerm(query.edition);
  const publisher = cleanCqlTerm(query.publisher);

  const primaryText = series || title || q || author;
  if (!primaryText && !publisher && !edition) {
    return { series: [], books: [], totalSeries: 0, totalBooks: 0 };
  }

  // -------------------------------------------------------------------------
  // 1. Recherche dans la base serveur locale (`v4_series` + `books`)
  // -------------------------------------------------------------------------
  const localTerms = [series, title, q, author].filter(Boolean);
  const localSeriesMap = new Map<string, CatalogSearchSeriesHit>();
  const localBooks: CatalogSearchBookHit[] = [];

  try {
    const seriesConds: string[] = [];
    const seriesBinds: unknown[] = [];
    for (const term of localTerms.slice(0, 3)) {
      const like = `%${term.toLowerCase()}%`;
      seriesConds.push(
        '(LOWER(canonical_name) LIKE ? OR LOWER(COALESCE(aliases_json, \'\')) LIKE ? OR LOWER(COALESCE(primary_authors_json, \'\')) LIKE ?)'
      );
      seriesBinds.push(like, like, like);
    }

    if (seriesConds.length > 0) {
      const sRows = await db
        .prepare(
          `SELECT s.id, s.canonical_name, s.normalized_core_key, s.primary_authors_json, s.known_volumes_count,
                  (SELECT COALESCE(lb.selected_cover_url, b.selected_cover_url)
                   FROM books b
                   LEFT JOIN v4_library_books lb ON lb.book_id = b.id AND lb.library_id = ?
                   WHERE b.series_id = s.id AND COALESCE(lb.selected_cover_url, b.selected_cover_url) IS NOT NULL
                   ORDER BY COALESCE(lb.is_owned, 0) DESC,
                            CASE WHEN lb.selected_cover_url IS NOT NULL THEN 0 ELSE 1 END ASC,
                            COALESCE(b.volume_number, 9999) ASC LIMIT 1) as cover_url,
                  (SELECT COUNT(*) FROM books b WHERE b.series_id = s.id) as actual_count,
                  (SELECT COUNT(*) FROM v4_library_books lb JOIN books b ON b.id = lb.book_id
                   WHERE lb.library_id = ? AND b.series_id = s.id AND lb.is_owned = 1) as owned_count
           FROM v4_series s
           WHERE ${seriesConds.join(' AND ')}
           ORDER BY owned_count DESC, actual_count DESC, s.canonical_name ASC
           LIMIT 35`
        )
        .bind(libraryId || '', libraryId || '', ...seriesBinds)
        .all<Record<string, any>>();

      for (const r of sRows.results || []) {
        const name = String(r.canonical_name || '').trim();
        if (!name) continue;
        const coreKey = String(r.normalized_core_key || stripEditorialCollectionSuffixes(cleanSeriesName(name)).coreKey);
        localSeriesMap.set(coreKey, {
          id: String(r.id),
          name,
          coreKey,
          authors: safeJsonArray<string>(r.primary_authors_json),
          coverUrl: r.cover_url ? String(r.cover_url) : undefined,
          volumesCount: Math.max(Number(r.actual_count) || 0, Number(r.known_volumes_count) || 0),
          ownedCount: Number(r.owned_count) || 0,
          source: 'local',
          isMaterializedInLocal: true
        });
      }
    }

    // Recherche livres locaux (`books` + statut foyer)
    const bookConds: string[] = [];
    const bookBinds: unknown[] = [];
    if (title) {
      const like = `%${title.toLowerCase()}%`;
      bookConds.push('(LOWER(b.canonical_title) LIKE ? OR LOWER(COALESCE(b.series_name, \'\')) LIKE ?)');
      bookBinds.push(like, like);
    }
    if (series) {
      const like = `%${series.toLowerCase()}%`;
      bookConds.push('(LOWER(COALESCE(b.series_name, \'\')) LIKE ? OR LOWER(b.canonical_title) LIKE ?)');
      bookBinds.push(like, like);
    }
    if (q && !title && !series) {
      const like = `%${q.toLowerCase()}%`;
      bookConds.push(
        '(LOWER(b.canonical_title) LIKE ? OR LOWER(COALESCE(b.series_name, \'\')) LIKE ? OR LOWER(COALESCE(b.authors_json, \'\')) LIKE ?)'
      );
      bookBinds.push(like, like, like);
    }
    if (author) {
      bookConds.push('LOWER(COALESCE(b.authors_json, \'\')) LIKE ?');
      bookBinds.push(`%${author.toLowerCase()}%`);
    }
    if (publisher) {
      bookConds.push('LOWER(COALESCE(b.publisher, \'\')) LIKE ?');
      bookBinds.push(`%${publisher.toLowerCase()}%`);
    }
    if (vol) {
      bookConds.push('(CAST(b.volume_number AS TEXT) = ? OR LOWER(COALESCE(b.volume_label, \'\')) = ?)');
      bookBinds.push(vol, vol.toLowerCase());
    }

    if (bookConds.length > 0) {
      const bRows = await db
        .prepare(
          `SELECT b.id, b.legacy_entity_uri, b.canonical_title, b.authors_json, b.series_id, b.series_name,
                  b.volume_number, b.volume_label, b.publisher, b.publication_year, b.selected_cover_url,
                  b.is_integral, b.integral_metadata_json, b.known_isbns_json,
                  lb.is_owned, lb.is_wished, lb.selected_cover_url as lib_cover_url
           FROM books b
           LEFT JOIN v4_library_books lb ON lb.book_id = b.id AND lb.library_id = ?
           WHERE ${bookConds.join(' AND ')}
           ORDER BY COALESCE(lb.is_owned, 0) DESC, COALESCE(b.series_name, b.canonical_title) ASC, COALESCE(b.volume_number, 9999) ASC
           LIMIT 60`
        )
        .bind(libraryId || '', ...bookBinds)
        .all<Record<string, any>>();

      for (const r of bRows.results || []) {
        const isbns = safeJsonArray<string>(r.known_isbns_json);
        const isbn13 = isbns[0] || undefined;
        const uri = String(r.legacy_entity_uri || (isbn13 ? `isbn:${isbn13}` : `v4:${r.id}`));
        const cover = r.lib_cover_url || r.selected_cover_url || undefined;
        const integralMeta = r.integral_metadata_json
          ? (() => {
              try {
                return JSON.parse(String(r.integral_metadata_json));
              } catch {
                return null;
              }
            })()
          : null;

        localBooks.push({
          uri,
          bookId: String(r.id),
          isbn13,
          title: String(r.canonical_title || 'Titre inconnu'),
          authors: safeJsonArray<string>(r.authors_json),
          publisher: r.publisher ? String(r.publisher) : undefined,
          publishDate: r.publication_year ? String(r.publication_year) : undefined,
          series: r.series_name ? String(r.series_name) : undefined,
          seriesId: r.series_id ? String(r.series_id) : undefined,
          seriesNumber:
            r.volume_label !== null && r.volume_label !== undefined
              ? String(r.volume_label)
              : r.volume_number !== null && r.volume_number !== undefined
                ? String(r.volume_number)
                : undefined,
          coverUrl: cover ? String(cover) : undefined,
          coverFallbackUrls: isbn13 ? imageUtil.buildCoverCandidates(isbn13, [cover]) : undefined,
          isIntegral: Number(r.is_integral) === 1,
          includedVolumeNumbers: Array.isArray(integralMeta?.includedVolumeNumbers)
            ? integralMeta.includedVolumeNumbers
            : undefined,
          ownershipStatus:
            Number(r.is_owned) === 1 ? 'owned' : Number(r.is_wished) === 1 ? 'wish' : 'none',
          source: 'local',
          score: 120 + (Number(r.is_owned) === 1 ? 15 : 0)
        });
      }
    }
  } catch (err) {
    console.warn('[CATALOG SEARCH] Erreur passe locale SQLite:', err);
  }

  // -------------------------------------------------------------------------
  // 2. Recherche externe exhaustive (BnF SRU 45-50 notices + Inventaire.io séries)
  // -------------------------------------------------------------------------
  const bnfQueries: string[] = [];
  const authorLast = extractAuthorLastNameForBnfCql(author);
  const pubClause = publisher ? ` and (bib.publisher all "${publisher}")` : '';
  const edClause = edition ? ` and (bib.anywhere all "${edition}")` : '';
  const authClause = authorLast ? ` and (bib.author all "${authorLast}")` : '';

  if (series && vol) {
    bnfQueries.push(`(bib.anywhere all "${series} ${vol}")${authClause}${pubClause}${edClause} and (bib.doctype all "a")`);
  } else if (series) {
    bnfQueries.push(`(bib.anywhere all "${series}")${authClause}${pubClause}${edClause} and (bib.doctype all "a")`);
  }
  if (title) {
    const titleExpr = vol && !series ? `${title} ${vol}` : title;
    bnfQueries.push(`(bib.title all "${titleExpr}")${authClause}${pubClause}${edClause} and (bib.doctype all "a")`);
  }
  if (!title && !series && authorLast) {
    // Recherche par auteur seul (ex: "Hergé") -> récupérer un large éventail de ses séries & albums
    bnfQueries.push(`(bib.author all "${authorLast}")${pubClause}${edClause} and (bib.doctype all "a")`);
  }
  if (!title && !series && !authorLast && q) {
    bnfQueries.push(`(bib.anywhere all "${q}")${pubClause}${edClause} and (bib.doctype all "a")`);
  }

  const [bnfBatches, invSeriesHits] = await Promise.all([
    Promise.all(bnfQueries.slice(0, 2).map((cql) => fetchBnfCatalogRecords(cql, 48))),
    searchInventaireSeriesPublic(series || title || q || author)
  ]);

  const bnfRecords = bnfBatches.flat();

  // Agréger les séries découvertes dans BnF + Inventaire.io avec les séries locales
  const seriesMap = new Map<string, CatalogSearchSeriesHit>(localSeriesMap);

  for (const invS of invSeriesHits) {
    const clean = stripEditorialCollectionSuffixes(cleanSeriesName(invS.name));
    const key = clean.coreKey || normalizeTextKey(invS.name);
    if (!key) continue;
    const existing = seriesMap.get(key);
    if (!existing) {
      seriesMap.set(key, {
        id: invS.id,
        name: clean.cleanDisplay || invS.name,
        coreKey: key,
        authors: author ? [author] : [],
        coverUrl: invS.coverUrl,
        volumesCount: 0,
        ownedCount: 0,
        source: 'inventaire',
        isMaterializedInLocal: false
      });
    } else if (!existing.coverUrl && invS.coverUrl) {
      existing.coverUrl = invS.coverUrl;
    }
  }

  for (const rec of bnfRecords) {
    if (!rec.series) continue;
    const clean = stripEditorialCollectionSuffixes(cleanSeriesName(rec.series));
    const key = clean.coreKey || normalizeTextKey(rec.series);
    if (!key) continue;
    const existing = seriesMap.get(key);
    if (existing) {
      if (!existing.isMaterializedInLocal) {
        existing.volumesCount++;
      }
      if (!existing.coverUrl && rec.coverUrl) existing.coverUrl = rec.coverUrl;
      if (existing.authors.length === 0 && rec.authors.length > 0) existing.authors = rec.authors;
    } else {
      seriesMap.set(key, {
        id: `search-series:${encodeURIComponent(clean.cleanDisplay || rec.series)}`,
        name: clean.cleanDisplay || rec.series,
        coreKey: key,
        authors: rec.authors || [],
        coverUrl: rec.coverUrl,
        volumesCount: 1,
        ownedCount: 0,
        source: 'bnf',
        isMaterializedInLocal: false
      });
    }
  }

  // Fusionner et dédupliquer les œuvres/livres (locaux en priorité, puis BnF distincts)
  const bookByWorkKey = new Map<string, CatalogSearchBookHit>();
  const seenIsbns = new Set<string>();

  for (const lb of localBooks) {
    if (lb.isbn13) seenIsbns.add(lb.isbn13);
    const key = buildWorkDedupKey(lb);
    if (!bookByWorkKey.has(key)) {
      bookByWorkKey.set(key, lb);
    }
  }

  for (const rec of bnfRecords) {
    if (seenIsbns.has(rec.isbn13)) continue;
    seenIsbns.add(rec.isbn13);

    const key = buildWorkDedupKey(rec);
    if (bookByWorkKey.has(key)) {
      // Si l'œuvre existe déjà mais sans couverture, enrichir la couverture
      const existing = bookByWorkKey.get(key)!;
      if (!existing.coverUrl && rec.coverUrl) existing.coverUrl = rec.coverUrl;
      continue;
    }

    const candidates = imageUtil.buildCoverCandidates(rec.isbn13, [rec.coverUrl]);
    const matchedSeries = rec.series
      ? seriesMap.get(stripEditorialCollectionSuffixes(cleanSeriesName(rec.series)).coreKey)
      : undefined;

    let score = 60;
    if (series && rec.series && normalizeTextKey(rec.series).includes(normalizeTextKey(series))) score += 25;
    if (title && normalizeTextKey(rec.title).includes(normalizeTextKey(title))) score += 25;
    if (author && rec.authors.some((a) => normalizeTextKey(a).includes(normalizeTextKey(author)))) score += 20;
    if (vol && normalizeSeriesNumber(rec.seriesNumber) === vol) score += 30;
    if (rec.coverUrl) score += 5;

    bookByWorkKey.set(key, {
      uri: `isbn:${rec.isbn13}`,
      isbn13: rec.isbn13,
      title: rec.title,
      authors: rec.authors.length > 0 ? rec.authors : ['Auteur inconnu'],
      publisher: rec.publisher,
      publishDate: rec.publishDate,
      series: rec.series,
      seriesId: matchedSeries?.isMaterializedInLocal ? matchedSeries.id : undefined,
      seriesNumber: rec.seriesNumber,
      coverUrl: rec.coverUrl || candidates[0],
      coverFallbackUrls: candidates,
      isIntegral: Boolean(rec.isIntegral),
      includedVolumeNumbers: rec.includedVolumeNumbers,
      ownershipStatus: 'none',
      source: 'bnf',
      score
    });
  }

  // Tri propre des séries (possédées / locales d'abord, puis nb tomes, puis alpha)
  const finalSeries = Array.from(seriesMap.values())
    .sort((a, b) => {
      if (a.ownedCount !== b.ownedCount) return b.ownedCount - a.ownedCount;
      if (a.isMaterializedInLocal !== b.isMaterializedInLocal) return a.isMaterializedInLocal ? -1 : 1;
      if (a.volumesCount !== b.volumesCount) return b.volumesCount - a.volumesCount;
      return a.name.localeCompare(b.name, 'fr');
    })
    .slice(0, 30);

  // Tri propre des livres (score desc, puis série + numéro de tome)
  const finalBooks = Array.from(bookByWorkKey.values())
    .sort((a, b) => {
      if (Math.abs(b.score - a.score) >= 15) return b.score - a.score;
      const sa = (a.series || a.title).toLowerCase();
      const sb = (b.series || b.title).toLowerCase();
      if (sa !== sb) return sa.localeCompare(sb, 'fr');
      const na = parseFloat(a.seriesNumber || '9999');
      const nb = parseFloat(b.seriesNumber || '9999');
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
      return a.title.localeCompare(b.title, 'fr');
    })
    .slice(0, 60);

  return {
    series: finalSeries,
    books: finalBooks,
    totalSeries: finalSeries.length,
    totalBooks: finalBooks.length
  };
}
