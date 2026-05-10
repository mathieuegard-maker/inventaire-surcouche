// src/resolvers/entity.resolver.ts

export interface SimplifiedEntity {
  uri: string;
  title: string;
  authors: string[];
  image?: string;
  isbn: string;
}

export const entityResolver = {
  async fromIsbn(isbn: string): Promise<SimplifiedEntity> {
    const res = await fetch(`/api/data/isbn?isbn=${isbn}`);
    const data = await res.json();

    // On récupère l'entité dans 'entities' ou à la racine
    const entities = data.entities || data;
    const uri = Object.keys(entities)[0];
    const raw = entities[uri];

    if (!raw || raw.missing) {
      throw new Error("Livre inconnu dans la base.");
    }

    // 1. Extraction du Titre
    let title = "Titre inconnu";
    if (raw.label) title = raw.label;
    else if (raw.labels) {
      title = raw.labels.fr || raw.labels.en || Object.values(raw.labels)[0] as string || title;
    }

    // 2. Extraction des Auteurs (Multi-sources)
    let authors: string[] = [];
    if (Array.isArray(raw.authors) && raw.authors.length > 0) {
      authors = raw.authors;
    } else if (raw.claims && raw.claims['wdt:P50']) {
      // Sur Wikidata, P50 est la propriété pour l'auteur
      authors = raw.claims['wdt:P50'];
    }

    // 3. Extraction de l'Image
    const image = raw.image || (raw.images && raw.images[0]);

    const result: SimplifiedEntity = {
      uri: uri,
      title: title,
      authors: authors.length > 0 ? authors : ["Auteur inconnu"],
      image: image,
      isbn: isbn
    };

    // On force l'affichage pour le debug
    console.log("[Resolver] Objet final généré :");
    console.table(result);

    return result;
  }
};