// api/series/list.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { seriesId } = req.query;

  if (!seriesId || typeof seriesId !== 'string') {
    return res.status(400).json({ error: 'seriesId manquant' });
  }

  try {
    // Nettoyage du préfixe "wd:"
    const cleanId = seriesId.replace('wd:', '');
    
    // NOUVEAU : Utilisation de l'API de Recherche Rapide (CirrusSearch) au lieu de SPARQL
    // L'opérateur haswbstatement:P179=Q... trouve tous les éléments liés à cette série
    const url = `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=haswbstatement:P179=${cleanId}&srlimit=50&format=json&origin=*`;

    const response = await fetch(url, {
      headers: { 
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.1 (mathieu.egard@gmail.com)'
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Extraction des identifiants (L'API renvoie des titres comme "Q110490677")
    // On rajoute simplement le préfixe "wd:"
    const tomes = data.query.search.map((item: any) => `wd:${item.title}`);

    return res.status(200).json({ tomes });
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Series Crash', details: err.message });
  }
}