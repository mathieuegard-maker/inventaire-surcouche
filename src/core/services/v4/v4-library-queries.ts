// src/core/services/v4/v4-library-queries.ts
// Requêtes de synchronisation différentielle foyer, vue Série V4 et surcharges privées Option B.

import type { DatabaseBinding } from '../../adapters/storage-db.interface';
import { cleanSeriesName, normalizeSeriesNumber, normalizeTextKey } from '../../resolvers/bnf.resolver';
import { isbnUtil } from '../../utils/isbn.util';
import { stripEditorialCollectionSuffixes } from '../../utils/series-matcher.util';
import { formatIntegralRangeLabel, parseIncludedVolumeNumbers } from '../../bibliographic/integral.util';
import { enqueueOrExpandSeriesLayer5 } from './v4-layer5-orchestrator';
import {
  applyLibraryOverridesToBook,
  mapBookRow,
  safeJsonParse,
  type LibraryBookOverrides,
  type V4BookRecord
} from './v4-shared';

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

  // 1. Récupérer tous les liens bibliothèque de l'utilisateur (avec ses surcharges privées et l'auteur du souhait)
  const linkRows = await db
    .prepare(
      `SELECT lb.book_id, lb.is_owned, lb.is_wished, lb.selected_cover_url, lb.custom_overrides_json,
              lb.wished_by_user_id, u.display_name AS wished_by_name, lb.updated_at
       FROM v4_library_books lb
       LEFT JOIN users u ON u.id = lb.wished_by_user_id
       WHERE lb.library_id = ?`
    )
    .bind(params.libraryId)
    .all<{
      book_id: string;
      is_owned: number;
      is_wished: number;
      selected_cover_url?: string | null;
      custom_overrides_json?: string | null;
      wished_by_user_id?: string | null;
      wished_by_name?: string | null;
      updated_at: string;
    }>();

  const statusByBookId = new Map<
    string,
    {
      status: 'owned' | 'wish' | 'none';
      selectedCoverUrl?: string | null;
      customOverridesJson?: string | null;
      wishedByUserId?: string | null;
      wishedByName?: string | null;
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
      wishedByUserId: status === 'wish' ? (row.wished_by_user_id ?? null) : null,
      wishedByName: status === 'wish' ? (row.wished_by_name ?? null) : null,
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
    if (link?.wishedByUserId) book.wishedByUserId = link.wishedByUserId;
    if (link?.wishedByName) book.wishedByName = link.wishedByName;
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
    isIntegral?: boolean;
    includedVolumeNumbers?: string[];
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

  // Transformation explicite en Intégrale / Tome standard (Option B par foyer)
  if (params.isIntegral !== undefined) {
    const isInt = Boolean(params.isIntegral);
    nextOverrides.isIntegral = isInt;
    if (isInt) {
      const parsedVols = parseIncludedVolumeNumbers(params.includedVolumeNumbers);
      const includedWorkIds: string[] = [];
      const includedIsbns: string[] = [];
      if (nextSeriesId && parsedVols.length > 0) {
        const sibRows = await db
          .prepare(
            `SELECT id, volume_number, volume_label, known_isbns_json
             FROM books
             WHERE series_id = ? AND id != ? AND is_integral = 0`
          )
          .bind(nextSeriesId, bookId)
          .all<{ id: string; volume_number?: number | null; volume_label?: string | null; known_isbns_json?: string | null }>()
          .catch(() => ({ results: [] as Array<{ id: string; volume_number?: number | null; volume_label?: string | null; known_isbns_json?: string | null }> }));
        for (const sr of sibRows.results || []) {
          const normVol = normalizeSeriesNumber(
            sr.volume_label || (sr.volume_number !== null && sr.volume_number !== undefined ? String(sr.volume_number) : '')
          );
          if (normVol && parsedVols.includes(normVol)) {
            includedWorkIds.push(String(sr.id));
            const isbns = safeJsonParse<string[]>(sr.known_isbns_json, []);
            for (const code of isbns) {
              if (!includedIsbns.includes(code)) includedIsbns.push(code);
            }
          }
        }
      }
      nextOverrides.integralMetadata = {
        includedVolumeNumbers: parsedVols,
        includedWorkIds,
        includedIsbns
      };
      nextOverrides.volumeNumber = null;
      nextOverrides.volumeLabel = formatIntegralRangeLabel(parsedVols);
    } else {
      nextOverrides.integralMetadata = {
        includedVolumeNumbers: [],
        includedWorkIds: [],
        includedIsbns: []
      };
    }
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
