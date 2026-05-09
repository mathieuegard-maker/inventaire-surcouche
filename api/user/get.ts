// api/user/get.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ error: 'Session absente (aucun cookie reçu par le proxy)' });

  try {
    const response = await fetch('https://inventaire.io/api/user', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.6 (mathieu.egard@gmail.com)', // Requis [cite: 1]
        'Cookie': cookie
      },
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy User Crash', details: err.message });
  }
}