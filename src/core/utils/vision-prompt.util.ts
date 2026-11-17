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

export const PREFERRED_SEMANTIC_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-3-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite'
];

export interface SemanticWorkNormalizationItem {
  spineIndex: number;
  known: boolean;
  canonicalSeries: string;
  canonicalVolumeNumber: string;
  canonicalWorkTitle: string;
  bnfSearchTitle: string;
  bnfSearchAuthor: string;
  confidence: 'high' | 'medium' | 'low';
}

export const SEMANTIC_NORMALIZATION_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      spineIndex: { type: 'INTEGER' },
      known: { type: 'BOOLEAN' },
      canonicalSeries: { type: 'STRING' },
      canonicalVolumeNumber: { type: 'STRING' },
      canonicalWorkTitle: { type: 'STRING' },
      bnfSearchTitle: { type: 'STRING' },
      bnfSearchAuthor: { type: 'STRING' },
      confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] }
    },
    required: [
      'spineIndex',
      'known',
      'canonicalSeries',
      'canonicalVolumeNumber',
      'canonicalWorkTitle',
      'bnfSearchTitle',
      'bnfSearchAuthor',
      'confidence'
    ]
  }
};

export function buildSemanticWorkNormalizationPrompt(
  ocrItems: Array<Record<string, unknown>>,
  existingSeriesNames: string[]
): string {
  const compactOcr = ocrItems.map((it, idx) => ({
    spineIndex: typeof it.spineIndex === 'number' ? it.spineIndex : idx + 1,
    rawSpineText: String(it.rawSpineText || ''),
    title: String(it.title || ''),
    series: String(it.series || ''),
    volumeNumber: String(it.volumeNumber || ''),
    author: String(it.author || ''),
    publisher: String(it.publisher || ''),
    collection: String(it.collection || '')
  }));

  return `Tu es un bibliothécaire expert en bandes dessinées et livres francophones (modèle FRBR Œuvre vs Édition).
On te fournit un tableau JSON issu d'une lecture OCR brute d'étagère/couverture (Couche 1).
Ta mission (Couche 2) est d'identifier l'ŒUVRE canonique indépendamment de l'édition imprimée, SANS JAMAIS INVENTER en cas de doute.

Séries canoniques déjà présentes dans la bibliothèque de l'utilisateur (réutilise EXACTEMENT ce libellé si l'œuvre y appartient) :
${JSON.stringify(existingSeriesNames.slice(0, 80))}

RÈGLES STRICTES ANTI-HALLUCINATION :
1. Retourne exactement un objet par spineIndex reçu, dans le tableau JSON.
2. Si l'œuvre t'est inconnue, trop récente (après ta date de connaissance), ou s'il existe la moindre ambiguïté : mets "known": false, "confidence": "low", et laisse "", "", "", "", "" dans les champs canoniques (sauf bnfSearchTitle/bnfSearchAuthor s'ils sont déjà clairement lisibles dans l'OCR).
3. Quand "known": true avec certitude :
   - canonicalSeries : nom canonique de la série sans mention de collection éditoriale ni préfixe superflu (ex: "Astérix" et non "Astérix - La Grande Collection", "Boule & Bill" et non "60 gags de Boule et Bill", "Les Aventures de Tintin" -> ou l'intitulé exact figurant dans la liste ci-dessus). "" pour un one-shot.
   - canonicalVolumeNumber : numéro de tome officiel de l'œuvre dans la série en chiffres uniquement (ex: "2" pour La Serpe d'or, "24" pour Astérix chez les Belges, "7" pour L'Île Noire, "3" si l'OCR lit explicitement "60 gags de Boule et Bill N°3"). Ne change jamais un numéro déjà lu sur "60 gags de ... N°X". Laisse "" en cas de moindre doute sur le numéro.
   - canonicalWorkTitle : titre exact de l'album/œuvre sans nom d'auteur ni collection (ex: "La Serpe d'or", "Le Cadeau de César").
   - bnfSearchTitle : titre court et propre optimisé pour une requête SRU sur catalogue.bnf.fr.
   - bnfSearchAuthor : nom de famille de l'auteur/scénariste principal (ex: "Goscinny", "Hergé", "Roba").

Entrée OCR brute :
${JSON.stringify(compactOcr)}`;
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

export function mergeOcrAndSemanticLayers(
  ocrItems: Array<Record<string, unknown>>,
  semanticItems: SemanticWorkNormalizationItem[]
): Array<Record<string, unknown>> {
  const bySpine = new Map<number, SemanticWorkNormalizationItem>();
  for (const s of semanticItems) {
    if (s && typeof s.spineIndex === 'number') {
      bySpine.set(s.spineIndex, s);
    }
  }

  return ocrItems.map((ocr, idx) => {
    const spineIndex = typeof ocr.spineIndex === 'number' ? ocr.spineIndex : idx + 1;
    const sem = bySpine.get(spineIndex);
    if (!sem || !sem.known || sem.confidence === 'low') {
      return {
        ...ocr,
        spineIndex,
        semanticKnown: false
      };
    }
    return {
      ...ocr,
      spineIndex,
      semanticKnown: true,
      semanticConfidence: sem.confidence,
      canonicalSeries: (sem.canonicalSeries || '').trim() || undefined,
      canonicalVolumeNumber: (sem.canonicalVolumeNumber || '').trim() || undefined,
      canonicalWorkTitle: (sem.canonicalWorkTitle || '').trim() || undefined,
      bnfSearchTitle: (sem.bnfSearchTitle || '').trim() || undefined,
      bnfSearchAuthor: (sem.bnfSearchAuthor || '').trim() || undefined,
      // Si l'OCR manquait un numéro ou une série canonique, enrichir prudemment sans écraser rawSpineText
      series: (sem.canonicalSeries || '').trim() || ocr.series,
      volumeNumber: String(ocr.volumeNumber || '').trim() || (sem.canonicalVolumeNumber || '').trim(),
      author: String(ocr.author || '').trim() || (sem.bnfSearchAuthor || '').trim()
    };
  });
}

export function buildVisionPrompt(mode: 'cover' | 'shelf'): string {
  return mode === 'cover'
    ? `Analyse cette couverture (ou 4e de couverture) de livre ou bande dessinée. Extrais TOUS les éléments textuels visibles sans rien inventer de mémoire. Réponds UNIQUEMENT avec un tableau JSON valide d'un seul objet au format : [{"spineIndex":1,"rawSpineText":"Tout le texte exact visible sur la couverture/tranche","title":"Titre exact de l'album ou du livre","subtitle":"Sous-titre éventuel ou vide","series":"Nom de la série si BD/manga/saga ou vide","volumeNumber":"Numéro de tome en chiffres si visible ou vide","author":"Auteur ou scénariste visible ou vide","illustrator":"Dessinateur si distinct et visible ou vide","publisher":"Éditeur ou logo visible (Dupuis, Dargaud, Glénat, Lombard, Delcourt, Soleil, Casterman, Gallimard...) ou vide","collection":"Nom de collection éditoriale si distinct de la série (ex: Aire Libre, Repérages) ou vide","isbn":"ISBN-13 ou ISBN-10 si visible ou vide","confidence":"high|medium|low"}]. RÈGLE STRICTE : si un champ n'est pas lisible sur l'image, laisse "" ; n'invente jamais un auteur.`
    : `Analyse cette photo d'étagère/pile de livres/BD (STRICTEMENT TRANCHE PAR TRANCHE de gauche à droite ou de haut en bas, sans jamais mélanger deux tranches voisines) OU cette couverture/4e de couverture isolée s'il n'y a qu'un seul livre visible. Pour CHAQUE livre/tranche, extrais d'abord TOUT le texte lisible (y compris logos d'éditeur, numéros, sous-titres, auteurs/dessinateurs) dans rawSpineText, puis remplis les champs structurés. Réponds UNIQUEMENT avec un tableau JSON valide : [{"spineIndex":1,"rawSpineText":"Texte intégral lu sur cette tranche/couverture uniquement","title":"Titre du tome ou livre","subtitle":"Sous-titre si présent ou vide","series":"Nom de la série si BD/manga/saga ou vide","volumeNumber":"Numéro de tome en chiffres ou vide","author":"Auteur/scénariste lisible sur CETTE tranche ou vide","illustrator":"Dessinateur si lisible ou vide","publisher":"Éditeur ou logo visible sur CETTE tranche ou vide","collection":"Collection éditoriale si visible ou vide","isbn":"ISBN si visible ou vide","confidence":"high|medium|low"}]. RÈGLE STRICTE : n'invente et ne devine JAMAIS un auteur ou un titre absent/illisible ; laisse "" si tu n'es pas sûr.`;
}
