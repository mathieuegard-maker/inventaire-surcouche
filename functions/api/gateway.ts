// functions/api/gateway.ts
// Point d'entrée Cloudflare Pages Functions pour /api/gateway.
// 1. Délègue toutes les opérations de compte, famille, inventaire, wishlist, prêts, entités et séries à Cloudflare D1 (`handleD1GatewayAction`).
// 2. Fournit les proxys ouverts (`external-lookup` BnF/OpenLibrary, `google-books`, `image-proxy`).

import type { AppBackendEnv } from '../../src/core/adapters/storage-db.interface';
import { handleD1GatewayAction } from '../../src/core/services/d1-gateway-actions.service';

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
            const olSearchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(olQuery.trim())}&fields=key,title,author_name,publisher,first_publish_year,isbn,cover_i,language&limit=10`;
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

        const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${queryParam}&maxResults=20`;
        const gbRes = await resilientFetch(gbUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
        const gbText = await gbRes.text();
        return new Response(gbText, {
          status: gbRes.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }

      case 'image-proxy': {
        const rawUrl = url.searchParams.get('url');
        if (!rawUrl || !rawUrl.trim()) {
          return jsonResp({ error: 'URL requise' }, 400);
        }
        const validatedUrl = validateImageProxyUrl(rawUrl.trim());
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

        return new Response(arrayBuffer, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
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
