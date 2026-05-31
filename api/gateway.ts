// api/gateway.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'buffer';

const USER_AGENT_BASE = 'InventaireMobileOverlay/2.0 (mathieu.egard@gmail.com)';

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
          const cleanCookies = setCookies.map(c => c.split(';').map(part => part.trim()).filter(part => {
              const p = part.toLowerCase();
              return !p.startsWith('domain=') && !p.startsWith('samesite=') && !p.startsWith('secure');
            }).join('; ') + '; Path=/; SameSite=Lax; HttpOnly');
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
        let successCount = 0;
        const errors = [];
        for (const uri of uris) {
          const response = await resilientFetch('https://inventaire.io/api/items', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity: uri }) 
          });
          if (response.ok) successCount++;
          else errors.push({ uri, error: await response.text() });
          await new Promise(resolve => setTimeout(resolve, 150)); 
        }
        return res.status(200).json({ success: true, added: successCount, errors });
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
        const path = req.query.path as string;
        let inventaireUrl = 'https://inventaire.io/api/shelves';
        if (path) inventaireUrl += `/${path}`;
        
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

      case 'entities-by-uris':
        return await proxyFetch(`https://inventaire.io/api/entities/by-uris?uris=${req.query.uris}`, { headers });

      case 'external-lookup': {
        const { isbn, source } = req.query;
        if (!isbn) return res.status(400).json({ error: "ISBN requis" });
        if (!source) return res.status(400).json({ error: "Source requise (bnf ou openlibrary)" });

        if (source === 'bnf') {
          const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=bib.isbn%20adj%20%22${encodeURIComponent(isbn as string)}%22&recordSchema=dublincore`;
          const bnfRes = await resilientFetch(bnfUrl);
          const bnfText = await bnfRes.text();
          res.setHeader('Content-Type', 'application/xml; charset=utf-8');
          return res.status(bnfRes.status).send(bnfText);
        } else if (source === 'openlibrary') {
          const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn as string)}&jscmd=data&format=json`;
          const olRes = await resilientFetch(olUrl);
          const olText = await olRes.text();
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return res.status(olRes.status).send(olText);
        } else {
          return res.status(400).json({ error: `Source '${source}' non reconnue.` });
        }
      }

      case 'image-proxy': {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'URL requise' });
        
        const response = await resilientFetch(url as string);
        if (!response.ok) throw new Error(`Erreur réseau distante: ${response.status}`);
        
        const contentType = response.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

        const arrayBuffer = await response.arrayBuffer();
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