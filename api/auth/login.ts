// api/auth/login.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requis' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { username, password } = body;

    const response = await fetch('https://inventaire.io/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.9 (mathieu.egard@gmail.com)'
      },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    // CORRECTION MAJEURE : getSetCookie() récupère un tableau propre, évitant 
    // la fusion destructrice des cookies multiples par des virgules.
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    const rawCookie = response.headers.get('set-cookie');

    console.log('[DEBUG VERCEL] Cookies bruts reçus d\'Inventaire :', setCookies.length > 0 ? setCookies : rawCookie);

    if (setCookies.length > 0) {
      const cleanCookies = setCookies.map(cookie => {
        return cookie
          .split(';')
          .map(part => part.trim())
          .filter(part => {
            const p = part.toLowerCase();
            return !p.startsWith('domain=') && !p.startsWith('samesite=') && !p.startsWith('secure');
          })
          .join('; ') + '; Path=/; SameSite=Lax; HttpOnly';
      });
      
      console.log('[DEBUG VERCEL] Cookies nettoyés et envoyés au navigateur :', cleanCookies);
      res.setHeader('Set-Cookie', cleanCookies);
    } else if (rawCookie) {
      const cleanCookie = rawCookie
        .split(';')
        .map(part => part.trim())
        .filter(part => {
          const p = part.toLowerCase();
          return !p.startsWith('domain=') && !p.startsWith('samesite=') && !p.startsWith('secure');
        })
        .join('; ') + '; Path=/; SameSite=Lax; HttpOnly';
        
      res.setHeader('Set-Cookie', cleanCookie);
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Login Crash', details: err.message });
  }
}