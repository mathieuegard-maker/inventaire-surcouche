// api/auth/login.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requis' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { username, password } = body;

    console.log(`[LOGIN] Tentative pour : ${username}`);

    const response = await fetch('https://inventaire.io/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)'
      },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[LOGIN] Échec Inventaire :', data);
      return res.status(response.status).json(data);
    }

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      // On nettoie le cookie pour qu'il soit accepté par Vercel
      const cleanCookie = setCookie
        .replace(/Domain=[^;]+;?/i, '')
        .replace(/Secure;?/i, '')
        .trim();
      
      console.log('[LOGIN] Cookie nettoyé prêt à l’envoi');
      res.setHeader('Set-Cookie', cleanCookie);
    } else {
      console.warn('[LOGIN] Attention : Aucun Set-Cookie reçu d’Inventaire');
    }

    return res.status(200).json(data);
  } catch (err: any) {
    console.error('[LOGIN] Crash Proxy :', err.message);
    return res.status(500).json({ error: 'Crash Proxy Login', details: err.message });
  }
}