// src/services/image.service.ts

export const imageService = {
  /**
   * Télécharge, redimensionne et compresse une image en Base64 (WebP).
   * @param imageUrl L'URL de l'image source (Inventaire.io ou Wikidata)
   * @param maxWidth Largeur maximale pour la compression (défaut 300px)
   * @param quality Qualité de compression de 0 à 1 (défaut 0.7)
   */
  async compressAndEncode(imageUrl: string, maxWidth = 300, quality = 0.7): Promise<string | null> {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`Erreur réseau: ${response.status}`);
      
      const blob = await response.blob();
      
      // Utilisation de createImageBitmap pour un traitement performant hors thread principal si possible
      const img = await createImageBitmap(blob);
      
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
      if (!ctx) return null;
      
      // Dessin de l'image redimensionnée
      ctx.drawImage(img, 0, 0, width, height);
      
      // Exportation en WebP (format très léger idéal pour IndexedDB)
      return canvas.toDataURL('image/webp', quality);

    } catch (error) {
      console.warn(`[IMAGE SERVICE] Échec du traitement pour ${imageUrl}:`, error);
      return null;
    }
  }
};