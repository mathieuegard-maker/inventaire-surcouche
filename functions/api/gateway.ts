// functions/api/gateway.ts
// Point d'entrée Cloudflare Pages Functions pour /api/gateway.
// 1. Délègue toutes les opérations de compte, famille, inventaire, wishlist, prêts, entités et séries à Cloudflare D1 (`handleD1GatewayAction`).
// 2. Fournit les proxys ouverts (`external-lookup` BnF/OpenLibrary, `google-books`, `image-proxy`).

import type { AppBackendEnv } from '../../src/core/adapters/storage-db.interface';
import { handleD1GatewayAction } from '../../src/core/services/d1-gateway-actions.service';
import {
  getStoredCover,
  parseCoverDataUrl,
  storeCompressedCover
} from '../../src/core/services/d1-cover-storage.service';

const USER_AGENT_BASE = 'BiblioCollectionPWA/2.0 (mathieu.egard@gmail.com)';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function isPrivateOrLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:')
  ) {
    return true;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4Match) {
    const [, aStr, bStr] = ipv4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
  }
  return false;
}

function validateImageProxyUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname || isPrivateOrLocalHostname(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function resilientFetch(url: string, options?: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }
  throw new Error('Unreachable');
}

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export const onRequest = async (context: {
  request: Request;
  env: AppBackendEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<Response> => {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (!action) {
    return jsonResp({ error: 'Paramètre action manquant' }, 400);
  }

  let body: Record<string, any> | null = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const text = await request.text();
      if (text) body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  try {
    // 1. Prise en charge prioritaire par notre base autonome Cloudflare D1
    if (env?.DB) {
      const d1Response = await handleD1GatewayAction(action, request, env, body);
      if (d1Response) return d1Response;
    }

    // 2. Proxys de métadonnées ouvertes (BnF SRU, OpenLibrary, Google Books, Image Proxy)
    switch (action) {
      case 'external-lookup': {
        const isbn = url.searchParams.get('isbn');
        const source = url.searchParams.get('source');
        const series = url.searchParams.get('series');
        const author = url.searchParams.get('author');
        const schema = url.searchParams.get('schema');

        if (!source) return jsonResp({ error: 'Source requise (bnf ou openlibrary)' }, 400);

        if (source === 'bnf') {
          const recordSchema = schema === 'intermarc' ? 'intermarcxchange' : 'dublincore';
          const ensIds = url.searchParams.get('ensIds');
          if (ensIds && ensIds.trim()) {
            const cleanIds = ensIds.replace(/[^0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            const maxRec = Math.min(Math.max(Number(url.searchParams.get('maxRecords')) || 80, 1), 100);
            const startRec = Math.max(Number(url.searchParams.get('startRecord')) || 1, 1);
            const cql = `bib.ens2bib any "${cleanIds}"`;
            const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=${recordSchema}&maximumRecords=${maxRec}&startRecord=${startRec}`;
            const bnfRes = await resilientFetch(bnfUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
            const bnfText = await bnfRes.text();
            return new Response(bnfText, {
              status: bnfRes.status,
              headers: { 'Content-Type': 'application/xml; charset=utf-8' }
            });
          }

          const title = url.searchParams.get('title');
          const publisher = url.searchParams.get('publisher');
          const queryMode = url.searchParams.get('queryMode');

          if (title && title.trim()) {
            const cleanTerm = (val: string) => val.replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim();
            const cleanTitle = cleanTerm(title);
            const cleanAuthor = author ? cleanTerm(author) : '';
            const cleanPublisher = publisher ? cleanTerm(publisher) : '';
            const field = queryMode === 'anywhere' ? 'bib.anywhere' : 'bib.title';

            const clauses = [`(${field} all "${cleanTitle}")`];
            if (cleanAuthor) clauses.push(`(bib.author all "${cleanAuthor}")`);
            if (cleanPublisher) clauses.push(`(bib.publisher all "${cleanPublisher}")`);

            const cql = clauses.length === 1 ? clauses[0].slice(1, -1) : clauses.join(' and ');
            const maxRec = Math.min(Math.max(Number(url.searchParams.get('maxRecords')) || 25, 1), 100);
            const startRec = Math.max(Number(url.searchParams.get('startRecord')) || 1, 1);
            const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=${recordSchema}&maximumRecords=${maxRec}&startRecord=${startRec}`;
            const bnfRes = await resilientFetch(bnfUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
            const bnfText = await bnfRes.text();
            return new Response(bnfText, {
              status: bnfRes.status,
              headers: { 'Content-Type': 'application/xml; charset=utf-8' }
            });
          }

          if (series && series.trim()) {
            const cleanSeries = series.replace(/["()]/g, ' ').trim();
            const cleanAuthor = author ? author.replace(/["()]/g, ' ').trim() : '';
            const cql = cleanAuthor
              ? `(bib.title all "${cleanSeries}") and (bib.author all "${cleanAuthor}")`
              : `bib.title all "${cleanSeries}"`;
            const maxRec = Math.min(Math.max(Number(url.searchParams.get('maxRecords')) || 50, 1), 100);
            const startRec = Math.max(Number(url.searchParams.get('startRecord')) || 1, 1);
            const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=${recordSchema}&maximumRecords=${maxRec}&startRecord=${startRec}`;
            const bnfRes = await resilientFetch(bnfUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
            const bnfText = await bnfRes.text();
            return new Response(bnfText, {
              status: bnfRes.status,
              headers: { 'Content-Type': 'application/xml; charset=utf-8' }
            });
          }

          if (author && author.trim()) {
            const cleanAuthor = author.replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim();
            const maxRec = Math.min(Math.max(Number(url.searchParams.get('maxRecords')) || 50, 1), 100);
            const startRec = Math.max(Number(url.searchParams.get('startRecord')) || 1, 1);
            const cql = `bib.author all "${cleanAuthor}"`;
            const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=${recordSchema}&maximumRecords=${maxRec}&startRecord=${startRec}`;
            const bnfRes = await resilientFetch(bnfUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
            const bnfText = await bnfRes.text();
            return new Response(bnfText, {
              status: bnfRes.status,
              headers: { 'Content-Type': 'application/xml; charset=utf-8' }
            });
          }

          if (!isbn) return jsonResp({ error: 'ISBN ou série requis' }, 400);
          const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=bib.anywhere%20all%20%22${encodeURIComponent(isbn)}%22&recordSchema=${recordSchema}`;
          const bnfRes = await resilientFetch(bnfUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
          const bnfText = await bnfRes.text();
          return new Response(bnfText, {
            status: bnfRes.status,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' }
          });
        }

        if (source === 'openlibrary') {
          const olQuery = url.searchParams.get('q');
          if (olQuery && olQuery.trim()) {
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 40);
            const olSearchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(olQuery.trim())}&fields=key,title,subtitle,author_name,publisher,first_publish_year,isbn,cover_i,language,subject&limit=${limit}`;
            const olRes = await resilientFetch(olSearchUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
            const olText = await olRes.text();
            return new Response(olText, {
              status: olRes.status,
              headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
          }
          if (!isbn) return jsonResp({ error: 'ISBN ou requête q requis' }, 400);
          const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=data&format=json`;
          const olRes = await resilientFetch(olUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
          const olText = await olRes.text();
          return new Response(olText, {
            status: olRes.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        }

        return jsonResp({ error: `Source '${source}' non reconnue.` }, 400);
      }

      case 'google-books': {
        const isbn = url.searchParams.get('isbn');
        const q = url.searchParams.get('q');
        const queryParam = isbn ? `isbn:${encodeURIComponent(isbn)}` : q ? encodeURIComponent(q) : '';
        if (!queryParam) return jsonResp({ error: 'ISBN ou paramètre q requis' }, 400);

        const maxResults = Math.min(Math.max(Number(url.searchParams.get('maxResults')) || (isbn ? 10 : 40), 1), 40);
        const startIndex = Math.max(Number(url.searchParams.get('startIndex')) || 0, 0);
        const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${queryParam}&maxResults=${maxResults}&startIndex=${startIndex}`;
        const gbRes = await resilientFetch(gbUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
        const gbText = await gbRes.text();
        return new Response(gbText, {
          status: gbRes.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }

      case 'cover-store': {
        if (request.method !== 'POST') {
          return jsonResp({ error: 'Méthode POST requise' }, 405);
        }
        const parsedData = parseCoverDataUrl(String(body?.dataUrl || ''));
        if (!parsedData) {
          return jsonResp({ error: 'Image WebP/JPEG valide requise' }, 400);
        }
        const isbnParam = body?.isbn13 ? String(body.isbn13) : undefined;
        const urlParam = body?.url ? String(body.url) : undefined;
        const saved = await storeCompressedCover(env, {
          isbn: isbnParam,
          url: urlParam,
          contentType: parsedData.contentType,
          bytes: parsedData.bytes,
          base64Data: parsedData.base64
        });
        return jsonResp(saved, saved.ok ? 200 : 500);
      }

      case 'image-proxy': {
        const rawUrl = url.searchParams.get('url');
        const isbnParam = url.searchParams.get('isbn');
        const trimmedUrl = rawUrl?.trim() || '';

        // 1. Vérifier d'abord le stockage central Cloudflare R2 / D1
        // Si une URL précise est demandée, on ne cherche que par URL pour ne pas écraser les couvertures alternatives d'autres éditions.
        const stored = await getStoredCover(env, {
          isbn: trimmedUrl ? undefined : isbnParam,
          url: trimmedUrl || undefined
        });
        if (stored) {
          return new Response(stored.bytes, {
            status: 200,
            headers: {
              'Content-Type': stored.contentType,
              'Cache-Control': 'public, max-age=31536000, immutable',
              'X-Cover-Cache': `${stored.storage.toUpperCase()}-HIT`
            }
          });
        }

        if (!trimmedUrl) {
          return jsonResp({ error: 'URL ou couverture en cache requise' }, 404);
        }
        const validatedUrl = validateImageProxyUrl(trimmedUrl);
        if (!validatedUrl) {
          return jsonResp({ error: 'URL image invalide ou interdite' }, 400);
        }

        const response = await resilientFetch(validatedUrl.toString(), {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            Referer: `${validatedUrl.protocol}//${validatedUrl.host}/`
          }
        });
        if (!response.ok) {
          return jsonResp({ error: `Erreur réseau distante: ${response.status}` }, 502);
        }
        if (response.url && !validateImageProxyUrl(response.url)) {
          return jsonResp({ error: 'Redirection image interdite' }, 400);
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().startsWith('image/')) {
          return jsonResp({ error: 'Le contenu distant n est pas une image' }, 415);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength < 800 || arrayBuffer.byteLength === 63601) {
          return jsonResp({ error: 'Image placeholder vide ou générique rejetée' }, 404);
        }
        if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
          return jsonResp({ error: 'Image trop volumineuse' }, 413);
        }

        // 2. Mise en cache read-through asynchrone vers R2 / D1 pour résister à l'extinction future du CDN source
        const persistTask = storeCompressedCover(env, {
          isbn: isbnParam,
          url: trimmedUrl,
          contentType,
          bytes: new Uint8Array(arrayBuffer)
        });
        if (typeof context.waitUntil === 'function') {
          context.waitUntil(persistTask);
        } else {
          await persistTask;
        }

        return new Response(arrayBuffer, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Cover-Cache': 'MISS'
          }
        });
      }

      case 'work-edition-covers': {
        const isbnParam = (url.searchParams.get('isbn') || '').replace(/[^0-9Xx]/g, '').trim();
        const titleParam = (url.searchParams.get('title') || '').trim();
        const authorParam = (url.searchParams.get('author') || '').trim();
        let targetWorkUri = (url.searchParams.get('workUri') || '').trim();
        const workUrisToCheck = new Set<string>();
        if (targetWorkUri && targetWorkUri.startsWith('wd:')) {
          workUrisToCheck.add(targetWorkUri);
        }

        const coverSet = new Set<string>();
        const editionIsbns = new Set<string>();

        const quickFetchJson = async (targetUrl: string, headers: Record<string, string> = {}, ms = 3200) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          try {
            const res = await fetch(targetUrl, {
              headers: { 'User-Agent': USER_AGENT_BASE, Accept: 'application/json', ...headers },
              signal: controller.signal
            });
            return res.ok ? await res.json() : null;
          } catch {
            return null;
          } finally {
            clearTimeout(timer);
          }
        };

        const addImg = (raw?: string | null) => {
          const clean = (raw || '').trim();
          if (!clean || clean.toLowerCase().endsWith('.svg')) return;
          if (clean.startsWith('http://') || clean.startsWith('https://')) {
            coverSet.add(clean.replace(/^http:\/\//i, 'https://'));
          } else if (clean.startsWith('/img/') || !clean.includes('/')) {
            const hash = clean.split('/').pop();
            if (hash) coverSet.add(`https://inventaire.io/img/entities/500x500/${hash}`);
          }
        };

        // 1. Inventaire.io : ISBN + Recherche textuelle d'œuvre (si local inv:work_... ou ISBN inconnu)
        const invTasks: Promise<void>[] = [];

        if (workUrisToCheck.size === 0 && isbnParam) {
          invTasks.push(
            (async () => {
              const invEdData = await quickFetchJson(
                `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(`isbn:${isbnParam}`)}`
              );
              if (!invEdData) return;
              const ents = invEdData?.entities || {};
              const redirectUri = invEdData?.redirects?.[`isbn:${isbnParam}`];
              const ed = ents[`isbn:${isbnParam}`] || (redirectUri ? ents[redirectUri] : undefined) || Object.values(ents)[0];
              if (ed?.image?.url) addImg(ed.image.url);
              const w = ed?.claims?.['wdt:P629']?.[0];
              if (typeof w === 'string' && w.trim()) {
                targetWorkUri = w.trim();
                workUrisToCheck.add(w.trim());
              }
            })()
          );
        }

        if (titleParam) {
          const cleanTitle = titleParam.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
          const cleanAuthor = authorParam.split(',')[0]?.trim() || '';
          const searchQ = [cleanTitle, cleanAuthor].filter(Boolean).join(' ').trim();
          invTasks.push(
            (async () => {
              let searchData = await quickFetchJson(
                `https://inventaire.io/api/search?types=works&search=${encodeURIComponent(searchQ)}&limit=4`
              );
              if ((!searchData?.results || searchData.results.length === 0) && cleanAuthor && cleanTitle) {
                searchData = await quickFetchJson(
                  `https://inventaire.io/api/search?types=works&search=${encodeURIComponent(cleanTitle)}&limit=4`
                );
              }
              for (const r of (searchData?.results || []).slice(0, 2)) {
                if (r?.image) addImg(r.image);
                if (typeof r?.uri === 'string' && r.uri.trim()) {
                  workUrisToCheck.add(r.uri.trim());
                  if (!targetWorkUri) targetWorkUri = r.uri.trim();
                }
              }
            })()
          );
        }

        // OpenLibrary : Éditions de l'œuvre (via ISBN -> work -> editions.json) + Search titre/auteur
        const olWorkTask = isbnParam
          ? (async () => {
              const edJson = await quickFetchJson(`https://openlibrary.org/isbn/${isbnParam}.json`);
              for (const cov of edJson?.covers || []) {
                if (typeof cov === 'number' && cov > 0) {
                  coverSet.add(`https://covers.openlibrary.org/b/id/${cov}-L.jpg?default=false`);
                }
              }
              const workKey = edJson?.works?.[0]?.key;
              if (typeof workKey === 'string' && workKey.startsWith('/works/')) {
                const eds = await quickFetchJson(`https://openlibrary.org${workKey}/editions.json?limit=50`);
                for (const entry of eds?.entries || []) {
                  for (const c of entry?.covers || []) {
                    if (typeof c === 'number' && c > 0) {
                      coverSet.add(`https://covers.openlibrary.org/b/id/${c}-L.jpg?default=false`);
                    }
                  }
                  for (const i13 of entry?.isbn_13 || []) {
                    const clean13 = String(i13).replace(/[^0-9]/g, '');
                    if (clean13.length === 13) editionIsbns.add(clean13);
                  }
                }
              }
            })()
          : Promise.resolve();

        const olTask = titleParam
          ? (async () => {
              const cleanTitle = titleParam.replace(/\([^)]*\)/g, ' ').trim();
              const cleanAuthor = authorParam.split(',')[0]?.trim() || '';
              const olUrl = `https://openlibrary.org/search.json?title=${encodeURIComponent(cleanTitle)}${
                cleanAuthor ? `&author=${encodeURIComponent(cleanAuthor)}` : ''
              }&fields=cover_i,isbn&limit=12`;
              const olData = await quickFetchJson(olUrl);
              for (const doc of olData?.docs || []) {
                if (doc?.cover_i) {
                  coverSet.add(`https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg?default=false`);
                }
                for (const rawI of (doc?.isbn || []).slice(0, 3)) {
                  const cleanI = String(rawI).replace(/[^0-9]/g, '');
                  if (cleanI.length === 13) editionIsbns.add(cleanI);
                }
              }
            })()
          : Promise.resolve();

        // BnF SRU : découvrir les ISBNs de toutes les éditions françaises (grand format, poche, intégrale...)
        const bnfTask = titleParam
          ? (async () => {
              const cleanTitle = titleParam.replace(/\([^)]*\)/g, ' ').replace(/["()]/g, ' ').trim();
              const cleanAuthor = authorParam.split(',')[0]?.replace(/["()]/g, ' ').trim() || '';
              if (!cleanTitle) return;
              const cql = cleanAuthor
                ? `(bib.title all "${cleanTitle}") and (bib.author all "${cleanAuthor}")`
                : `(bib.title all "${cleanTitle}")`;
              const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(
                cql
              )}&recordSchema=unimarcxchange&maximumRecords=25&startRecord=1`;
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 3500);
              try {
                const res = await fetch(bnfUrl, {
                  headers: { 'User-Agent': USER_AGENT_BASE },
                  signal: controller.signal
                });
                if (!res.ok) return;
                const xml = await res.text();
                const isbnRegex = /<mxc:subfield\s+code="a">\s*([0-9Xx-]{10,17})\s*<\/mxc:subfield>/g;
                let m: RegExpExecArray | null;
                while ((m = isbnRegex.exec(xml)) !== null) {
                  const digits = m[1].replace(/[^0-9]/g, '');
                  if (digits.length === 13 && (digits.startsWith('978') || digits.startsWith('979'))) {
                    editionIsbns.add(digits);
                  }
                }
              } catch {
                // Non bloquant
              } finally {
                clearTimeout(timer);
              }
            })()
          : Promise.resolve();

        // Google Books : recherche multi-éditions (non bloquante si quota 429)
        const gbTask = titleParam
          ? (async () => {
              const cleanTitle = titleParam.replace(/\([^)]*\)/g, ' ').trim();
              const cleanAuthor = authorParam.split(',')[0]?.trim() || '';
              const q = `intitle:${cleanTitle}${cleanAuthor ? ` inauthor:${cleanAuthor}` : ''}`;
              const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=15`;
              const gbData = await quickFetchJson(gbUrl);
              for (const item of gbData?.items || []) {
                const links = item?.volumeInfo?.imageLinks;
                const best = links?.large || links?.medium || links?.thumbnail || links?.smallThumbnail;
                if (typeof best === 'string' && best.trim()) {
                  addImg(best.replace(/^http:\/\//i, 'https://').replace(/&edge=curl/i, ''));
                }
              }
            })()
          : Promise.resolve();

        await Promise.all([...invTasks, olWorkTask, olTask, bnfTask, gbTask]);

        // 2. Récupérer les éditions liées à chaque œuvre découverte (Inventaire reverse-claims + Wikidata SPARQL)
        const remoteEdUris = new Set<string>();
        await Promise.all(
          Array.from(workUrisToCheck)
            .slice(0, 2)
            .map(async (wUri) => {
              const tasks: Promise<void>[] = [
                (async () => {
                  const revData = await quickFetchJson(
                    `https://inventaire.io/api/entities?action=reverse-claims&property=wdt%3AP629&value=${encodeURIComponent(wUri)}`
                  );
                  for (const edUri of (revData?.uris || []).slice(0, 18)) {
                    if (typeof edUri === 'string' && edUri) remoteEdUris.add(edUri);
                  }
                })()
              ];

              if (/^wd:Q\d+$/i.test(wUri)) {
                const qid = wUri.slice(3);
                const sparql = `SELECT ?cover ?isbn WHERE { ?ed wdt:P629 wd:${qid} . OPTIONAL { ?ed wdt:P18 ?cover . } OPTIONAL { ?ed wdt:P212 ?isbn . } } LIMIT 15`;
                tasks.push(
                  (async () => {
                    const wdData = await quickFetchJson(
                      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
                      { Accept: 'application/sparql-results+json' }
                    );
                    for (const b of wdData?.results?.bindings || []) {
                      const cov = b?.cover?.value;
                      if (typeof cov === 'string' && cov.trim()) {
                        addImg(cov.includes('Special:FilePath') ? `${cov}?width=500` : cov);
                      }
                      const wIsbn = (b?.isbn?.value || '').replace(/[^0-9]/g, '');
                      if (wIsbn.length === 13) editionIsbns.add(wIsbn);
                    }
                  })()
                );
              }

              await Promise.all(tasks);
            })
        );

        // Ajouter les ISBNs découverts (BnF / OpenLibrary) au batch Inventaire.io pour récupérer leurs couvertures éventuelles
        for (const edIsbn of Array.from(editionIsbns).slice(0, 20)) {
          remoteEdUris.add(`isbn:${edIsbn}`);
        }

        if (remoteEdUris.size > 0) {
          const edsData = await quickFetchJson(
            `https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(
              Array.from(remoteEdUris).slice(0, 25).join('|')
            )}`
          );
          for (const ent of Object.values(edsData?.entities || {}) as any[]) {
            if (ent?.image?.url) addImg(ent.image.url);
            if (ent?.claims?.['invp:P2']?.[0]) addImg(ent.claims['invp:P2'][0]);
            const p212 = ent?.claims?.['wdt:P212']?.[0];
            if (typeof p212 === 'string') {
              const cleanEdIsbn = p212.replace(/[^0-9]/g, '');
              if (cleanEdIsbn.length === 13) editionIsbns.add(cleanEdIsbn);
            }
          }
        }

        // Ajouter les URLs OpenLibrary des autres éditions découvertes (jusqu'à 20 ISBNs)
        for (const edIsbn of Array.from(editionIsbns).slice(0, 20)) {
          if (edIsbn === isbnParam) continue;
          coverSet.add(`https://covers.openlibrary.org/b/isbn/${edIsbn}-L.jpg?default=false`);
        }

        return jsonResp({
          ok: true,
          workUri: targetWorkUri || null,
          editionIsbns: Array.from(editionIsbns),
          coverUrls: Array.from(coverSet)
        });
      }

      default:
        return jsonResp({ error: `Action '${action}' non reconnue.` }, 404);
    }
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : 'Erreur inconnue';
    return jsonResp({ error: 'Erreur interne du Gateway Cloudflare', details }, 500);
  }
};
