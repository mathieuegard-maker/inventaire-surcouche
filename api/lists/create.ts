// api/lists/create.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode POST requise' });
  
  const cookie = req.headers.cookie;
  const { name } = req.body;

  if (!cookie) return res.status(401).json({ error: 'Non authentifié' });
  if (!name) return res.status(400).json({ error: 'Nom de liste manquant' });

  try {
    const response = await fetch('https://inventaire.io/api/lists', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Cookie': cookie, 
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.6 (mathieu.egard@gmail.com)' 
      },
      // Les listes Inventaire sont typées par défaut en "work"
      body: JSON.stringify({ 
        name,
        type: 'work' 
      }) 
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error("[INVENTAIRE API ERROR]", data);
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Crash Proxy List Create', details: err.message });
  }
}