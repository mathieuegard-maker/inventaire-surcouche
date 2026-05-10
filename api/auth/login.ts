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

    const setCookie = response.headers.get('set-cookie');
    
    if (setCookie) {
      // Transformation agressive du cookie pour Vercel
      // On retire Domain et Secure, on force Path=/ et SameSite=Lax
      const cleanCookie = setCookie
        .split(';')
        .map(part => part.trim())
        .filter(part => {
          const p = part.toLowerCase();
          return !p.startsWith('domain=') && !p.startsWith('samesite=') && !p.startsWith('secure');
        })
        .join('; ');
      
      // On ajoute explicitement les attributs de compatibilité moderne
      const finalCookie = `${cleanCookie}; Path=/; SameSite=Lax; HttpOnly`;
      
      res.setHeader('Set-Cookie', finalCookie);
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Login Crash', details: err.message });
  }
}