// api/lists/get.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { id } = req.query;
  const cookie = req.headers.cookie;

  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id manquant' });

  try {
    const url = `https://inventaire.io/api/lists/by-id?id=${encodeURIComponent(id)}&limit=1000`;
    const response = await fetch(url, {
      headers: { 
        'Accept': 'application/json', 
        'User-Agent': 'InventaireMobileOverlay/1.0',
        ...(cookie ? { 'Cookie': cookie } : {})
      }
    });
    
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Crash Proxy Lists By Id', details: err.message });
  }
}