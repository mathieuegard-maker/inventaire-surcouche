// api/inventory/bulk.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode POST requise' });

  const { uris } = req.body;
  const cookie = req.headers.cookie;

  if (!uris || !Array.isArray(uris)) {
    return res.status(400).json({ error: "Liste d'URIs invalide ou manquante" });
  }

  if (!cookie) return res.status(401).json({ error: 'Non authentifié' });

  try {
    let successCount = 0;
    const errors = [];

    // On boucle côté serveur Vercel pour utiliser l'endpoint unitaire qui fonctionne
    // et contourner les restrictions strictes de l'endpoint bulk d'Inventaire.
    for (const uri of uris) {
      const response = await fetch('https://inventaire.io/api/items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'InventaireMobileOverlay/1.4 (mathieu.egard@gmail.com)',
          'Cookie': cookie
        },
        body: JSON.stringify({ entity: uri }) 
      });

      if (response.ok) {
        successCount++;
      } else {
        const errData = await response.json();
        errors.push({ uri, error: errData });
      }

      // Micro-pause de 150ms pour protéger l'API et éviter l'erreur 429 (Too Many Requests)
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    if (successCount === 0) {
      return res.status(400).json({ error: "Aucun ajout n'a fonctionné", details: errors });
    }

    return res.status(200).json({ success: true, added: successCount, errors });
  } catch (err: any) {
    return res.status(500).json({ error: 'Proxy Bulk Crash', details: err.message });
  }
}