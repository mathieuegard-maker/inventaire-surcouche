// api/data/isbn.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { isbn } = req.query;

  if (!isbn) return res.status(400).json({ error: 'ISBN manquant' });

  try {
    // Changement d'endpoint pour récupérer l'ENTITÉ et non seulement les faits ISBN [cite: 83, 92]
    const targetUrl = `https://inventaire.io/api/entities/by-uris?uris=isbn:${isbn}`;
    
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.9 (mathieu.egard@gmail.com)'
      },
    });

    const data = await response.json();
    
    if (!response.ok) return res.status(response.status).json(data);

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Entity Crash', details: err.message });
  }
}