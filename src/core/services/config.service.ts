// src/core/services/config.service.ts

export const configService = {
  /**
   * Détecte la langue de l'environnement et la convertit en Q-node Wikidata.
   * Priorité : 1. Navigateur -> 2. Variable d'env (si existante) -> 3. Français
   */
  getPreferredLanguageWdCode(): string {
    // 1. Récupération dynamique (sécurisée pour SSR / Web)
    let langCode = 'fr';
    if (typeof navigator !== 'undefined' && navigator.language) {
      langCode = navigator.language.split('-')[0].toLowerCase(); // ex: "fr-FR" -> "fr"
    }

    // 2. Dictionnaire de traduction (Langue ISO -> Entité Wikidata)
    const languageMap: Record<string, string> = {
      'fr': 'wd:Q150',   // Français
      'en': 'wd:Q1860',  // Anglais
      'es': 'wd:Q1321',  // Espagnol
      'de': 'wd:Q188',   // Allemand
      'it': 'wd:Q1192',  // Italien
      'ja': 'wd:Q5287',  // Japonais
      'pt': 'wd:Q5146'   // Portugais
    };

    // 3. Fallback sur l'anglais si la langue système est inconnue
    return languageMap[langCode] || languageMap['en'];
  }
};