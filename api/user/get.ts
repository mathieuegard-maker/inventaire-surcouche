// api/user/get.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // On récupère le cookie que le navigateur DOIT envoyer
  const cookie = req.headers.cookie;
  
  if (!cookie) {
    return res.status(401).json({ error: 'unauthorized: No session cookie found in headers' });
  }

  try {
    const response = await fetch('https://inventaire.io/api/user', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.7 (mathieu.egard@gmail.com)',
        'Cookie': cookie // Transmission cruciale ici 
      },
    });

    const data = await response.json();
    
    if (!response.ok) {
      // Si Inventaire répond "unauthorized", on renvoie l'erreur détaillée
      return res.status(response.status).json({
        error: "Inventaire API rejected the session",
        details: data
      });
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy User Crash', details: err.message });
  }
}