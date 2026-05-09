// api/user/get.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const browserCookie = req.headers.cookie;
  
  // LOG CRUCIAL : Est-ce que le navigateur a envoyé un cookie ?
  console.log('[USER] Cookies reçus du navigateur :', browserCookie ? 'OUI' : 'NON (VIDE)');

  if (!browserCookie) {
    return res.status(401).json({ 
      error: 'Session absente', 
      debug: 'Le navigateur n’a envoyé aucun cookie au proxy.' 
    });
  }

  try {
    const response = await fetch('https://inventaire.io/api/user', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.8 (mathieu.egard@gmail.com)',
        'Cookie': browserCookie
      },
    });

    const responseText = await response.text();
    console.log(`[USER] Réponse Inventaire (Status ${response.status})`);

    try {
      const data = JSON.parse(responseText);
      if (!response.ok) {
        return res.status(response.status).json({
          error: 'Inventaire a rejeté la session',
          server_msg: data
        });
      }
      return res.status(200).json(data);
    } catch (e) {
      return res.status(response.status).json({ 
        error: 'Réponse non-JSON', 
        raw: responseText.substring(0, 100) 
      });
    }
  } catch (err: any) {
    console.error('[USER] Crash Proxy :', err.message);
    return res.status(500).json({ error: 'Crash Proxy User', details: err.message });
  }
}