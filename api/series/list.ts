// api/series/list.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { seriesId } = req.query;

  if (!seriesId || typeof seriesId !== 'string') {
    return res.status(400).json({ error: 'seriesId manquant' });
  }

  try {
    // SOLUTION 100% INVENTAIRE.IO :
    // On utilise "reverse-claims" pour trouver tous les livres qui déclarent (wdt:P179)
    // appartenir à cette série (value=seriesId).
    const url = `https://inventaire.io/api/entities/reverse-claims?property=wdt:P179&value=${encodeURIComponent(seriesId)}`;

    const response = await fetch(url, {
      headers: { 
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.3 (mathieu.egard@gmail.com)'
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // L'endpoint reverse-claims d'Inventaire renvoie un objet contenant un tableau 'uris'
    const tomes = data.uris || (Array.isArray(data) ? data : []);

    return res.status(200).json({ tomes });
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Series Crash', details: err.message });
  }
}