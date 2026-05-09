// api/items/get-by-users.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { INVENTAIRE_API_BASE, getDefaultHeaders } from '../lib/inventaire-api';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { users } = req.query;
  const cookie = req.headers.cookie;

  try {
    const url = `${INVENTAIRE_API_BASE}/items/by-users?users=${encodeURIComponent(users as string)}&limit=1000`;
    const response = await fetch(url, {
      method: 'GET',
      headers: getDefaultHeaders(cookie),
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Erreur Serveur Items' });
  }
}