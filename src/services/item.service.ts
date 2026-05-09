// src/services/item.service.ts
export const itemService = {
  async getItems(uri: string) {
    const res = await fetch(`/api/items/get-by-users?users=${encodeURIComponent(uri)}`);
    
    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await res.text();
      throw new Error(`Erreur items (HTML) : ${text.substring(0, 20)}...`);
    }

    const data = await res.json();
    if (!res.ok) throw new Error("Erreur de récupération des items");
    return data.items || [];
  }
};