// src/core/utils/vision-prompt.util.ts
// Prompt et schéma JSON compact (6 champs OCR strict, 1 seule passe IA) partagés entre le client et la passerelle serveur.

export const GLOBAL_MONTHLY_AI_BUDGET = 15000;
export const MAX_MONTHLY_AI_QUOTA_PER_USER = 100;
export const MIN_MONTHLY_AI_QUOTA_PER_USER = 5;

export function computeMonthlyAiQuota(userCount: number): number {
  const safeUsers = Math.max(1, Math.trunc(userCount || 1));
  const scaled = Math.floor(GLOBAL_MONTHLY_AI_BUDGET / safeUsers);
  return Math.max(MIN_MONTHLY_AI_QUOTA_PER_USER, Math.min(MAX_MONTHLY_AI_QUOTA_PER_USER, scaled));
}

export const PREFERRED_GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash'
];

/**
 * Schéma JSON OpenAPI compact (6 champs max par livre/tranche) pour contraindre
 * la réponse Gemini en mode OCR strict et éviter toute erreur de classification éditoriale.
 */
export const VISION_OCR_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      spineIndex: { type: 'INTEGER' },
      rawText: { type: 'STRING' },
      titleHint: { type: 'STRING' },
      volumeNumber: { type: 'STRING' },
      authorHint: { type: 'STRING' },
      isbn: { type: 'STRING' }
    },
    required: ['spineIndex', 'rawText', 'titleHint', 'volumeNumber', 'authorHint', 'isbn']
  }
};

export function buildVisionPrompt(mode: 'cover' | 'shelf'): string {
  if (mode === 'cover') {
    return `Tu es un moteur de lecture optique (OCR) spécialisé dans les livres et bandes dessinées.
Tu vas observer la photographie d'une couverture ou d'une 4e de couverture isolée d'un livre.
Ton rôle est d'extraire STRICTEMENT le texte visible sans rien inventer ni corriger de mémoire.

Consignes de remplissage du tableau JSON (1 seul objet) :
- spineIndex : 1
- rawText : tout le texte exact visible sur l'image (titre, série, auteur, éditeur, mentions)
- titleHint : le titre principal et/ou nom de série mis en avant sur cette couverture
- volumeNumber : le numéro de tome imprimé en chiffres (ex: "28", "7", "2"), jamais une année ni un prix, sinon ""
- authorHint : le ou les noms d'auteurs / mentions "par X d'après Y" visibles, sinon ""
- isbn : l'ISBN-13 ou ISBN-10 ou code-barres EAN-13 lisible s'il figure sur la photo, sinon ""

RÈGLE STRICTE : si un élément n'est pas lisible sur la photo, mets "". N'invente jamais un titre, un auteur ou un numéro.`;
  }

  return `Tu es un moteur de lecture optique (OCR) spécialisé dans les bibliothèques de livres et bandes dessinées.
Tu vas observer une photographie prenant des couvertures et tranches (dos) de livres ou BD rangées côte à côte dans une bibliothèque (ou empilées à l'horizontale), dont le texte est souvent orienté verticalement à 90° (de bas en haut ou de haut en bas), parfois usé ou partiellement masqué.

Ton rôle est d'analyser cette photo STRICTEMENT TRANCHE PAR TRANCHE (ou COUVERTURE PAR COUVERTURE), dans l'ordre visuel (de gauche à droite, ou de haut en bas pour une pile) :
1. Délimite visuellement chaque livre individuellement grâce à ses bords gauche/droite (ou haut/bas), sa couleur de fond et son ombre.
2. LIVRES OU COUVERTURES PENCHÉS / INCLINÉS : lorsqu'un ou plusieurs livres sont inclinés en diagonale, SUIS STRICTEMENT L'ANGLE DU TEXTE et des arêtes physiques de chaque couverture/tranche pour effectuer ton découpage. Ne découpe JAMAIS selon des bandes verticales droites quand les livres sont penchés : chaque objet correspond à un axe incliné propre partageant le même angle de texte et le même fond.
3. Tout le texte lu sur une même tranche ou couverture inclinée doit rester regroupé ensemble dans le même objet JSON.
4. INTERDICTION ABSOLUE de mélanger un logo d'éditeur, un titre, un auteur ou un numéro d'un livre adjacent (notamment entre le haut d'une couverture penchée et le bas de sa voisine).

Consignes pour chaque objet du tableau JSON :
- spineIndex : numéro d'ordre visuel (1, 2, 3...)
- rawText : l'intégralité du texte lisible sur CETTE tranche uniquement (titre, série, auteur, éditeur, mentions)
- titleHint : le titre et/ou nom de série principal visuellement mis en avant sur CETTE tranche
- volumeNumber : le chiffre isolé désignant visuellement un numéro de tome sur CETTE tranche (ex: "28", "3", "41", jamais une année ni un prix), sinon ""
- authorHint : le ou les noms d'auteurs (y compris "par X d'après Y") lisibles sur CETTE tranche, sinon ""
- isbn : ISBN/code-barres si lisible, sinon ""

RÈGLE STRICTE ANTI-HALLUCINATION : ne devine JAMAIS de mémoire un champ absent ou illisible sur la tranche ; laisse "" si tu n'es pas sûr.`;
}

export function parseJsonArraySafe<T = Record<string, unknown>>(rawText: string): T[] {
  try {
    const cleaned = (rawText || '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const startBracket = cleaned.indexOf('[');
    const endBracket = cleaned.lastIndexOf(']');
    const jsonSlice =
      startBracket !== -1 && endBracket !== -1 ? cleaned.slice(startBracket, endBracket + 1) : cleaned;
    const parsed = JSON.parse(jsonSlice);
    return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T];
  } catch {
    return [];
  }
}
