// api/gateway.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'buffer';

const USER_AGENT_BASE = 'InventaireMobileOverlay/2.0 (mathieu.egard@gmail.com)';
const ALLOWED_SHELF_PATHS = new Set(['by-owners', 'by-ids', 'add-items', 'remove-items', 'delete']);
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

// --- RÉSILENCE MILITAIRE : Auto-Retry en cas de micro-coupure réseau ---
const resilientFetch = async (url: string, options?: RequestInit, retries = 3): Promise<Response> => {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      return res; // Si succès, on renvoie immédiatement
    } catch (err: any) {
      if (i === retries - 1) throw err; // Si c'est le 3ème échec, on abandonne
      console.warn(`[RETRY] Micro-coupure réseau sur ${url}. Nouvel essai dans ${500 * (i + 1)}ms...`);
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1))); // Attente progressive (500ms, puis 1s...)
    }
  }
  throw new Error("Unreachable");
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;
  const cookie = req.headers.cookie;

  if (!action) {
    return res.status(400).json({ error: 'Paramètre action manquant' });
  }

  // Normalisation du body de la requête
  let body = req.body;
  if (body) {
    if (Buffer.isBuffer(body)) {
      try {
        body = body.toString('utf-8');
      } catch (e) {
        console.warn('[GATEWAY] Impossible de convertir le Buffer du body en chaîne de caractères:', e);
      }
    }
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        console.warn('[GATEWAY] Impossible de parser le body en JSON:', e);
      }
    }
  }

  // --- HELPER ROBUSTE ---
  const proxyFetch = async (url: string, options: RequestInit) => {
    const response = await resilientFetch(url, options);
    const text = await response.text();
    let data;
    
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error(`[GATEWAY PARSE ERROR] Action: ${action} | Status: ${response.status} | Body recu: ${text.substring(0, 150)}`);
        return res.status(response.status >= 400 ? response.status : 502).json({ 
          error: `Le serveur d'Inventaire a renvoyé un format inattendu (Status ${response.status})`, 
          details: text.substring(0, 200) 
        });
      }
    } else {
      data = {};
    }
    
    // Traitement spécial des cookies pour la connexion
    if (action === 'auth-login' && response.ok) {
        let setCookies: string[] = [];
        if (typeof response.headers.getSetCookie === 'function') {
           setCookies = response.headers.getSetCookie();
        } else {
           const rawCookie = response.headers.get('set-cookie');
           if (rawCookie) setCookies = [rawCookie];
        }
        
        if (setCookies.length > 0) {
          const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
          const isHttps = forwardedProto === 'https';
          const secureAttr = isHttps ? '; Secure' : '';
          const cleanCookies = setCookies.map(c => c.split(';').map(part => part.trim()).filter(part => {
              const p = part.toLowerCase();
              return !p.startsWith('domain=') && !p.startsWith('samesite=') && !p.startsWith('secure');
            }).join('; ') + `; Path=/; SameSite=Lax; HttpOnly${secureAttr}`);
          res.setHeader('Set-Cookie', cleanCookies);
        }
    }

    return res.status(response.status).json(data);
  };

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': USER_AGENT_BASE
  };
  if (cookie) headers['Cookie'] = cookie;

  try {
    switch (action) {
      case 'search-text':
        // CORRECTION OPENAPI : Remplacement de q par search et injection des types obligatoires requis par leur schéma
        return await proxyFetch(`https://inventaire.io/api/search?search=${encodeURIComponent(req.query.q as string)}&types=works&types=humans&types=series`, { headers });

      case 'author-works':
        // CORRECTION OPENAPI : Utilisation de l'endpoint natif dédié optimisé au lieu du reverse-claims générique
        return await proxyFetch(`https://inventaire.io/api/entities/author-works?uri=${encodeURIComponent(req.query.authorUri as string)}`, { headers });

      case 'auth-login': {
        return await proxyFetch('https://inventaire.io/api/auth/login', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: body?.username, password: body?.password }),
        });
      }

      case 'user-get':
        return await proxyFetch('https://inventaire.io/api/user', { headers });

      case 'inventory-list':
        return await proxyFetch(`https://inventaire.io/api/items/by-users?users=${encodeURIComponent(req.query.uri as string)}&limit=1000`, { headers });

      case 'inventory-add':
        return await proxyFetch('https://inventaire.io/api/items', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity: body?.uri }) 
        });

      case 'inventory-bulk': {
        const uris = body?.uris;
        if (!Array.isArray(uris)) {
          return res.status(400).json({ error: 'Tableau uris requis' });
        }
        let successCount = 0;
        const addedItems: Array<{ uri: string; itemId?: string }> = [];
        const errors = [];
        for (const uri of uris) {
          const response = await resilientFetch('https://inventaire.io/api/items', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity: uri }) 
          });
          if (response.ok) {
            successCount++;
            let itemId: string | undefined;
            try {
              const itemData = await response.json();
              itemId = itemData?._id || itemData?.id;
            } catch {
              // Ignorer si la réponse n'est pas du JSON
            }
            addedItems.push({ uri, itemId });
          } else {
            errors.push({ uri, error: await response.text() });
          }
          await new Promise(resolve => setTimeout(resolve, 150)); 
        }
        return res.status(200).json({ success: true, added: successCount, addedItems, errors });
      }

      case 'inventory-delete':
        return await proxyFetch('https://inventaire.io/api/items/delete', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

      case 'lists-by-creator':
        return await proxyFetch(`https://inventaire.io/api/lists/by-creators?users=${encodeURIComponent(req.query.userId as string)}`, { headers });

      case 'lists-create':
        return await proxyFetch('https://inventaire.io/api/lists', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: body?.name, type: 'work' }) 
        });

      case 'lists-get':
        return await proxyFetch(`https://inventaire.io/api/lists/by-id?id=${encodeURIComponent(req.query.id as string)}&limit=1000`, { headers });

      case 'lists-add-elements':
        return await proxyFetch('https://inventaire.io/api/lists/add-elements', {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: body?.id, uris: body?.uris }) 
        });

      case 'lists-remove-elements':
        return await proxyFetch('https://inventaire.io/api/lists/remove-elements', {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: body?.id, uris: body?.uris }) 
        });

      case 'shelves': {
        const rawPath = req.query.path;
        const path = typeof rawPath === 'string' ? rawPath.trim() : '';
        let inventaireUrl = 'https://inventaire.io/api/shelves';
        if (path) {
          if (!ALLOWED_SHELF_PATHS.has(path)) {
            return res.status(400).json({ error: `Chemin shelves non autorisé: ${path}` });
          }
          inventaireUrl += `/${path}`;
        }
        
        const newUrl = new URL(inventaireUrl);
        Object.keys(req.query).forEach(key => {
          if (key !== 'action' && key !== 'path') newUrl.searchParams.append(key, req.query[key] as string);
        });

        return await proxyFetch(newUrl.toString(), {
          method: req.method,
          headers: req.method !== 'GET' ? { ...headers, 'Content-Type': 'application/json' } : headers,
          body: (req.method !== 'GET' && req.method !== 'HEAD') ? JSON.stringify(body) : undefined
        });
      }

      case 'series-list':
        return await proxyFetch(`https://inventaire.io/api/entities/reverse-claims?property=wdt:P179&value=${encodeURIComponent(req.query.seriesId as string)}`, { headers });

      case 'reverse-claims': {
        const property = req.query.property as string;
        const value = req.query.value as string;
        if (!property || !value) {
          return res.status(400).json({ error: 'Paramètres property et value requis' });
        }
        const rcUrl = new URL('https://inventaire.io/api/entities/reverse-claims');
        rcUrl.searchParams.set('property', property);
        rcUrl.searchParams.set('value', value);
        if (req.query.refresh) rcUrl.searchParams.set('refresh', String(req.query.refresh));
        if (req.query.sort) rcUrl.searchParams.set('sort', String(req.query.sort));
        return await proxyFetch(rcUrl.toString(), { headers });
      }

      case 'entities-by-uris': {
        const uris = req.query.uris as string;
        if (!uris) return res.status(400).json({ error: 'Paramètre uris requis' });
        const byUrisUrl = new URL('https://inventaire.io/api/entities/by-uris');
        byUrisUrl.searchParams.set('uris', uris);
        if (req.query.attributes) byUrisUrl.searchParams.set('attributes', String(req.query.attributes));
        if (req.query.relatives) byUrisUrl.searchParams.set('relatives', String(req.query.relatives));
        return await proxyFetch(byUrisUrl.toString(), { headers });
      }

      case 'entities-create': {
        return await proxyFetch('https://inventaire.io/api/entities', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }

      case 'entities-update-claim': {
        return await proxyFetch('https://inventaire.io/api/entities/update-claim', {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }

      case 'entities-update-label': {
        return await proxyFetch('https://inventaire.io/api/entities/update-label', {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }

      case 'external-lookup': {
        const { isbn, source, series, author } = req.query;
        if (!source) return res.status(400).json({ error: "Source requise (bnf ou openlibrary)" });

        if (source === 'bnf') {
          const recordSchema = req.query.schema === 'intermarc' ? 'intermarcxchange' : 'dublincore';
          if (typeof series === 'string' && series.trim()) {
            const cleanSeries = series.replace(/["()]/g, ' ').trim();
            const cleanAuthor = typeof author === 'string' ? author.replace(/["()]/g, ' ').trim() : '';
            const cql = cleanAuthor
              ? `(bib.title all "${cleanSeries}") and (bib.author all "${cleanAuthor}")`
              : `bib.title all "${cleanSeries}"`;
            const maxRec = Math.min(Math.max(Number(req.query.maxRecords) || 50, 1), 100);
            const startRec = Math.max(Number(req.query.startRecord) || 1, 1);
            const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=${recordSchema}&maximumRecords=${maxRec}&startRecord=${startRec}`;
            const bnfRes = await resilientFetch(bnfUrl);
            const bnfText = await bnfRes.text();
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            return res.status(bnfRes.status).send(bnfText);
          }

          if (!isbn) return res.status(400).json({ error: "ISBN ou série requis" });
          const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=bib.isbn%20adj%20%22${encodeURIComponent(isbn as string)}%22&recordSchema=${recordSchema}`;
          const bnfRes = await resilientFetch(bnfUrl);
          const bnfText = await bnfRes.text();
          res.setHeader('Content-Type', 'application/xml; charset=utf-8');
          return res.status(bnfRes.status).send(bnfText);
        } else if (source === 'openlibrary') {
          if (!isbn) return res.status(400).json({ error: "ISBN requis" });
          const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn as string)}&jscmd=data&format=json`;
          const olRes = await resilientFetch(olUrl);
          const olText = await olRes.text();
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return res.status(olRes.status).send(olText);
        } else {
          return res.status(400).json({ error: `Source '${source}' non reconnue.` });
        }
      }

      case 'google-books': {
        const { isbn } = req.query;
        if (!isbn) return res.status(400).json({ error: "ISBN requis" });
        
        const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn as string)}`;
        const gbRes = await resilientFetch(gbUrl);
        const gbText = await gbRes.text();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(gbRes.status).send(gbText);
      }

      case 'image-proxy': {
        const rawUrl = req.query.url;
        if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
          return res.status(400).json({ error: 'URL requise' });
        }
        const validatedUrl = validateImageProxyUrl(rawUrl.trim());
        if (!validatedUrl) {
          return res.status(400).json({ error: 'URL image invalide ou interdite' });
        }
        
        const response = await resilientFetch(validatedUrl.toString(), {
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error(`Erreur réseau distante: ${response.status}`);
        if (response.url && !validateImageProxyUrl(response.url)) {
          return res.status(400).json({ error: 'Redirection image interdite' });
        }

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > MAX_IMAGE_BYTES) {
          return res.status(413).json({ error: 'Image trop volumineuse' });
        }
        
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.toLowerCase().startsWith('image/')) {
          return res.status(415).json({ error: 'Le contenu distant n est pas une image' });
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
          return res.status(413).json({ error: 'Image trop volumineuse' });
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.status(200).send(Buffer.from(arrayBuffer));
      }

      default:
        return res.status(404).json({ error: `Action '${action}' non reconnue par le Gateway.` });
    }
  } catch (error: any) {
    console.error(`[GATEWAY CRASH] Action: ${action}`, error.message);
    return res.status(500).json({ error: 'Erreur interne du Gateway', details: error.message });
  }
}