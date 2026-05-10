// api/series/list.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { seriesId } = req.query;

  if (!seriesId || typeof seriesId !== 'string') {
    return res.status(400).json({ error: 'seriesId manquant' });
  }

  try {
    // On utilise l'endpoint dédié aux séries 
    // seriesId doit être une URI complète (ex: wd:Q21015332) 
    const url = `https://inventaire.io/api/entities/serie-parts?uri=${encodeURIComponent(seriesId)}`;

    const response = await fetch(url, {
      headers: { 
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.2 (mathieu.egard@gmail.com)'
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // L'API renvoie les URIs des parties de la série 
    // La structure de retour d'Inventaire pour cet endpoint est un tableau d'URIs
    const tomes = Array.isArray(data) ? data : (data.uris || []);

    return res.status(200).json({ tomes });
  } catch (err: any) {
    return res.status(500).json({ error: 'Inventaire Series Error', details: err.message });
  }
}