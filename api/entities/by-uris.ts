// api/entities/by-uris.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { uris } = req.query;

  if (!uris) return res.status(400).json({ error: 'URIs manquantes' });

  try {
    const response = await fetch(`https://inventaire.io/api/entities/by-uris?uris=${uris}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.0 (mathieu.egard@gmail.com)'
      },
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Humanizer Crash', details: err.message });
  }
}