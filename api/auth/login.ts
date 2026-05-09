// api/auth/login.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { INVENTAIRE_API_BASE, getDefaultHeaders } from '../lib/inventaire-api';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { username, password } = body;

    const response = await fetch(`${INVENTAIRE_API_BASE}/auth/login`, {
      method: 'POST',
      headers: getDefaultHeaders(),
      body: JSON.stringify({ username, password }),
    });

    // On récupère d'abord le texte brut pour éviter le crash du JSON.parse
    const responseText = await response.text();
    let data;
    
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('>>> Proxy Login : La réponse n’est pas du JSON', responseText);
      return res.status(response.status).json({ 
        error: "Le serveur Inventaire a renvoyé une réponse non-JSON",
        raw: responseText.substring(0, 100) 
      });
    }

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      res.setHeader('Set-Cookie', setCookie);
    }

    return res.status(200).json(data);
  } catch (error: any) {
    console.error('>>> Proxy Login : Erreur fatale', error.message);
    return res.status(500).json({ error: 'Erreur interne du proxy', details: error.message });
  }
}