// api/lists/remove-elements.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Méthode PUT requise' });
  const cookie = req.headers.cookie;
  const { id, uris } = req.body; // id = ID de la wishlist

  if (!cookie) return res.status(401).json({ error: 'Non authentifié' });
  if (!id || !uris || !Array.isArray(uris)) return res.status(400).json({ error: 'Paramètres invalides' });

  try {
    const response = await fetch('https://inventaire.io/api/lists/remove-elements', {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json', 
        'Cookie': cookie, 
        'User-Agent': 'InventaireMobileOverlay/1.5 (mathieu.egard@gmail.com)' 
      },
      body: JSON.stringify({ id, uris }) 
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Crash Proxy List Remove', details: err.message });
  }
}