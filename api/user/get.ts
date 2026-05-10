// api/user/get.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // LOG EXHAUSTIF : On affiche tout ce que le navigateur a envoyé à Vercel
  console.log('[DEBUG VERCEL] Headers complets envoyés par ton navigateur :', JSON.stringify(req.headers, null, 2));

  const cookie = req.headers.cookie;
  
  if (!cookie) {
    return res.status(401).json({ 
      error: 'Session absente', 
      debug: 'Le navigateur n’a envoyé aucun cookie.' 
    });
  }

  try {
    const response = await fetch('https://inventaire.io/api/user', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.9 (mathieu.egard@gmail.com)',
        'Cookie': cookie
      },
    });

    const data = await response.json();
    
    // LOG EXHAUSTIF : On affiche la réponse brute d'Inventaire
    console.log(`[DEBUG VERCEL] Réponse d'Inventaire (Status: ${response.status}) :`, JSON.stringify(data, null, 2));

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Session rejetée par Inventaire',
        api_response: data
      });
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy User Crash', details: err.message });
  }
}