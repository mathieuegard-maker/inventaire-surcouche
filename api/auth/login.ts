// api/auth/login.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. Sécurité Méthode
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    // 2. Sécurité Body (Vercel peut envoyer un string ou un objet)
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    
    if (!body || !body.username || !body.password) {
      return res.status(400).json({ error: 'Identifiants manquants dans la requête' });
    }

    const { username, password } = body;

    // 3. Appel à Inventaire.io [cite: 54-57]
    const response = await fetch('https://inventaire.io/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.4 (mathieu.egard@gmail.com)' // [cite: 1]
      },
      body: JSON.stringify({ username, password }),
    });

    // 4. Gestion de la réponse (Texte d'abord pour éviter le crash JSON)
    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch (e) {
      // Si Inventaire renvoie du HTML (erreur 500 ou blocage), on ne crash pas
      return res.status(response.status).json({ 
        error: "Inventaire a renvoyé une réponse non-JSON",
        details: responseText.substring(0, 100) 
      });
    }

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // 5. Transfert du Cookie de Session [cite: 2]
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      res.setHeader('Set-Cookie', setCookie);
    }

    return res.status(200).json(data);

  } catch (error: any) {
    console.error('[PROXY CRASH]', error.message);
    return res.status(500).json({ error: 'Erreur interne du proxy', details: error.message });
  }
}