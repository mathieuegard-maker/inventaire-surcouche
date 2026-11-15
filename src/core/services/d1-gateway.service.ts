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
  cleanSeriesName,
  cleanTitle,
  normalizeSeriesNumber,
  normalizeTextKey,
  parseIntermarcRecord,
  parseSeriesFromTitle
} from '../resolvers/bnf.resolver';
import { classifyBookMetadata } from '../utils/category-classifier.util';
import { isbnUtil } from '../utils/isbn.util';
import { getLevenshteinDistance } from '../utils/string.util';

const USER_AGENT_BASE = 'BiblioCollectionPWA/2.0 (mathieu.egard@gmail.com)';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function isbn13ToIsbn10(isbn13: string): string | null {
  const clean = isbnUtil.normalize(isbn13);
  if (!/^978\d{10}$/.test(clean)) return null;
  const core = clean.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(core[i]) * (10 - i);
  }
  const rem = (11 - (sum % 11)) % 11;
  const check = rem === 10 ? 'X' : String(rem);
  return `${core}${check}`;
}

async function isValidRemoteCoverImage(
  url: string,
  minBytes = 1500,
  rejectExactBytes?: number
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Encoding': 'identity'
      }
    });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream')) return false;
    const buf = await res.arrayBuffer();
    const len = buf.byteLength;
    if (len < minBytes) return false;
    if (rejectExactBytes && len === rejectExactBytes) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Cascade multi-sources vérifiée pour récupérer la meilleure couverture disponible :
 * 1. BnF 950$a (idImage officiel numérisé)
 * 2. CDN Amazon Direct ISBN-10 (.08.LZZZZZZZ.jpg / .01._SCLZZZZZZZ_SX500_.jpg > 1500 octets)
 * 3. CDN Librairies Françaises (Eyrolles/Dilicom H1400, en écartant le placeholder exact de 63601 octets)
 * 4. Couverture directe OpenLibrary / Google Books / Inventaire
 * 5. Recherche d'image Apple Books (iTunes Search API FR par ISBN puis Titre+Auteur)
 * 6. OpenLibrary Covers par ISBN (si existante)
 */
export async function resolveBestCoverUrl(
  isbn13: string,
  candidates: {
    bnfCoverUrl?: string;
    gbCoverUrl?: string;
    olCoverUrl?: string;
    invCoverUrl?: string;
    title?: string;
    author?: string;
  } = {}
): Promise<string | undefined> {
  if (candidates.bnfCoverUrl) {
    return candidates.bnfCoverUrl;
  }

  const cleanIsbn13 = isbnUtil.normalize(isbn13);
  const isbn10 = isbn13ToIsbn10(cleanIsbn13);

  // 2. CDN Amazon Direct ISBN-10 (excellent pour les BD franco-belges Dupuis, Lombard, Dargaud, Casterman)
  if (isbn10) {
    const amazonEuUrl = `https://images-eu.ssl-images-amazon.com/images/P/${isbn10}.08.LZZZZZZZ.jpg`;
    if (await isValidRemoteCoverImage(amazonEuUrl, 1500)) {
      return amazonEuUrl;
    }
    const amazonMediaUrl = `https://m.media-amazon.com/images/P/${isbn10}.01._SCLZZZZZZZ_SX500_.jpg`;
    if (await isValidRemoteCoverImage(amazonMediaUrl, 1500)) {
      return amazonMediaUrl;
    }
  }

  // 3. CDN Librairies Françaises (fonctionne sur 978... et 97910..., en rejetant le placeholder de 63601 octets)
  if (cleanIsbn13.length === 13) {
    const eyrollesUrl = `https://servimg.eyrolles.com/static/media/${cleanIsbn13.slice(-4)}/${cleanIsbn13}_internet_h1400.jpg`;
    if (await isValidRemoteCoverImage(eyrollesUrl, 2000, 63601)) {
      return eyrollesUrl;
    }
  }

  // 4. Candidats API directs (Google Books, OpenLibrary, Inventaire)
  const directCandidates = [
    candidates.gbCoverUrl,
    candidates.olCoverUrl,
    candidates.invCoverUrl
  ].filter(Boolean) as string[];

  for (const url of directCandidates) {
    if (await isValidRemoteCoverImage(url, 1000)) {
      return url;
    }
  }

  // 5. Recherche Apple Books / iTunes FR (par ISBN puis par Titre + Auteur)
  const searchTerms = [
    cleanIsbn13,
    candidates.title ? `${candidates.title} ${candidates.author || ''}`.trim() : ''
  ].filter(Boolean);

  for (const term of searchTerms) {
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=fr&entity=ebook&limit=1`;
      const res = await fetch(itunesUrl, { headers: { 'User-Agent': BROWSER_USER_AGENT } });
      if (res.ok) {
        const data = (await res.json()) as { results?: Array<{ artworkUrl100?: string }> };
        const art = data?.results?.[0]?.artworkUrl100;
        if (art) {
          return art.replace('100x100bb.jpg', '600x600bb.jpg');
        }
      }
    } catch {
      // Ignorer et passer à la source suivante
    }
  }

  // 6. OpenLibrary Covers par ISBN (avec default=false pour renvoyer 404 si absente)
  if (cleanIsbn13.length === 13) {
    const olIsbnCover = `https://covers.openlibrary.org/b/isbn/${cleanIsbn13}-L.jpg?default=false`;
    if (await isValidRemoteCoverImage(olIsbnCover, 1500)) {
      return olIsbnCover;
    }
  }

  return undefined;
}

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

  // Utilisation de `bib.anywhere all` sur BnF SRU pour trouver aussi les EAN-13 stockés en zone 038$a (livres 1990-2007 dont le 020$a est en ISBN-10)
  const bnfIntermarcUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=bib.anywhere%20all%20%22${encodeURIComponent(isbn13)}%22&recordSchema=intermarcxchange&maximumRecords=1`;
  const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn13)}&maxResults=2`;
  const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn13)}&jscmd=data&format=json`;
  const invUrl = `https://inventaire.io/api/entities?action=by-uris&uris=isbn:${encodeURIComponent(isbn13)}&attributes=info|labels|descriptions|claims|image&relatives=wdt:P629|wdt:P179`;

  const [bnfRes, gbRes, olRes, invRes] = await Promise.allSettled([
    fetch(bnfIntermarcUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.text() : '')),
    fetch(gbUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.json() : null)),
    fetch(olUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.json() : null)),
    fetch(invUrl, { headers: { 'User-Agent': USER_AGENT_BASE } }).then((r) => (r.ok ? r.json() : null))
  ]);

  let title = '';
  let seriesTitle = '';
  let seriesNumber = '';
  let unnumberedEnsembleTitle = '';
  const authors: string[] = [];
  const illustrators: string[] = [];
  const scriptwriters: string[] = [];
  let publisher = '';
  let collection = '';
  let publishDate = '';
  let pageCount: number | undefined;
  let description = '';
  let bnfCoverUrl = '';
  let gbCoverUrl = '';
  let olCoverUrl = '';
  let invCoverUrl = '';
  let deweyCode = '';
  const rawSubjects: string[] = [];

  // 1. Extraction BnF InterMarc (prioritaire pour titre, série 460$t/$v, tome, auteurs, Dewey, RAMEAU)
  if (bnfRes.status === 'fulfilled' && bnfRes.value) {
    const xml = bnfRes.value;
    const fields = parseMarcFieldsFromXml(xml);

    for (const f of fields) {
      const getSf = (c: string) => f.subfields.find((s) => s.code === c)?.value || '';
      if (f.tag === '950') {
        const coverId = getSf('a');
        if (coverId) {
          // Uniquement si le tag 950$a (idImage numérisée réelle) est présent ! (Les URLs idArk génériques renvoient HTTP 500)
          bnfCoverUrl = `https://catalogue.bnf.fr/couverture?idImage=${coverId}&couverture=1&appName=NE`;
        }
      } else if (f.tag === '245') {
        const a = cleanTitle(getSf('a'));
        const e = cleanTitle(getSf('e'));
        const u = getSf('u');
        const n = getSf('n');
        const p = cleanTitle(getSf('p'));
        if (p && a) {
          seriesTitle = seriesTitle || cleanSeriesName(a);
          title = p;
          if (n || u) seriesNumber = seriesNumber || normalizeSeriesNumber(n || u);
        } else {
          title = title || a;
          if (u) seriesNumber = seriesNumber || normalizeSeriesNumber(u);
          if (e && !seriesTitle && /^(?:(?:tome|vol\.?|volume|épisode|n°)\s*\d+|\d{1,3})$/i.test(e.trim())) {
            seriesNumber = seriesNumber || normalizeSeriesNumber(e);
          }
        }
      } else if (f.tag === '460' || f.tag === '461') {
        // Notice d'ensemble = vraie série si numérotée ($v présent ou numéro de tome connu), sinon candidate série/collection
        const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
        const sVol = normalizeSeriesNumber(getSf('v'));
        if (sTitle && sVol && !seriesTitle) {
          seriesTitle = sTitle;
          seriesNumber = sVol;
        } else if (sTitle && !unnumberedEnsembleTitle) {
          unnumberedEnsembleTitle = sTitle;
        }
      } else if (f.tag === '290' || f.tag === '410' || f.tag === '295') {
        // Collection éditoriale vs Série numérotée :
        // Uniquement considérée comme série si un numéro de volume ($v) est présent ! Sinon c'est une collection éditoriale (ex: "Les Arènes BD").
        const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
        const sVol = normalizeSeriesNumber(getSf('v'));
        if (sTitle && sVol && !seriesTitle) {
          seriesTitle = sTitle;
          seriesNumber = sVol;
        } else if (sTitle && !collection) {
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
      if (thumb) {
        gbCoverUrl = String(thumb).replace(/^http:\/\//i, 'https://');
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
        olCoverUrl = olBook.cover.large || olBook.cover.medium;
      }
    }
  }

  // 4. Complément Graphe Ouvert (Wikidata / Inventaire public par ISBN)
  if (invRes.status === 'fulfilled' && invRes.value?.entities) {
    const ents = invRes.value.entities as Record<string, any>;
    const edEnt =
      ents[`isbn:${isbn13}`] ||
      Object.values(ents).find((e: any) => e?.type === 'edition');
    if (edEnt) {
      const edTitle = cleanTitle(
        edEnt.claims?.['wdt:P1476']?.[0] || edEnt.labels?.fr || edEnt.labels?.en || ''
      );
      title = title || edTitle;
      const rawImg = edEnt.image?.url || edEnt.claims?.['invp:P2']?.[0];
      if (typeof rawImg === 'string' && rawImg.trim()) {
        const hash = rawImg.split('/').pop();
        if (hash) {
          invCoverUrl = `https://inventaire.io/img/entities/300x300/${hash}`;
        }
      }
      const workUri = edEnt.claims?.['wdt:P629']?.[0];
      const workEnt = workUri ? ents[workUri] : undefined;
      if (workEnt) {
        const ord = workEnt.claims?.['wdt:P1545']?.[0];
        if (ord && !seriesNumber) {
          seriesNumber = normalizeSeriesNumber(String(ord));
        }
        const serieUri = workEnt.claims?.['wdt:P179']?.[0];
        const serieEnt = serieUri ? ents[serieUri] : undefined;
        if (serieEnt && !seriesTitle) {
          const sLabel = cleanSeriesName(
            serieEnt.labels?.fr || serieEnt.labels?.en || serieEnt.label || ''
          );
          if (sLabel) seriesTitle = sLabel;
        }
      }
    }
  }

  if (!title) return null;

  // Nettoyage intelligent du titre :
  // - Si `seriesTitle` est déjà connue (ex: "Les Schtroumpfs"), un suffixe ", tome 15" dans le titre de l'album
  //   doit simplement être retiré du titre (et fournir `seriesNumber` s'il manquait) SANS écraser `seriesTitle` !
  const parsedFromTitle = parseSeriesFromTitle(title);
  if (parsedFromTitle.seriesNumber && !seriesNumber) {
    seriesNumber = normalizeSeriesNumber(parsedFromTitle.seriesNumber);
  }
  if (parsedFromTitle.series && !seriesTitle) {
    seriesTitle = cleanSeriesName(parsedFromTitle.series);
  }
  if (parsedFromTitle.title) {
    title = cleanTitle(parsedFromTitle.title);
  }

  // Si un 460$t sans $v a été trouvé : c'est une série uniquement si un numéro de tome existe par ailleurs (245$u, titre, P1545),
  // sinon c'est une collection éditoriale non numérotée (ex: "Yummy !").
  if (unnumberedEnsembleTitle) {
    if (seriesNumber && !seriesTitle) {
      seriesTitle = unnumberedEnsembleTitle;
    } else if (!collection) {
      collection = unnumberedEnsembleTitle;
    }
  }

  // Cascade de résolution et vérification de la couverture
  const coverUrl = await resolveBestCoverUrl(isbn13, {
    bnfCoverUrl: bnfCoverUrl || undefined,
    gbCoverUrl: gbCoverUrl || undefined,
    olCoverUrl: olCoverUrl || undefined,
    invCoverUrl: invCoverUrl || undefined,
    title,
    author: authors[0]
  });

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
    coverUrl,
    deweyCode: deweyCode || undefined,
    rawSubjects
  };
}

/**
 * Découvre et indexe dans D1 tous les tomes d'une série via la BnF SRU InterMarc
 * afin que l'ouverture d'une série ou d'une fiche permette immédiatement la sélection multiple de tous les tomes.
 */
export async function expandSeriesVolumesInD1(
  db: DatabaseBinding,
  seriesUri: string,
  seriesTitle?: string,
  authorHint?: string
): Promise<void> {
  try {
    let targetTitle = seriesTitle;
    if (!targetTitle) {
      const sRow = await db
        .prepare('SELECT label FROM catalog_entities WHERE uri = ? LIMIT 1')
        .bind(seriesUri)
        .first<{ label: string }>();
      targetTitle = sRow?.label;
    }
    if (!targetTitle) return;

    const cleanTargetSeries = cleanSeriesName(targetTitle);
    const targetSeriesKey = normalizeTextKey(cleanTargetSeries);
    if (!targetSeriesKey) return;

    const cleanSeriesQuery = cleanTargetSeries.replace(/["()]/g, ' ').trim();
    const cleanAuthorQuery = authorHint ? authorHint.replace(/["()]/g, ' ').trim() : '';

    const fetchBnfSeriesXml = async (withAuthor?: string): Promise<string[]> => {
      const cql = withAuthor
        ? `(bib.title all "${cleanSeriesQuery}") and (bib.author all "${withAuthor}")`
        : `bib.title all "${cleanSeriesQuery}"`;
      const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=60&startRecord=1`;
      const res = await fetch(bnfUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
      if (!res.ok) return [];
      const xml = await res.text();
      return xml.split('<srw:record>').slice(1);
    };

    let rawRecords = await fetchBnfSeriesXml(cleanAuthorQuery || undefined);
    if (rawRecords.length < 2 && cleanAuthorQuery) {
      const fallback = await fetchBnfSeriesXml();
      if (fallback.length > rawRecords.length) {
        rawRecords = fallback;
      }
    }

    const candidates: Array<NonNullable<ReturnType<typeof parseIntermarcRecord>>> = [];
    for (const recXml of rawRecords) {
      const parsed = parseIntermarcRecord(recXml);
      if (!parsed || !parsed.series) continue;
      const candSeriesKey = normalizeTextKey(parsed.series);
      const isMatch =
        candSeriesKey === targetSeriesKey ||
        (candSeriesKey.length >= 4 && getLevenshteinDistance(candSeriesKey, targetSeriesKey) <= 2);
      if (!isMatch) continue;
      if (parsed._lang && parsed._lang !== 'fre') continue;
      candidates.push(parsed);
    }

    // Dédoublonnage par numéro de tome ou titre normalisé
    const byVolumeKey = new Map<string, typeof candidates>();
    for (const cand of candidates) {
      const volKey = cand.seriesNumber
        ? `num:${normalizeSeriesNumber(cand.seriesNumber)}`
        : `title:${normalizeTextKey(cand.title)}`;
      const list = byVolumeKey.get(volKey) || [];
      list.push(cand);
      byVolumeKey.set(volKey, list);
    }

    const existingRows = await db
      .prepare('SELECT isbn13, series_number FROM catalog_entities WHERE series_uri = ?')
      .bind(seriesUri)
      .all<{ isbn13: string | null; series_number: string | null }>();

    const existingIsbns = new Set(
      (existingRows.results || []).map((r) => r.isbn13).filter(Boolean) as string[]
    );
    const existingVolNums = new Set(
      (existingRows.results || [])
        .map((r) => (r.series_number ? normalizeSeriesNumber(r.series_number) : ''))
        .filter(Boolean)
    );

    for (const group of byVolumeKey.values()) {
      group.sort((a, b) => {
        const score = (c: (typeof group)[0]) =>
          (c._lang === 'fre' ? 20 : 0) +
          (c.isbn.startsWith('9782') || c.isbn.startsWith('97910') ? 15 : 0) +
          (c.coverUrl ? 10 : 0) +
          (c._hasPrimaryIsbn ? 5 : 0);
        return score(b) - score(a);
      });
      const top = group[0];
      const normNum = top.seriesNumber ? normalizeSeriesNumber(top.seriesNumber) : '';
      if (existingIsbns.has(top.isbn) || (normNum && existingVolNums.has(normNum))) {
        continue;
      }

      const resolvedCoverUrl =
        top.coverUrl ||
        (await resolveBestCoverUrl(top.isbn, {
          title: top.title,
          author: top.authors[0]
        }));

      const authorUris: string[] = [];
      for (const aName of top.authors) {
        const aUri = await upsertCatalogEntity(db, {
          entityType: 'human',
          label: aName,
          claims: { 'wdt:P31': ['wd:Q5'] }
        });
        authorUris.push(aUri);
      }

      let publisherUri: string | undefined;
      if (top.publisher) {
        publisherUri = await upsertCatalogEntity(db, {
          entityType: 'publisher',
          label: top.publisher,
          claims: {}
        });
      }

      const workClaims: Record<string, unknown[]> = {
        'wdt:P31': ['wd:Q47461344'],
        'wdt:P179': [seriesUri]
      };
      if (authorUris.length) workClaims['wdt:P50'] = authorUris;
      if (normNum) workClaims['wdt:P1545'] = [normNum];

      const workUri = await upsertCatalogEntity(db, {
        entityType: 'work',
        label: top.title,
        seriesUri,
        seriesNumber: normNum || undefined,
        authorUris,
        mainCategory: 'BD',
        imageUrl: resolvedCoverUrl,
        claims: workClaims
      });

      const editionClaims: Record<string, unknown[]> = {
        'wdt:P629': [workUri],
        'wdt:P212': [top.isbn],
        'wdt:P1476': [top.title]
      };
      if (publisherUri) editionClaims['wdt:P123'] = [publisherUri];
      if (top.publishDate) editionClaims['wdt:P577'] = [top.publishDate];
      if (top.pageCount) editionClaims['wdt:P1104'] = [top.pageCount];

      await upsertCatalogEntity(db, {
        uri: `isbn:${top.isbn}`,
        entityType: 'edition',
        label: top.title,
        isbn13: top.isbn,
        workUri,
        seriesUri,
        seriesNumber: normNum || undefined,
        authorUris,
        mainCategory: 'BD',
        imageUrl: resolvedCoverUrl,
        claims: editionClaims
      });

      existingIsbns.add(top.isbn);
      if (normNum) existingVolNums.add(normNum);
    }
  } catch (e) {
    console.warn('[D1 SERIES EXPAND] Erreur expansion automatique de série :', e);
  }
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
        series_uri = excluded.series_uri,
        series_number = excluded.series_number,
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

  // 5. Création/récupération de l'Œuvre (Work) en réutilisant work_uri si l'édition existe déjà
  const editionUri = `isbn:${ext.isbn13}`;
  const existingEd = await db
    .prepare('SELECT work_uri FROM catalog_entities WHERE uri = ? LIMIT 1')
    .bind(editionUri)
    .first<{ work_uri: string | null }>();

  let collectionUri: string | undefined;
  if (ext.collection) {
    collectionUri = await upsertCatalogEntity(db, {
      entityType: 'collection',
      label: ext.collection,
      claims: {}
    });
  }

  const workClaims: Record<string, unknown[]> = {
    'wdt:P31': ['wd:Q47461344']
  };
  if (authorUris.length) workClaims['wdt:P50'] = authorUris;
  if (seriesUri) workClaims['wdt:P179'] = [seriesUri];
  if (ext.seriesNumber) workClaims['wdt:P1545'] = [ext.seriesNumber];
  if (genreUris.length) workClaims['wdt:P136'] = genreUris;

  const workUri = await upsertCatalogEntity(db, {
    uri: existingEd?.work_uri || undefined,
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
  if (collectionUri) editionClaims['wdt:P195'] = [collectionUri];
  if (ext.publishDate) editionClaims['wdt:P577'] = [ext.publishDate];
  if (ext.pageCount) editionClaims['wdt:P1104'] = [ext.pageCount];
  if (genreUris.length) editionClaims['wdt:P136'] = genreUris;

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

/**
 * Ré-enrichit tous les livres existants dans D1 (séries, numéros de tomes, couvertures multi-sources)
 * et nettoie les fausses séries créées à partir de collections éditoriales non numérotées.
 */
export async function rehydrateAllCatalogEntitiesInD1(
  db: DatabaseBinding,
  options: { offset?: number; limit?: number } = {}
): Promise<{
  updated: number;
  total: number;
  details: Array<{
    isbn: string;
    title: string;
    series?: string;
    seriesNumber?: string;
    coverUrl?: string;
  }>;
}> {
  const allRows = await db
    .prepare("SELECT isbn13, uri FROM catalog_entities WHERE entity_type = 'edition' AND isbn13 IS NOT NULL ORDER BY uri ASC")
    .all<{ isbn13: string; uri: string }>();

  const fullList = allRows.results || [];
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 8;
  const slice = fullList.slice(offset, offset + limit);

  const details: Array<{
    isbn: string;
    title: string;
    series?: string;
    seriesNumber?: string;
    coverUrl?: string;
  }> = [];

  for (const row of slice) {
    if (!row.isbn13) continue;
    // Réinitialiser l'image_url afin de forcer la cascade de couverture vérifiée
    await db
      .prepare(
        "UPDATE catalog_entities SET image_url = NULL WHERE uri = ? OR uri IN (SELECT work_uri FROM catalog_entities WHERE uri = ?)"
      )
      .bind(row.uri, row.uri)
      .run();

    const updatedEntity = await resolveAndStoreIsbnInD1(db, row.isbn13);
    if (updatedEntity) {
      const updatedRow = await db
        .prepare(
          `SELECT e.label, e.series_number, e.image_url, s.label as series_label
           FROM catalog_entities e
           LEFT JOIN catalog_entities s ON s.uri = e.series_uri
           WHERE e.uri = ? LIMIT 1`
        )
        .bind(row.uri)
        .first<{
          label: string;
          series_number: string | null;
          image_url: string | null;
          series_label: string | null;
        }>();

      details.push({
        isbn: row.isbn13,
        title: updatedRow?.label || String(updatedEntity.label || ''),
        series: updatedRow?.series_label || undefined,
        seriesNumber: updatedRow?.series_number || undefined,
        coverUrl: updatedRow?.image_url || undefined
      });
    }
  }

  // Supprimer les entités `serie` orphelines qui ne sont plus rattachées à aucune œuvre ni édition
  await db
    .prepare(
      `DELETE FROM catalog_entities
       WHERE entity_type = 'serie'
         AND uri NOT IN (
           SELECT DISTINCT series_uri FROM catalog_entities WHERE series_uri IS NOT NULL
         )`
    )
    .run();

  return { updated: details.length, total: fullList.length, details };
}
