// src/server/repositories/catalog.repo.ts
// Repository SQL pur pour l'Espace 1 — Catalogue Central (franchises, series, books, book_editions, covers).

import type { DatabaseAdapter } from '../db/database.adapter';
import type { BookMainCategory, BookSourceOrigin } from '../../shared/types/domain.types';
import { matchesAuthorName } from '../../shared/bibliographic/text-normalize.util';

export interface CoverRow {
  cover_key: string;
  file_path: string;
  source_url: string | null;
  mime_type: string;
  byte_size: number;
  sha256: string | null;
  created_at: string;
  last_referenced_at: string;
}

export interface FranchiseRow {
  id: string;
  canonical_name: string;
  normalized_key: string;
  wikidata_qid: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeriesRow {
  id: string;
  franchise_id: string | null;
  canonical_name: string;
  normalized_key: string;
  edition_signature: string;
  aliases_json: string;
  primary_authors_json: string;
  wikidata_qid: string | null;
  bnf_ensemble_ids_json: string;
  is_complete_expanded: number;
  known_volumes_count: number;
  locked_fields_json: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookRow {
  id: string;
  work_canonical_id: string;
  series_id: string | null;
  title: string;
  normalized_title: string;
  volume_number: number | null;
  volume_label: string | null;
  sort_order: number | null;
  is_hors_serie: number;
  is_integral: number;
  included_volumes_json: string;
  authors_json: string;
  scriptwriters_json: string;
  illustrators_json: string;
  publisher: string | null;
  collection_name: string | null;
  publish_year: string | null;
  page_count: number | null;
  description: string | null;
  language: string;
  main_category: BookMainCategory;
  subgenres_json: string;
  cover_key: string | null;
  wikidata_qid: string | null;
  inventaire_uri: string | null;
  source_origin: BookSourceOrigin;
  locked_fields_json: string;
  created_at: string;
  updated_at: string;
}

export interface BookEditionRow {
  isbn13: string;
  book_id: string;
  publisher: string | null;
  collection_name: string | null;
  publish_year: string | null;
  page_count: number | null;
  cover_key: string | null;
  source: string;
  created_at: string;
}

export interface UpsertBookAutomaticInput {
  id: string;
  workCanonicalId: string;
  seriesId: string | null;
  title: string;
  normalizedTitle: string;
  volumeNumber: number | null;
  volumeLabel: string | null;
  sortOrder: number | null;
  isHorsSerie: boolean;
  isIntegral: boolean;
  includedVolumes: string[];
  authors: string[];
  scriptwriters: string[];
  illustrators: string[];
  publisher: string | null;
  collectionName: string | null;
  publishYear: string | null;
  pageCount: number | null;
  description: string | null;
  language: string;
  mainCategory: BookMainCategory;
  subgenres: string[];
  coverKey: string | null;
  wikidataQid: string | null;
  inventaireUri: string | null;
  sourceOrigin: BookSourceOrigin;
  now: string;
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export class CatalogRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ==================== COVERS ====================

  findCoverByKey(coverKey: string): CoverRow | null {
    return this.db.get<CoverRow>('SELECT * FROM covers WHERE cover_key = ? LIMIT 1', [coverKey]);
  }

  findCoverBySha256(sha256: string): CoverRow | null {
    return this.db.get<CoverRow>('SELECT * FROM covers WHERE sha256 = ? LIMIT 1', [sha256]);
  }

  findCoverBySourceUrl(sourceUrl: string): CoverRow | null {
    return this.db.get<CoverRow>('SELECT * FROM covers WHERE source_url = ? LIMIT 1', [sourceUrl]);
  }

  upsertCover(row: CoverRow): void {
    this.db.run(
      `INSERT INTO covers (cover_key, file_path, source_url, mime_type, byte_size, sha256, created_at, last_referenced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cover_key) DO UPDATE SET
         last_referenced_at = excluded.last_referenced_at,
         source_url = COALESCE(covers.source_url, excluded.source_url)`,
      [
        row.cover_key,
        row.file_path,
        row.source_url,
        row.mime_type,
        row.byte_size,
        row.sha256,
        row.created_at,
        row.last_referenced_at
      ]
    );
  }

  touchCoverReference(coverKey: string, now: string): void {
    this.db.run('UPDATE covers SET last_referenced_at = ? WHERE cover_key = ?', [now, coverKey]);
  }

  listCoversOlderThan(cutoffIso: string): CoverRow[] {
    return this.db.all<CoverRow>(
      `SELECT c.* FROM covers c
       WHERE c.last_referenced_at < ?
         AND NOT EXISTS (SELECT 1 FROM books b WHERE b.cover_key = c.cover_key)
         AND NOT EXISTS (SELECT 1 FROM book_editions be WHERE be.cover_key = c.cover_key)`,
      [cutoffIso]
    );
  }

  deleteCover(coverKey: string): void {
    this.db.run('DELETE FROM covers WHERE cover_key = ?', [coverKey]);
  }

  // ==================== FRANCHISES ====================

  findFranchiseById(id: string): FranchiseRow | null {
    return this.db.get<FranchiseRow>('SELECT * FROM franchises WHERE id = ? LIMIT 1', [id]);
  }

  findFranchiseByNormalizedKey(normalizedKey: string): FranchiseRow | null {
    return this.db.get<FranchiseRow>('SELECT * FROM franchises WHERE normalized_key = ? LIMIT 1', [normalizedKey]);
  }

  findFranchiseByWikidataQid(qid: string): FranchiseRow | null {
    return this.db.get<FranchiseRow>('SELECT * FROM franchises WHERE wikidata_qid = ? LIMIT 1', [qid]);
  }

  createFranchise(input: {
    id: string;
    canonicalName: string;
    normalizedKey: string;
    wikidataQid: string | null;
    now: string;
  }): FranchiseRow {
    this.db.run(
      `INSERT INTO franchises (id, canonical_name, normalized_key, wikidata_qid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.id, input.canonicalName, input.normalizedKey, input.wikidataQid, input.now, input.now]
    );
    return this.findFranchiseById(input.id)!;
  }

  updateFranchiseWikidata(id: string, wikidataQid: string, now: string): void {
    this.db.run(
      'UPDATE franchises SET wikidata_qid = COALESCE(wikidata_qid, ?), updated_at = ? WHERE id = ?',
      [wikidataQid, now, id]
    );
  }

  // ==================== SERIES ====================

  findSeriesById(id: string): SeriesRow | null {
    return this.db.get<SeriesRow>('SELECT * FROM series WHERE id = ? LIMIT 1', [id]);
  }

  findSeriesByKeyAndSignature(normalizedKey: string, editionSignature: string): SeriesRow | null {
    return this.db.get<SeriesRow>(
      'SELECT * FROM series WHERE normalized_key = ? AND edition_signature = ? LIMIT 1',
      [normalizedKey, editionSignature]
    );
  }

  findSeriesByFranchiseId(franchiseId: string): SeriesRow[] {
    return this.db.all<SeriesRow>(
      'SELECT * FROM series WHERE franchise_id = ? ORDER BY created_at ASC',
      [franchiseId]
    );
  }

  findSeriesByNormalizedKey(normalizedKey: string): SeriesRow[] {
    return this.db.all<SeriesRow>(
      'SELECT * FROM series WHERE normalized_key = ? ORDER BY created_at ASC',
      [normalizedKey]
    );
  }

  findSeriesByWikidataQid(wikidataQid: string): SeriesRow[] {
    return this.db.all<SeriesRow>(
      'SELECT * FROM series WHERE wikidata_qid = ? ORDER BY created_at ASC',
      [wikidataQid]
    );
  }

  findSeriesByAliasOrName(normalizedAlias: string): SeriesRow[] {
    return this.db.all<SeriesRow>(
      `SELECT * FROM series
       WHERE normalized_key = ?
          OR lower(aliases_json) LIKE ?
       ORDER BY created_at ASC`,
      [normalizedAlias, `%"${normalizedAlias.toLowerCase()}"%`]
    );
  }

  createSeries(input: {
    id: string;
    franchiseId: string | null;
    canonicalName: string;
    normalizedKey: string;
    editionSignature: string;
    aliases: string[];
    primaryAuthors: string[];
    wikidataQid: string | null;
    bnfEnsembleIds: string[];
    now: string;
  }): SeriesRow {
    this.db.run(
      `INSERT INTO series (
         id, franchise_id, canonical_name, normalized_key, edition_signature,
         aliases_json, primary_authors_json, wikidata_qid, bnf_ensemble_ids_json,
         is_complete_expanded, known_volumes_count, locked_fields_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', ?, ?)`,
      [
        input.id,
        input.franchiseId,
        input.canonicalName,
        input.normalizedKey,
        input.editionSignature,
        JSON.stringify(input.aliases),
        JSON.stringify(input.primaryAuthors),
        input.wikidataQid,
        JSON.stringify(input.bnfEnsembleIds),
        input.now,
        input.now
      ]
    );
    return this.findSeriesById(input.id)!;
  }

  mergeSeriesMetadataAutomatic(
    seriesId: string,
    patch: {
      franchiseId?: string | null;
      alias?: string;
      authors?: string[];
      wikidataQid?: string | null;
      bnfEnsembleId?: string | null;
      isCompleteExpanded?: boolean;
      lastCheckedAt?: string;
      now: string;
    }
  ): SeriesRow | null {
    const existing = this.findSeriesById(seriesId);
    if (!existing) return null;

    const locked = new Set(parseJsonStringArray(existing.locked_fields_json));
    const aliases = new Set(parseJsonStringArray(existing.aliases_json));
    if (patch.alias && patch.alias.trim()) aliases.add(patch.alias.trim());

    const authors = new Set(parseJsonStringArray(existing.primary_authors_json));
    if (!locked.has('primaryAuthors') && patch.authors) {
      for (const a of patch.authors) {
        if (a.trim()) authors.add(a.trim());
      }
    }

    const bnfIds = new Set(parseJsonStringArray(existing.bnf_ensemble_ids_json));
    if (patch.bnfEnsembleId && patch.bnfEnsembleId.trim()) {
      bnfIds.add(patch.bnfEnsembleId.trim());
    }

    const nextFranchiseId = existing.franchise_id ?? patch.franchiseId ?? null;
    const nextWikidataQid = locked.has('wikidataQid')
      ? existing.wikidata_qid
      : existing.wikidata_qid ?? patch.wikidataQid ?? null;
    const nextExpanded = patch.isCompleteExpanded ? 1 : existing.is_complete_expanded;
    const nextCheckedAt = patch.lastCheckedAt ?? existing.last_checked_at;

    this.db.run(
      `UPDATE series SET
         franchise_id = ?,
         aliases_json = ?,
         primary_authors_json = ?,
         wikidata_qid = ?,
         bnf_ensemble_ids_json = ?,
         is_complete_expanded = ?,
         last_checked_at = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        nextFranchiseId,
        JSON.stringify(Array.from(aliases)),
        JSON.stringify(Array.from(authors)),
        nextWikidataQid,
        JSON.stringify(Array.from(bnfIds)),
        nextExpanded,
        nextCheckedAt,
        patch.now,
        seriesId
      ]
    );

    return this.findSeriesById(seriesId);
  }

  recountSeriesVolumes(seriesId: string, now: string): number {
    const row = this.db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM books WHERE series_id = ?', [seriesId]);
    const cnt = Number(row?.cnt ?? 0);
    this.db.run('UPDATE series SET known_volumes_count = ?, updated_at = ? WHERE id = ?', [cnt, now, seriesId]);
    return cnt;
  }

  // ==================== BOOKS & EDITIONS ====================

  findBookById(id: string): BookRow | null {
    return this.db.get<BookRow>('SELECT * FROM books WHERE id = ? LIMIT 1', [id]);
  }

  findBookByWorkCanonicalId(workCanonicalId: string): BookRow | null {
    return this.db.get<BookRow>('SELECT * FROM books WHERE work_canonical_id = ? LIMIT 1', [workCanonicalId]);
  }

  findBookByWikidataQid(wikidataQid: string): BookRow | null {
    return this.db.get<BookRow>('SELECT * FROM books WHERE wikidata_qid = ? LIMIT 1', [wikidataQid]);
  }

  findBookByIsbn13(isbn13: string): BookRow | null {
    return this.db.get<BookRow>(
      `SELECT b.* FROM books b
       JOIN book_editions be ON be.book_id = b.id
       WHERE be.isbn13 = ?
       LIMIT 1`,
      [isbn13]
    );
  }

  findEditionByIsbn13(isbn13: string): BookEditionRow | null {
    return this.db.get<BookEditionRow>('SELECT * FROM book_editions WHERE isbn13 = ? LIMIT 1', [isbn13]);
  }

  listEditionsByBookId(bookId: string): BookEditionRow[] {
    return this.db.all<BookEditionRow>(
      'SELECT * FROM book_editions WHERE book_id = ? ORDER BY created_at ASC',
      [bookId]
    );
  }

  listBooksBySeriesId(seriesId: string): BookRow[] {
    return this.db.all<BookRow>(
      `SELECT * FROM books
       WHERE series_id = ?
       ORDER BY COALESCE(sort_order, volume_number, 999999) ASC, title ASC`,
      [seriesId]
    );
  }

  findBookInSeriesByVolume(seriesId: string, volumeNumber: number): BookRow | null {
    return this.db.get<BookRow>(
      'SELECT * FROM books WHERE series_id = ? AND volume_number = ? AND is_hors_serie = 0 AND is_integral = 0 LIMIT 1',
      [seriesId, volumeNumber]
    );
  }

  findBookInSeriesByNormalizedTitle(seriesId: string, normalizedTitle: string): BookRow | null {
    return this.db.get<BookRow>(
      'SELECT * FROM books WHERE series_id = ? AND normalized_title = ? LIMIT 1',
      [seriesId, normalizedTitle]
    );
  }

  /**
   * Crée ou enrichit une fiche du Catalogue Central (Couche 1) en respectant STRICTEMENT `locked_fields_json` (Couche 2 Admin).
   */
  upsertBookAutomatic(input: UpsertBookAutomaticInput): BookRow {
    const existing =
      this.findBookById(input.id) ??
      this.findBookByWorkCanonicalId(input.workCanonicalId) ??
      (input.wikidataQid ? this.findBookByWikidataQid(input.wikidataQid) : null);

    if (!existing) {
      this.db.run(
        `INSERT INTO books (
           id, work_canonical_id, series_id, title, normalized_title,
           volume_number, volume_label, sort_order, is_hors_serie, is_integral, included_volumes_json,
           authors_json, scriptwriters_json, illustrators_json,
           publisher, collection_name, publish_year, page_count, description, language,
           main_category, subgenres_json, cover_key, wikidata_qid, inventaire_uri,
           source_origin, locked_fields_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
        [
          input.id,
          input.workCanonicalId,
          input.seriesId,
          input.title,
          input.normalizedTitle,
          input.volumeNumber,
          input.volumeLabel,
          input.sortOrder,
          input.isHorsSerie ? 1 : 0,
          input.isIntegral ? 1 : 0,
          JSON.stringify(input.includedVolumes),
          JSON.stringify(input.authors),
          JSON.stringify(input.scriptwriters),
          JSON.stringify(input.illustrators),
          input.publisher,
          input.collectionName,
          input.publishYear,
          input.pageCount,
          input.description,
          input.language,
          input.mainCategory,
          JSON.stringify(input.subgenres),
          input.coverKey,
          input.wikidataQid,
          input.inventaireUri,
          input.sourceOrigin,
          input.now,
          input.now
        ]
      );
      return this.findBookById(input.id)!;
    }

    // Respect strict de Couche 2 Admin (locked_fields_json) : un champ verrouillé n'est JAMAIS écrasé par les robots.
    const locked = new Set(parseJsonStringArray(existing.locked_fields_json));

    const pick = <T>(field: string, currentVal: T, incomingVal: T, preferIncomingWhenPresent = true): T => {
      if (locked.has(field)) return currentVal;
      if (!preferIncomingWhenPresent) return currentVal ?? incomingVal;
      if (incomingVal === null || incomingVal === undefined || incomingVal === '') return currentVal;
      return incomingVal;
    };

    const pickArray = (field: string, currentJson: string, incomingArr: string[]): string => {
      if (locked.has(field)) return currentJson;
      const existingArr = parseJsonStringArray(currentJson);
      if (incomingArr.length === 0) return currentJson;
      return JSON.stringify(incomingArr.length >= existingArr.length ? incomingArr : existingArr);
    };

    const nextTitle = pick('title', existing.title, input.title);
    const nextNormTitle = locked.has('title') ? existing.normalized_title : input.normalizedTitle;
    const nextSeriesId = pick('seriesId', existing.series_id, input.seriesId);
    const nextVolumeNumber = pick('volumeNumber', existing.volume_number, input.volumeNumber);
    const nextVolumeLabel = pick('volumeLabel', existing.volume_label, input.volumeLabel);
    const nextSortOrder = pick('sortOrder', existing.sort_order, input.sortOrder);
    const nextIsHorsSerie = locked.has('isHorsSerie')
      ? existing.is_hors_serie
      : input.isHorsSerie
        ? 1
        : existing.is_hors_serie;
    const nextIsIntegral = locked.has('isIntegral')
      ? existing.is_integral
      : input.isIntegral
        ? 1
        : existing.is_integral;
    const nextIncluded = pickArray('includedVolumes', existing.included_volumes_json, input.includedVolumes);
    const nextAuthors = pickArray('authors', existing.authors_json, input.authors);
    const nextScriptwriters = pickArray('scriptwriters', existing.scriptwriters_json, input.scriptwriters);
    const nextIllustrators = pickArray('illustrators', existing.illustrators_json, input.illustrators);
    const nextPublisher = pick('publisher', existing.publisher, input.publisher);
    const nextCollection = pick('collectionName', existing.collection_name, input.collectionName);
    const nextPublishYear = pick('publishYear', existing.publish_year, input.publishYear);
    const nextPageCount = pick('pageCount', existing.page_count, input.pageCount);
    const nextDescription = pick('description', existing.description, input.description);
    const nextLanguage = pick('language', existing.language, input.language);
    const nextCategory = locked.has('mainCategory')
      ? existing.main_category
      : existing.main_category !== 'Autre' && input.mainCategory === 'Autre'
        ? existing.main_category
        : input.mainCategory;
    const nextSubgenres = pickArray('subgenres', existing.subgenres_json, input.subgenres);
    const nextCoverKey = locked.has('coverKey')
      ? existing.cover_key
      : existing.cover_key ?? input.coverKey;
    const nextWikidataQid = locked.has('wikidataQid')
      ? existing.wikidata_qid
      : existing.wikidata_qid ?? input.wikidataQid;
    const nextInventaireUri = locked.has('inventaireUri')
      ? existing.inventaire_uri
      : existing.inventaire_uri ?? input.inventaireUri;

    this.db.run(
      `UPDATE books SET
         series_id = ?,
         title = ?,
         normalized_title = ?,
         volume_number = ?,
         volume_label = ?,
         sort_order = ?,
         is_hors_serie = ?,
         is_integral = ?,
         included_volumes_json = ?,
         authors_json = ?,
         scriptwriters_json = ?,
         illustrators_json = ?,
         publisher = ?,
         collection_name = ?,
         publish_year = ?,
         page_count = ?,
         description = ?,
         language = ?,
         main_category = ?,
         subgenres_json = ?,
         cover_key = ?,
         wikidata_qid = ?,
         inventaire_uri = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        nextSeriesId,
        nextTitle,
        nextNormTitle,
        nextVolumeNumber,
        nextVolumeLabel,
        nextSortOrder,
        nextIsHorsSerie,
        nextIsIntegral,
        nextIncluded,
        nextAuthors,
        nextScriptwriters,
        nextIllustrators,
        nextPublisher,
        nextCollection,
        nextPublishYear,
        nextPageCount,
        nextDescription,
        nextLanguage,
        nextCategory,
        nextSubgenres,
        nextCoverKey,
        nextWikidataQid,
        nextInventaireUri,
        input.now,
        existing.id
      ]
    );

    return this.findBookById(existing.id)!;
  }

  /**
   * Verrouille explicitement des champs sur un livre du Catalogue Maître (Couche 2 Admin).
   */
  setBookLockedFields(bookId: string, lockedFields: string[], now: string): void {
    const existing = this.findBookById(bookId);
    if (!existing) return;
    const merged = Array.from(new Set([...parseJsonStringArray(existing.locked_fields_json), ...lockedFields]));
    this.db.run('UPDATE books SET locked_fields_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(merged),
      now,
      bookId
    ]);
  }

  upsertBookEdition(input: {
    isbn13: string;
    bookId: string;
    publisher: string | null;
    collectionName: string | null;
    publishYear: string | null;
    pageCount: number | null;
    coverKey: string | null;
    source: string;
    now: string;
  }): void {
    this.db.run(
      `INSERT INTO book_editions (
         isbn13, book_id, publisher, collection_name, publish_year, page_count, cover_key, source, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(isbn13) DO UPDATE SET
         publisher = COALESCE(book_editions.publisher, excluded.publisher),
         collection_name = COALESCE(book_editions.collection_name, excluded.collection_name),
         publish_year = COALESCE(book_editions.publish_year, excluded.publish_year),
         page_count = COALESCE(book_editions.page_count, excluded.page_count),
         cover_key = COALESCE(book_editions.cover_key, excluded.cover_key)`,
      [
        input.isbn13,
        input.bookId,
        input.publisher,
        input.collectionName,
        input.publishYear,
        input.pageCount,
        input.coverKey,
        input.source,
        input.now
      ]
    );
  }

  /**
   * Recherche SQLite exhaustive et propre sur le Catalogue Central (`books` + `book_editions` + `series`).
   * Zéro concaténation risquée : 100 % paramètres liés `?`.
   */
  searchLocalCatalog(criteria: {
    titleNorm?: string;
    seriesNorm?: string;
    volumeNumber?: number | null;
    authorNorm?: string;
    collectionNorm?: string;
    publisherNorm?: string;
    limit?: number;
  }): { series: SeriesRow[]; books: BookRow[] } {
    const limit = criteria.limit ?? 40;

    // 1. Recherche Séries
    const seriesClauses: string[] = [];
    const seriesParams: Array<string | number> = [];

    const seriesNeedle = criteria.seriesNorm || criteria.titleNorm;
    if (seriesNeedle) {
      seriesClauses.push('(normalized_key LIKE ? OR lower(canonical_name) LIKE ? OR lower(aliases_json) LIKE ?)');
      const pat = `%${seriesNeedle}%`;
      seriesParams.push(pat, pat, pat);
    }

    let seriesRows: SeriesRow[] = [];
    if (seriesClauses.length > 0) {
      seriesRows = this.db.all<SeriesRow>(
        `SELECT * FROM series WHERE ${seriesClauses.join(' AND ')} ORDER BY known_volumes_count DESC, canonical_name ASC LIMIT ?`,
        [...seriesParams, criteria.authorNorm ? 200 : 20]
      );
    } else if (criteria.authorNorm) {
      seriesRows = this.db.all<SeriesRow>(
        'SELECT * FROM series ORDER BY known_volumes_count DESC, canonical_name ASC LIMIT 500'
      );
    }

    if (criteria.authorNorm) {
      const targetAuthor = criteria.authorNorm;
      seriesRows = seriesRows
        .filter((s) => parseJsonStringArray(s.primary_authors_json).some((a) => matchesAuthorName(a, targetAuthor)))
        .slice(0, 40);
    }

    // 2. Recherche Livres (jointure optionnelle sur series & editions)
    const bookClauses: string[] = [];
    const bookParams: Array<string | number> = [];

    if (criteria.titleNorm) {
      bookClauses.push('(b.normalized_title LIKE ? OR lower(b.title) LIKE ?)');
      const pat = `%${criteria.titleNorm}%`;
      bookParams.push(pat, pat);
    }
    if (criteria.seriesNorm) {
      bookClauses.push('(s.normalized_key LIKE ? OR lower(s.canonical_name) LIKE ? OR lower(s.aliases_json) LIKE ?)');
      const pat = `%${criteria.seriesNorm}%`;
      bookParams.push(pat, pat, pat);
    }
    if (criteria.volumeNumber !== undefined && criteria.volumeNumber !== null) {
      bookClauses.push('b.volume_number = ?');
      bookParams.push(criteria.volumeNumber);
    }
    if (criteria.collectionNorm) {
      bookClauses.push('(lower(COALESCE(b.collection_name, \'\')) LIKE ? OR EXISTS (SELECT 1 FROM book_editions be WHERE be.book_id = b.id AND lower(COALESCE(be.collection_name, \'\')) LIKE ?))');
      const pat = `%${criteria.collectionNorm}%`;
      bookParams.push(pat, pat);
    }
    if (criteria.publisherNorm) {
      bookClauses.push('(lower(COALESCE(b.publisher, \'\')) LIKE ? OR EXISTS (SELECT 1 FROM book_editions be WHERE be.book_id = b.id AND lower(COALESCE(be.publisher, \'\')) LIKE ?))');
      const pat = `%${criteria.publisherNorm}%`;
      bookParams.push(pat, pat);
    }

    let bookRows: BookRow[] = [];
    if (bookClauses.length > 0) {
      bookRows = this.db.all<BookRow>(
        `SELECT b.*
         FROM books b
         LEFT JOIN series s ON s.id = b.series_id
         WHERE ${bookClauses.join(' AND ')}
         ORDER BY b.updated_at DESC
         LIMIT ?`,
        [...bookParams, criteria.authorNorm ? Math.max(limit * 4, 300) : limit]
      );
    } else if (criteria.authorNorm) {
      // Filtrage auteur en TypeScript via matchesAuthorName (insensible aux accents/tirets/ordre, ex: Hergé, Jean-Pierre Gibrat)
      bookRows = this.db.all<BookRow>('SELECT * FROM books ORDER BY updated_at DESC LIMIT 2000');
    }

    if (criteria.authorNorm) {
      const targetAuthor = criteria.authorNorm;
      bookRows = bookRows
        .filter((b) => {
          const allCreators = [
            ...parseJsonStringArray(b.authors_json),
            ...parseJsonStringArray(b.scriptwriters_json),
            ...parseJsonStringArray(b.illustrators_json)
          ];
          return allCreators.some((a) => matchesAuthorName(a, targetAuthor));
        })
        .slice(0, limit);
    }

    return { series: seriesRows, books: bookRows };
  }
}
