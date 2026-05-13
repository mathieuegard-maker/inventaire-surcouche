// api/shelves.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    
    // On extrait la vraie route désirée (ex: "by-owners" ou "add-items")
    const path = url.searchParams.get('path');
    url.searchParams.delete('path'); // On le retire pour ne pas polluer l'API finale

    // Reconstruction de l'URL exacte selon la doc Inventaire
    let inventaireUrl = 'https://inventaire.io/api/shelves';
    if (path) {
      inventaireUrl += `/${path}`; 
    }
    inventaireUrl += url.search; // On ajoute le reste (ex: ?owners=1234)

    console.log(`[PROXY SHELVES] Redirection vers : ${inventaireUrl}`);

    const response = await fetch(inventaireUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': req.headers.cookie || '',
        'User-Agent': 'InventaireMobileOverlay/1.8'
      },
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? JSON.stringify(req.body) : undefined
    });
    
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error("[PROXY SHELVES] Erreur interne :", error.message);
    res.status(500).json({ error: error.message });
  }
}