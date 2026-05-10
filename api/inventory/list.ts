// api/inventory/list.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { username } = req.query;

  if (!username) return res.status(400).json({ error: 'Username manquant' });

  try {
    // L'API d'Inventaire pour récupérer les URIs de la bibliothèque d'un utilisateur
    const response = await fetch(`https://inventaire.io/api/users/${username}/entities?action=inventory`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.0 (mathieu.egard@gmail.com)'
      },
    });

    const data = await response.json();
    
    if (!response.ok) return res.status(response.status).json(data);

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Inventory Crash', details: err.message });
  }
}