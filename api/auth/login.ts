// api/auth/login.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { INVENTAIRE_API_BASE, getDefaultHeaders } from '../lib/inventaire-api';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  // Sécurité Vercel : s'assurer que le body est parsé
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { username, password } = body;

  try {
    const response = await fetch(`${INVENTAIRE_API_BASE}/auth/login`, {
      method: 'POST',
      headers: getDefaultHeaders(),
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      // On renvoie l'erreur réelle d'Inventaire (ex: "invalid password" ou "blocked")
      return res.status(response.status).json({
        error: data.message || "Erreur d'authentification Inventaire",
        details: data
      });
    }

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      // Indispensable pour Vercel : on transmet le cookie au client
      res.setHeader('Set-Cookie', setCookie);
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Erreur technique du proxy login' });
  }
}