// api/entities/editions.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { workId } = req.query;

  if (!workId || typeof workId !== 'string') {
    return res.status(400).json({ error: 'workId manquant' });
  }

  try {
    // wdt:P629 = "édition de" (edition of)
    // On cherche toutes les entités qui déclarent être une édition de cette œuvre
    const url = `https://inventaire.io/api/entities/reverse-claims?property=wdt:P629&value=${encodeURIComponent(workId)}`;
    
    const response = await fetch(url, {
      headers: { 
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.4 (mathieu.egard@gmail.com)'
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Editions Crash', details: err.message });
  }
}
