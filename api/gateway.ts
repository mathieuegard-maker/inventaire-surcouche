// api/gateway.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as https from 'https';
import { Buffer } from 'buffer';

const USER_AGENT_BASE = 'InventaireMobileOverlay/2.0 (mathieu.egard@gmail.com)';

// --- POLYFILL INDESTRUCTIBLE ---
// Contourne le bug "fetch failed" de Node 18/Undici sur MacOS
function reliableFetch(urlStr: string, options: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode && res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 200,
          headers: {
            getSetCookie: () => {
                const sc = res.headers['set-cookie'];
                return Array.isArray(sc) ? sc : (sc ? [sc] : []);
            },
            get: (name: string) => {
                const val = res.headers[name.toLowerCase()];
                return Array.isArray(val) ? val[0] : val;
            }
          },
          text: async () => buffer.toString('utf8'),
          buffer: async () => buffer // Renvoi brut pour les images
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string;
  const cookie = req.headers.cookie;

  if (!action) {
    return res.status(400).json({ error: 'Paramètre action manquant' });
  }

  // --- HELPER ROBUSTE ---
  const proxyFetch = async (url: string, options: any) => {
    const response = await reliableFetch(url, options); // Utilisation du polyfill
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
      data = {}; // Gestion propre des réponses vides (204)
    }
    
    // Traitement spécial des cookies pour la connexion
    if (action === 'auth-login' && response.ok) {
        const setCookies = response.headers.getSetCookie();
        const rawCookie = response.headers.get('set-cookie');
        
        if (setCookies && setCookies.length > 0) {
          const cleanCookies = setCookies.map((c: string) => c.split(';').map(part => part.trim()).filter(part => {
              const p = part.toLowerCase();
              return !p.startsWith('domain=') && !p.startsWith('samesite=') && !p.startsWith('secure');
            }).join('; ') + '; Path=/; SameSite=Lax; HttpOnly');
          res.setHeader('Set-Cookie', cleanCookies);
        } else if (rawCookie) {
          const cleanCookie = rawCookie.split(';').map((part: string) => part.trim()).filter((part: string) => {
              const p = part.toLowerCase();
              return !p.startsWith('domain=') && !p.startsWith('samesite=') && !p.startsWith('secure');
            }).join('; ') + '; Path=/; SameSite=Lax; HttpOnly';
          res.setHeader('Set-Cookie', cleanCookie);
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
      case 'auth-login': {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        return await proxyFetch('https://inventaire.io/api/auth/login', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: body.username, password: body.password }),
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
          body: JSON.stringify({ entity: req.body.uri }) 
        });

      case 'inventory-bulk': {
        const uris = req.body.uris;
        let successCount = 0;
        const errors = [];
        for (const uri of uris) {
          const response = await reliableFetch('https://inventaire.io/api/items', {
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

      case 'lists-by-creator':
        return await proxyFetch(`https://inventaire.io/api/lists/by-creators?users=${encodeURIComponent(req.query.userId as string)}`, { headers });

      case 'lists-create':
        return await proxyFetch('https://inventaire.io/api/lists', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: req.body.name, type: 'work' }) 
        });

      case 'lists-get':
        return await proxyFetch(`https://inventaire.io/api/lists/by-id?id=${encodeURIComponent(req.query.id as string)}&limit=1000`, { headers });

      case 'lists-add-elements':
        return await proxyFetch('https://inventaire.io/api/lists/add-elements', {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: req.body.id, uris: req.body.uris }) 
        });

      case 'lists-remove-elements':
        return await proxyFetch('https://inventaire.io/api/lists/remove-elements', {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: req.body.id, uris: req.body.uris }) 
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
          body: (req.method !== 'GET' && req.method !== 'HEAD') ? JSON.stringify(req.body) : undefined
        });
      }

      case 'series-list':
        return await proxyFetch(`https://inventaire.io/api/entities/reverse-claims?property=wdt:P179&value=${encodeURIComponent(req.query.seriesId as string)}`, { headers });

      case 'entities-by-uris':
        return await proxyFetch(`https://inventaire.io/api/entities/by-uris?uris=${req.query.uris}`, { headers });

      case 'image-proxy': {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'URL requise' });
        
        const response = await reliableFetch(url as string);
        if (!response.ok) throw new Error(`Erreur réseau distante: ${response.status}`);
        
        const contentType = response.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

        const rawBuffer = await response.buffer();
        return res.status(200).send(rawBuffer);
      }

      default:
        return res.status(404).json({ error: `Action '${action}' non reconnue par le Gateway.` });
    }
  } catch (error: any) {
    console.error(`[GATEWAY CRASH] Action: ${action}`, error.message);
    return res.status(500).json({ error: 'Erreur interne du Gateway', details: error.message });
  }
}