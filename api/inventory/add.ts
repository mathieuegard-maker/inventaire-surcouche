// api/inventory/add.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // On n'accepte que les requêtes POST pour modifier des données
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { uri } = req.body;
  const cookie = req.headers.cookie;

  if (!uri) return res.status(400).json({ error: 'URI manquante' });
  if (!cookie) return res.status(401).json({ error: 'Non authentifié. Cookie manquant.' });

  try {
    // Appel à l'API d'Inventaire pour créer un Item (un exemplaire physique) lié à l'Entité
    const response = await fetch('https://inventaire.io/api/items', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.9 (mathieu.egard@gmail.com)',
        'Cookie': cookie
      },
      // Le format standard d'Inventaire pour déclarer qu'on possède une entité
      body: JSON.stringify({ entity: uri }) 
    });

    const data = await response.json();
    
    if (!response.ok) return res.status(response.status).json(data);

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Add Crash', details: err.message });
  }
}