// src/core/services/image.service.ts

export const imageService = {
  async compressAndEncode(imageUrl: string, maxWidth = 300, quality = 0.7): Promise<string | null> {
    console.log(`[DEBUG-IMAGE-SERVICE] URL d'origine : ${imageUrl}`);
    try {
      const proxyUrl = `/api/gateway?action=image-proxy&url=${encodeURIComponent(imageUrl)}`;
      console.log(`[DEBUG-IMAGE-SERVICE] Appel via proxy : ${proxyUrl}`);
      
      const response = await fetch(proxyUrl);
      
      if (!response.ok) {
        console.error(`[DEBUG-IMAGE-SERVICE] HTTP Error ${response.status} pour le proxy`);
        throw new Error(`Erreur réseau: ${response.status}`);
      }
      
      const blob = await response.blob();
      console.log(`[DEBUG-IMAGE-SERVICE] Blob reçu :`, blob.type, blob.size, "octets");
      
      const img = await createImageBitmap(blob);
      console.log(`[DEBUG-IMAGE-SERVICE] Bitmap créé : ${img.width}x${img.height}`);
      
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        const ratio = maxWidth / width;
        width = maxWidth;
        height = Math.round(height * ratio);
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error("[DEBUG-IMAGE-SERVICE] Impossible de créer le contexte 2D du Canvas");
        return null;
      }
      
      ctx.drawImage(img, 0, 0, width, height);
      
      const finalData = canvas.toDataURL('image/webp', quality);
      console.log("[DEBUG-IMAGE-SERVICE] DataURL généré avec succès.");
      return finalData;

    } catch (error) {
      console.warn(`[IMAGE SERVICE] Échec du traitement pour ${imageUrl}:`, error);
      return null;
    }
  }
};