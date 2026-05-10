// api/inventory/list.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { uri } = req.query;
  const cookie = req.headers.cookie;

  if (!uri) return res.status(400).json({ error: 'URI utilisateur manquante' });

  try {
    const url = `https://inventaire.io/api/items/by-users?users=${encodeURIComponent(uri as string)}&limit=1000`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.9 (mathieu.egard@gmail.com)',
        ...(cookie ? { 'Cookie': cookie } : {})
      },
    });

    const data = await response.json();
    
    if (!response.ok) return res.status(response.status).json(data);

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Inventory Crash', details: err.message });
  }
}