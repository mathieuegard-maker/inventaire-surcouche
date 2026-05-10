// api/lists/add-elements.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Méthode PUT requise' });
  const cookie = req.headers.cookie;
  const { id, uris } = req.body;

  if (!cookie) return res.status(401).json({ error: 'Non authentifié' });
  if (!id || !uris) return res.status(400).json({ error: 'Paramètres manquants' });

  try {
    const response = await fetch('https://inventaire.io/api/lists/add-elements', {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json', 
        'Cookie': cookie,
        'Accept': 'application/json',
        'User-Agent': 'InventaireMobileOverlay/1.5 (mathieu.egard@gmail.com)'
      },
      // IMPORTANT : Inventaire attend { id: "...", uris: ["..."] }
      body: JSON.stringify({ id, uris }) 
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error("[PROXY LIST ADD ERROR]", data);
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: 'Crash Proxy List Add', details: err.message });
  }
}