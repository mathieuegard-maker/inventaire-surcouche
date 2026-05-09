// api/user/get.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { INVENTAIRE_API_BASE, getDefaultHeaders } from '../lib/inventaire-api';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ error: 'Cookie manquant' });

  try {
    const response = await fetch(`${INVENTAIRE_API_BASE}/user`, {
      method: 'GET',
      headers: getDefaultHeaders(cookie),
    });
    
    const data = await response.json();
    
    // Log serveur pour voir ce qui passe dans le tunnel
    console.log('>>> PROXY USER DATA:', JSON.stringify(data).substring(0, 100) + '...');
    
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Erreur tunnel profil' });
  }
}