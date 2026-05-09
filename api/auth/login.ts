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
        'User-Agent': 'InventaireMobileOverlay/1.6 (mathieu.egard@gmail.com)' // Requis [cite: 1]
      },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      // Sécurité : On retire les attributs 'Domain' et 'Secure' qui peuvent bloquer sur Vercel
      const cleanCookie = setCookie
        .split(';')
        .filter(part => !part.trim().toLowerCase().startsWith('domain='))
        .join(';');
      
      res.setHeader('Set-Cookie', cleanCookie);
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Login Crash', details: err.message });
  }
}