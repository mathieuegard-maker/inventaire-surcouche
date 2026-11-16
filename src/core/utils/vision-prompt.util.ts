// src/core/utils/vision-prompt.util.ts
// Prompt et liste de modèles Gemini Flash partagés entre le client BYOK et la passerelle serveur.

export const GLOBAL_MONTHLY_AI_BUDGET = 15000;
export const MAX_MONTHLY_AI_QUOTA_PER_USER = 100;
export const MIN_MONTHLY_AI_QUOTA_PER_USER = 5;

export function computeMonthlyAiQuota(userCount: number): number {
  const safeUsers = Math.max(1, Math.trunc(userCount || 1));
  const scaled = Math.floor(GLOBAL_MONTHLY_AI_BUDGET / safeUsers);
  return Math.max(MIN_MONTHLY_AI_QUOTA_PER_USER, Math.min(MAX_MONTHLY_AI_QUOTA_PER_USER, scaled));
}

export const PREFERRED_GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-3-flash',
  'gemini-3.0-flash'
];

export function buildVisionPrompt(mode: 'cover' | 'shelf'): string {
  return mode === 'cover'
    ? `Analyse cette couverture (ou 4e de couverture) de livre ou bande dessinée. Extrais TOUS les éléments textuels visibles sans rien inventer de mémoire. Réponds UNIQUEMENT avec un tableau JSON valide d'un seul objet au format : [{"spineIndex":1,"rawSpineText":"Tout le texte exact visible sur la couverture/tranche","title":"Titre exact de l'album ou du livre","subtitle":"Sous-titre éventuel ou vide","series":"Nom de la série si BD/manga/saga ou vide","volumeNumber":"Numéro de tome en chiffres si visible ou vide","author":"Auteur ou scénariste visible ou vide","illustrator":"Dessinateur si distinct et visible ou vide","publisher":"Éditeur ou logo visible (Dupuis, Dargaud, Glénat, Lombard, Delcourt, Soleil, Casterman, Gallimard...) ou vide","collection":"Nom de collection éditoriale si distinct de la série (ex: Aire Libre, Repérages) ou vide","isbn":"ISBN-13 ou ISBN-10 si visible ou vide","confidence":"high|medium|low"}]. RÈGLE STRICTE : si un champ n'est pas lisible sur l'image, laisse "" ; n'invente jamais un auteur.`
    : `Analyse cette photo d'étagère/pile de livres/BD (STRICTEMENT TRANCHE PAR TRANCHE de gauche à droite ou de haut en bas, sans jamais mélanger deux tranches voisines) OU cette couverture/4e de couverture isolée s'il n'y a qu'un seul livre visible. Pour CHAQUE livre/tranche, extrais d'abord TOUT le texte lisible (y compris logos d'éditeur, numéros, sous-titres, auteurs/dessinateurs) dans rawSpineText, puis remplis les champs structurés. Réponds UNIQUEMENT avec un tableau JSON valide : [{"spineIndex":1,"rawSpineText":"Texte intégral lu sur cette tranche/couverture uniquement","title":"Titre du tome ou livre","subtitle":"Sous-titre si présent ou vide","series":"Nom de la série si BD/manga/saga ou vide","volumeNumber":"Numéro de tome en chiffres ou vide","author":"Auteur/scénariste lisible sur CETTE tranche ou vide","illustrator":"Dessinateur si lisible ou vide","publisher":"Éditeur ou logo visible sur CETTE tranche ou vide","collection":"Collection éditoriale si visible ou vide","isbn":"ISBN si visible ou vide","confidence":"high|medium|low"}]. RÈGLE STRICTE : n'invente et ne devine JAMAIS un auteur ou un titre absent/illisible ; laisse "" si tu n'es pas sûr.`;
}
