// api/lists/by-creator.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { userId } = req.query;
  if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'userId manquant' });

  try {
    const url = `https://inventaire.io/api/lists/by-creators?users=${encodeURIComponent(userId)}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'InventaireMobileOverlay/1.4' }
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Crash Proxy Lists Get', details: err.message });
  }
}