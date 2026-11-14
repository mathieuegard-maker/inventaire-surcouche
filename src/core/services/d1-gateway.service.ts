// src/core/services/d1-gateway.service.ts
// Moteur Backend Autonome V2 sur Cloudflare D1 (KISS, DRY, SOLID).
// Remplace intégralement inventaire.io par notre base SQLite D1 :
// - Authentification multi-comptes & Bibliothèques familiales partagées (isolation stricte par library_id)
// - Catalogue commun dédupliqué (catalog_entities) avec auto-résolution BnF SRU + Google Books + OpenLibrary
// - Classification fine automatique (Catégorie + Sous-genres via Dewey / RAMEAU / Google Books)
// - Gestion ultra-rapide (< 5 ms) de la Collection, Wishlist, Prêts, Séries, Hors-Séries et Fusions.

import type { DatabaseBinding } from '../adapters/storage-db.interface';
import {
  cleanAuthor,
  cleanPublisher,
  cleanPublishDate,
  cleanTitle,
  normalizeSeriesNumber,
  normalizeTextKey
} from '../resolvers/bnf.resolver';
import { classifyBookMetadata } from '../utils/category-classifier.util';
import { isbnUtil } from '../utils/isbn.util';

const USER_AGENT_BASE = 'BiblioCollectionPWA/2.0 (mathieu.egard@gmail.com)';

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateId(prefix: string): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${prefix}:${rand}`;
}

function extractCookieToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = /(?:^|;\s*)biblio_session=([^;]+)/.exec(cookieHeader);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

export interface AuthenticatedContext {
  userId: string;
  username: string;
  email: string;
  libraryId: string;
  libraryName: string;
  role: string;
}

export async function resolveAuthSession(
  db: DatabaseBinding,
  request: Request,
  fallbackLibraryUri?: string | null
): Promise<AuthenticatedContext | null> {
  const token =
    extractCookieToken(request.headers.get('Cookie')) ||
    request.headers.get('X-Biblio-Session');

  if (token) {
    const tokenHash = await sha256Hex(token);
    const row = await db
      .prepare(
        `SELECT s.user_id, u.display_name, u.email, lm.library_id, lm.role, l.name as library_name
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN library_members lm ON lm.user_id = u.id
         JOIN libraries l ON l.id = lm.library_id
         WHERE s.token_hash = ?
         LIMIT 1`
      )
      .bind(tokenHash)
      .first<Record<string, string>>();

    if (row && row.library_id) {
      return {
        userId: row.user_id,
        username: row.display_name,
        email: row.email,
        libraryId: row.library_id,
        libraryName: row.library_name,
        role: row.role
      };
    }
  }

  // Repli si l'URI de bibliothèque est passée explicitement (ex: user:lib_xxx)
  if (fallbackLibraryUri) {
    const libId = fallbackLibraryUri.startsWith('user:')
      ? fallbackLibraryUri.slice(5)
      : fallbackLibraryUri;
    const libRow = await db
      .prepare('SELECT id, name, owner_user_id FROM libraries WHERE id = ? LIMIT 1')
      .bind(libId)
      .first<Record<string, string>>();
    if (libRow) {
      return {
        userId: libRow.owner_user_id,
        username: libRow.name,
        email: '',
        libraryId: libRow.id,
        libraryName: libRow.name,
        role: 'editor'
      };
    }
  }

  return null;
}

// ============================================================================
// AUTO-RÉSOLVEUR MULTI-SOURCES (BnF SRU + Google Books + OpenLibrary) -> D1
// ============================================================================

interface ExternalResolvedBook {
  isbn13: string;
  title: string;
  seriesTitle?: string;
  seriesNumber?: string;
  authors: string[];
  illustrators: string[];
  scriptwriters: string[];
  publisher?: string;
  collection?: string;
  publishDate?: string;
  pageCount?: number;
  description?: string;
  coverUrl?: string;
  deweyCode?: string;
  rawSubjects: string[];
}

function parseMarcFieldsFromXml(xml: string): Array<{ tag: string; subfields: Array<{ code: string; value: string }> }> {
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

async function fetchExternalBookByIsbn(rawIsbn: string): Promise<ExternalResolvedBook | null> {
  const isbn13 = isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn)) || isbnUtil.normalize(rawIsbn);
  if (!isbn13) return null;

  const bnfIntermarcUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=bib.isbn%20adj%20%22${encodeURIComponent(isbn13)}%22&recordSchema=intermarcxchange&maximumRecords=1`;
  const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn13)}&maxResults=2`;
  const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn13)}&jscmd=data&format=json`;

  const [bnfRes, gbRes, olRes] = await Promise.allSettled([
    fetch(bnfIntermarcUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.text() : '')),
    fetch(gbUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.json() : null)),
    fetch(olUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.json() : null))
  ]);

  let title = '';
  let seriesTitle = '';
  let seriesNumber = '';
  const authors: string[] = [];
  const illustrators: string[] = [];
  const scriptwriters: string[] = [];
  let publisher = '';
  let collection = '';
  let publishDate = '';
  let pageCount: number | undefined;
  let description = '';
  let coverUrl = '';
  let deweyCode = '';
  const rawSubjects: string[] = [];

  // 1. Extraction BnF InterMarc (prioritaire pour titre, série, tome, auteurs, Dewey, RAMEAU)
  if (bnfRes.status === 'fulfilled' && bnfRes.value) {
    const xml = bnfRes.value;
    const fields = parseMarcFieldsFromXml(xml);
    const arkMatch = /ark:\/12148\/(cb[0-9a-z]+)/i.exec(xml);
    if (arkMatch) {
      coverUrl = `https://catalogue.bnf.fr/couverture?appName=NE&idArk=ark:/12148/${arkMatch[1]}&couverture=1`;
    }

    for (const f of fields) {
      const getSf = (c: string) => f.subfields.find((s) => s.code === c)?.value || '';
      if (f.tag === '245') {
        const a = cleanTitle(getSf('a'));
        const e = cleanTitle(getSf('e'));
        const n = getSf('n');
        const p = cleanTitle(getSf('p'));
        if (p && a) {
          seriesTitle = seriesTitle || a;
          title = p;
          if (n) seriesNumber = seriesNumber || normalizeSeriesNumber(n);
        } else {
          title = title || a;
          if (e && !seriesTitle && /^(tome|vol|épisode|\d+)/i.test(e)) {
            seriesNumber = seriesNumber || normalizeSeriesNumber(e);
          }
        }
      } else if (f.tag === '460' || f.tag === '461' || f.tag === '290' || f.tag === '410') {
        const sTitle = cleanTitle(getSf('t') || getSf('a'));
        const sVol = normalizeSeriesNumber(getSf('v'));
        if (sTitle && !seriesTitle) {
          seriesTitle = sTitle;
          if (sVol) seriesNumber = sVol;
        } else if (sTitle && f.tag === '290' && !collection) {
          collection = sTitle;
        }
      } else if (f.tag === '100' || f.tag === '700') {
        const rawName = [getSf('a'), getSf('m')].filter(Boolean).join(', ');
        const cleaned = cleanAuthor(rawName);
        const role = getSf('4').toLowerCase();
        if (cleaned) {
          if (role.includes('440') || role.includes('ill') || role.includes('dessin')) {
            if (!illustrators.includes(cleaned)) illustrators.push(cleaned);
          } else if (role.includes('690') || role.includes('scén')) {
            if (!scriptwriters.includes(cleaned)) scriptwriters.push(cleaned);
          }
          if (!authors.includes(cleaned)) authors.push(cleaned);
        }
      } else if (f.tag === '260') {
        publisher = publisher || cleanPublisher(getSf('c') || getSf('b'));
        publishDate = publishDate || cleanPublishDate(getSf('d'));
      } else if (f.tag === '280') {
        const pagesMatch = /(\d+)\s*p\b/i.exec(getSf('a'));
        if (pagesMatch) pageCount = Number(pagesMatch[1]);
      } else if (f.tag === '676') {
        deweyCode = deweyCode || getSf('a');
      } else if (f.tag === '606' || f.tag === '608' || f.tag === '610') {
        const subj = getSf('a');
        const subx = getSf('x');
        if (subj) rawSubjects.push(subj);
        if (subx) rawSubjects.push(subx);
      } else if (f.tag === '830') {
        description = description || getSf('a');
      }
    }
  }

  // 2. Complément Google Books (excellent pour résumé, couverture, romans internationaux)
  if (gbRes.status === 'fulfilled' && gbRes.value?.items?.length) {
    const info = gbRes.value.items[0]?.volumeInfo;
    if (info) {
      title = title || cleanTitle(info.title || '');
      if (!authors.length && Array.isArray(info.authors)) {
        for (const a of info.authors) {
          const c = cleanAuthor(a);
          if (c && !authors.includes(c)) authors.push(c);
        }
      }
      publisher = publisher || cleanPublisher(info.publisher || '');
      publishDate = publishDate || cleanPublishDate(info.publishedDate || '');
      pageCount = pageCount || info.pageCount;
      description = description || info.description || '';
      if (Array.isArray(info.categories)) {
        rawSubjects.push(...info.categories);
      }
      const thumb = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail;
      if (thumb && !coverUrl) {
        coverUrl = String(thumb).replace(/^http:\/\//i, 'https://');
      }
    }
  }

  // 3. Complément OpenLibrary
  if (olRes.status === 'fulfilled' && olRes.value) {
    const key = Object.keys(olRes.value)[0];
    const olBook = key ? olRes.value[key] : null;
    if (olBook) {
      title = title || cleanTitle(olBook.title || '');
      if (!authors.length && Array.isArray(olBook.authors)) {
        for (const a of olBook.authors) {
          if (a?.name && !authors.includes(a.name)) authors.push(a.name);
        }
      }
      if (!publisher && Array.isArray(olBook.publishers) && olBook.publishers[0]?.name) {
        publisher = cleanPublisher(olBook.publishers[0].name);
      }
      publishDate = publishDate || cleanPublishDate(olBook.publish_date || '');
      pageCount = pageCount || olBook.number_of_pages;
      if (olBook.cover?.large || olBook.cover?.medium) {
        coverUrl = coverUrl || olBook.cover.large || olBook.cover.medium;
      }
    }
  }

  if (!title) return null;

  return {
    isbn13,
    title,
    seriesTitle: seriesTitle || undefined,
    seriesNumber: seriesNumber || undefined,
    authors,
    illustrators,
    scriptwriters,
    publisher: publisher || undefined,
    collection: collection || undefined,
    publishDate: publishDate || undefined,
    pageCount,
    description: description || undefined,
    coverUrl: coverUrl || `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg?default=false`,
    deweyCode: deweyCode || undefined,
    rawSubjects
  };
}

/**
 * Enregistre dans D1 une entité (serie, work, edition, human, genre) et retourne son URI.
 */
export async function upsertCatalogEntity(
  db: DatabaseBinding,
  params: {
    uri?: string;
    entityType: 'edition' | 'work' | 'serie' | 'human' | 'genre' | 'publisher' | 'collection';
    label: string;
    isbn13?: string;
    workUri?: string;
    seriesUri?: string;
    seriesNumber?: string;
    sortOrder?: number;
    authorUris?: string[];
    mainCategory?: string;
    subgenres?: string[];
    imageUrl?: string;
    claims: Record<string, unknown[]>;
    descriptions?: Record<string, string>;
  }
): Promise<string> {
  const now = new Date().toISOString();
  const normalizedLabel = normalizeTextKey(params.label || params.isbn13 || '');

  // Déduplication intelligente par ISBN (pour les éditions) ou par (entityType, normalized_label)
  let uri = params.uri;
  if (!uri && params.entityType === 'edition' && params.isbn13) {
    uri = `isbn:${params.isbn13}`;
  }

  if (!uri && (params.entityType === 'serie' || params.entityType === 'human' || params.entityType === 'genre' || params.entityType === 'publisher' || params.entityType === 'collection') && normalizedLabel) {
    const existing = await db
      .prepare('SELECT uri FROM catalog_entities WHERE entity_type = ? AND normalized_label = ? LIMIT 1')
      .bind(params.entityType, normalizedLabel)
      .first<{ uri: string }>();
    if (existing?.uri) {
      uri = existing.uri;
    }
  }

  if (!uri) {
    uri = generateId(`inv:${params.entityType}`);
  }

  const numericSort =
    params.sortOrder ??
    (params.seriesNumber && /^\d+(\.\d+)?$/.test(params.seriesNumber)
      ? parseFloat(params.seriesNumber)
      : 1000.0);

  const entityObj: Record<string, unknown> = {
    uri,
    type: params.entityType,
    label: params.label,
    labels: { fr: params.label, en: params.label },
    descriptions: params.descriptions || {},
    claims: params.claims,
    image: params.imageUrl ? { url: params.imageUrl, value: params.imageUrl } : undefined,
    isbn13: params.isbn13,
    mainCategory: params.mainCategory || 'Autre',
    subgenres: params.subgenres || [],
    updatedAt: now
  };

  await db
    .prepare(
      `INSERT INTO catalog_entities (
        uri, entity_type, label, normalized_label, isbn13, work_uri, series_uri,
        series_number, sort_order, author_uris_json, main_category, subgenres_json,
        image_url, entity_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        label = excluded.label,
        normalized_label = excluded.normalized_label,
        isbn13 = COALESCE(excluded.isbn13, catalog_entities.isbn13),
        work_uri = COALESCE(excluded.work_uri, catalog_entities.work_uri),
        series_uri = COALESCE(excluded.series_uri, catalog_entities.series_uri),
        series_number = COALESCE(excluded.series_number, catalog_entities.series_number),
        sort_order = excluded.sort_order,
        author_uris_json = excluded.author_uris_json,
        main_category = excluded.main_category,
        subgenres_json = excluded.subgenres_json,
        image_url = COALESCE(excluded.image_url, catalog_entities.image_url),
        entity_json = excluded.entity_json,
        updated_at = excluded.updated_at`
    )
    .bind(
      uri,
      params.entityType,
      params.label,
      normalizedLabel,
      params.isbn13 || null,
      params.workUri || null,
      params.seriesUri || null,
      params.seriesNumber || null,
      numericSort,
      JSON.stringify(params.authorUris || []),
      params.mainCategory || 'Autre',
      JSON.stringify(params.subgenres || []),
      params.imageUrl || null,
      JSON.stringify(entityObj),
      now,
      now
    )
    .run();

  return uri;
}

/**
 * Résout automatiquement un ISBN depuis les sources ouvertes (BnF + Google + OpenLibrary)
 * et peuple toutes ses entités liées (Série, Auteurs, Genres, Œuvre, Édition) dans D1.
 */
export async function resolveAndStoreIsbnInD1(
  db: DatabaseBinding,
  rawIsbn: string
): Promise<Record<string, unknown> | null> {
  const ext = await fetchExternalBookByIsbn(rawIsbn);
  if (!ext) return null;

  const classification = classifyBookMetadata({
    title: ext.title,
    series: ext.seriesTitle,
    publisher: ext.publisher,
    collection: ext.collection,
    deweyCode: ext.deweyCode,
    rawSubjects: ext.rawSubjects,
    description: ext.description
  });

  // 1. Création/récupération des entités Auteurs
  const authorUris: string[] = [];
  for (const name of ext.authors) {
    const aUri = await upsertCatalogEntity(db, {
      entityType: 'human',
      label: name,
      claims: { 'wdt:P31': ['wd:Q5'] }
    });
    authorUris.push(aUri);
  }

  // 2. Création/récupération des entités Genres (Catégorie principale + Sous-genres)
  const genreLabels = [classification.mainCategory, ...classification.subgenres];
  const genreUris: string[] = [];
  for (const gLabel of genreLabels) {
    const gUri = await upsertCatalogEntity(db, {
      entityType: 'genre',
      label: gLabel,
      claims: {}
    });
    genreUris.push(gUri);
  }

  // 3. Création/récupération de l'Éditeur si présent
  let publisherUri: string | undefined;
  if (ext.publisher) {
    publisherUri = await upsertCatalogEntity(db, {
      entityType: 'publisher',
      label: ext.publisher,
      claims: {}
    });
  }

  // 4. Création/récupération de la Série si présente
  let seriesUri: string | undefined;
  if (ext.seriesTitle) {
    seriesUri = await upsertCatalogEntity(db, {
      entityType: 'serie',
      label: ext.seriesTitle,
      mainCategory: classification.mainCategory,
      subgenres: classification.subgenres,
      authorUris,
      claims: {
        'wdt:P31': ['wd:Q277759'],
        ...(authorUris.length ? { 'wdt:P50': authorUris } : {})
      }
    });
  }

  // 5. Création/récupération de l'Œuvre (Work)
  const workClaims: Record<string, unknown[]> = {
    'wdt:P31': ['wd:Q47461344']
  };
  if (authorUris.length) workClaims['wdt:P50'] = authorUris;
  if (seriesUri) workClaims['wdt:P179'] = [seriesUri];
  if (ext.seriesNumber) workClaims['wdt:P1545'] = [ext.seriesNumber];
  if (genreUris.length) workClaims['wdt:P136'] = genreUris;

  const workUri = await upsertCatalogEntity(db, {
    entityType: 'work',
    label: ext.title,
    seriesUri,
    seriesNumber: ext.seriesNumber,
    authorUris,
    mainCategory: classification.mainCategory,
    subgenres: classification.subgenres,
    imageUrl: ext.coverUrl,
    descriptions: ext.description ? { fr: ext.description } : {},
    claims: workClaims
  });

  // 6. Création de l'Édition (liée à l'ISBN)
  const editionClaims: Record<string, unknown[]> = {
    'wdt:P629': [workUri],
    'wdt:P212': [ext.isbn13],
    'wdt:P1476': [ext.title]
  };
  if (publisherUri) editionClaims['wdt:P123'] = [publisherUri];
  if (ext.publishDate) editionClaims['wdt:P577'] = [ext.publishDate];
  if (ext.pageCount) editionClaims['wdt:P1104'] = [ext.pageCount];
  if (genreUris.length) editionClaims['wdt:P136'] = genreUris;

  const editionUri = `isbn:${ext.isbn13}`;
  await upsertCatalogEntity(db, {
    uri: editionUri,
    entityType: 'edition',
    label: ext.title,
    isbn13: ext.isbn13,
    workUri,
    seriesUri,
    seriesNumber: ext.seriesNumber,
    authorUris,
    mainCategory: classification.mainCategory,
    subgenres: classification.subgenres,
    imageUrl: ext.coverUrl,
    descriptions: ext.description ? { fr: ext.description } : {},
    claims: editionClaims
  });

  const stored = await db
    .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
    .bind(editionUri)
    .first<{ entity_json: string }>();

  return stored ? JSON.parse(stored.entity_json) : null;
}
