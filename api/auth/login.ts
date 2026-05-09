// api/auth/login.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { INVENTAIRE_API_BASE, getDefaultHeaders } from '../lib/inventaire-api';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const { username, password } = req.body;

  try {
    const response = await fetch(`${INVENTAIRE_API_BASE}/auth/login`, {
      method: 'POST',
      headers: getDefaultHeaders(),
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    const setCookie = response.headers.get('set-cookie');
    
    if (setCookie) {
      console.log('>>> Proxy Login : Cookie récupéré');
      res.setHeader('Set-Cookie', setCookie);
    }

    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Erreur Serveur Login' });
  }
}