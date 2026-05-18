// api/image-proxy.ts

export default async function handler(req: any, res: any) {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Le paramètre URL est requis.' });
  }

  try {
    // 1. Le serveur (qui n'a pas de blocage CORS) télécharge l'image
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Erreur réseau distante: ${response.status}`);
    }

    // 2. On récupère le vrai type de l'image (ex: image/jpeg, image/webp)
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    
    // Ajout d'un header pour autoriser la mise en cache agressive par Vercel
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // 3. On convertit l'image en données binaires brutes
    const arrayBuffer = await response.arrayBuffer();
    
    // Buffer est maintenant reconnu nativement grâce à @types/node
    const buffer = Buffer.from(arrayBuffer);
    
    // 4. On renvoie l'image au Front-End
    res.status(200).send(buffer);

  } catch (error) {
    console.error('[API IMAGE PROXY] Erreur lors du téléchargement:', error);
    res.status(500).json({ error: 'Impossible de récupérer l\'image via le proxy.' });
  }
}