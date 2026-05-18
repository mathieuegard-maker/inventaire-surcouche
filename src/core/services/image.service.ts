// src/core/services/image.service.ts

export const imageService = {
  /**
   * Télécharge, redimensionne et compresse une image en Base64 (WebP).
   * @param imageUrl L'URL de l'image source (Inventaire.io ou Wikidata)
   * @param maxWidth Largeur maximale pour la compression (défaut 300px)
   * @param quality Qualité de compression de 0 à 1 (défaut 0.7)
   */
  async compressAndEncode(imageUrl: string, maxWidth = 300, quality = 0.7): Promise<string | null> {
    console.log(`[DEBUG-IMAGE-SERVICE] URL d'origine : ${imageUrl}`);
    try {
      // --- CONTOURNEMENT CORS VIA PROXY VERCEL ---
      // On encode l'URL cible et on la passe à notre propre serveur backend
      const proxyUrl = `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
      console.log(`[DEBUG-IMAGE-SERVICE] Appel via proxy : ${proxyUrl}`);
      
      const response = await fetch(proxyUrl);
      
      if (!response.ok) {
        console.error(`[DEBUG-IMAGE-SERVICE] HTTP Error ${response.status} pour le proxy`);
        throw new Error(`Erreur réseau: ${response.status}`);
      }
      
      const blob = await response.blob();
      console.log(`[DEBUG-IMAGE-SERVICE] Blob reçu :`, blob.type, blob.size, "octets");
      
      // Utilisation de createImageBitmap pour un traitement performant hors thread principal
      const img = await createImageBitmap(blob);
      console.log(`[DEBUG-IMAGE-SERVICE] Bitmap créé : ${img.width}x${img.height}`);
      
      let width = img.width;
      let height = img.height;

      // Calcul des nouvelles dimensions en respectant le ratio d'aspect
      if (width > maxWidth) {
        const ratio = maxWidth / width;
        width = maxWidth;
        height = Math.round(height * ratio);
      }
      
      // Préparation du canvas pour le redimensionnement
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error("[DEBUG-IMAGE-SERVICE] Impossible de créer le contexte 2D du Canvas");
        return null;
      }
      
      // Dessin de l'image redimensionnée
      ctx.drawImage(img, 0, 0, width, height);
      
      // Exportation en WebP (format très léger idéal pour IndexedDB)
      const finalData = canvas.toDataURL('image/webp', quality);
      console.log("[DEBUG-IMAGE-SERVICE] DataURL généré avec succès.");
      return finalData;

    } catch (error) {
      console.warn(`[IMAGE SERVICE] Échec du traitement pour ${imageUrl}:`, error);
      return null;
    }
  }
};