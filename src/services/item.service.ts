// src/services/item.service.ts
export const itemService = {
  async getItems(uri: string) {
    console.log('[ItemService] Récupération bibliothèque pour :', uri);
    const res = await fetch(`/api/items/get-by-users?users=${uri}`);
    const data = await res.json();
    if (!res.ok) throw new Error("Erreur de chargement des items");
    return data.items || [];
  }
};