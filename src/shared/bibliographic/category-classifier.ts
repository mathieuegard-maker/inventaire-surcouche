// src/shared/bibliographic/category-classifier.ts
// Classification générique des catégories et sous-genres à partir des indices Dewey, RAMEAU et sujets normalisés.

import type { BookMainCategory } from '../types/domain.types';

export interface ClassificationResult {
  mainCategory: BookMainCategory;
  subgenres: string[];
  deweyCode?: string;
  /** 'explicit' si déduit d'un signal bibliographique solide (Dewey, RAMEAU, langue originale, texte/description), 'fallback' si défaut générique. */
  confidence: 'explicit' | 'fallback';
}

export const SUGGESTED_GENRE_CHIPS: readonly string[] = [
  'BD',
  'Manga',
  'Comics',
  'Roman',
  'Jeunesse',
  'Ados / Young Adult',
  'Album illustré',
  'Essai',
  'Poésie / Théâtre',
  'Pratique',
  'Art / Beau livre',
  'Fantasy / Fantastique',
  'Science-Fiction',
  'Aventure',
  'Humour',
  'Polar / Thriller',
  'Historique',
  'Romance',
  'Biographie / Témoignage',
  'Sciences & Nature',
  'Philosophie',
  'Société & Politique',
  'Psychologie & Santé'
];

const SUBGENRE_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Jeunesse', pattern: /\b(jeunesse|enfants?|juvenile|children(?:'s)?|tout[- ]petits|premi[eè]res lectures|album jeunesse|kids|028\.5)\b/i },
  { label: 'Ados / Young Adult', pattern: /\b(young adult|adolescents?|ados?|teen)\b/i },
  { label: 'Fantasy / Fantastique', pattern: /\b(fantasy|heroic fantasy|fantastique|sorcellerie|magie|dragons?|f[ée]eri|magic)\b/i },
  { label: 'Science-Fiction', pattern: /\b(science[- ]fiction|cyberpunk|space opera|anticipation|dystopi|post-apocalypt)/i },
  { label: 'Polar / Thriller', pattern: /\b(policiers?|polars?|thrillers?|suspense|enqu[êe]tes?|d[ée]tectives?|detectives?|crimes?|myster(?:y|ies)|noirs?)\b/i },
  { label: 'Historique', pattern: /\b(histoire|historiques?|moyen[- ]âge|antiquité|guerre mondiale|révolution|historical)\b/i },
  { label: 'Humour', pattern: /\b(humour|humoristiques?|satir|comédies?|gags?|humor|funny)\b/i },
  { label: 'Aventure', pattern: /\b(aventures?|adventures?|exploration|westerns?|pirates?|espionnage)\b/i },
  { label: 'Biographie / Témoignage', pattern: /\b(biographi|autobiographi|mémoires|témoignage|journal intime)\b/i },
  { label: 'Philosophie', pattern: /\b(philosophi|éthique|métaphysique|épistémologie)\b/i },
  { label: 'Sciences & Nature', pattern: /\b(sciences?|physique|biologie|astronomie|mathématiques|écologie|nature|climat|astrophysique)\b/i },
  { label: 'Société & Politique', pattern: /\b(sociologie|politique|économie|féminisme|géopolitique|médias|société)\b/i },
  { label: 'Psychologie & Santé', pattern: /\b(psychologie|psychanalyse|développement personnel|santé|bien-être)\b/i },
  { label: 'Romance', pattern: /\b(romance|sentimental|amour)\b/i }
];

const YOUTH_SUBJECT_REGEX =
  /\b(jeunesse|enfants?|juvenile fiction|juvenile literature|juvenile works|children(?:'s)?|young adult|tout[- ]petits|premi[eè]res lectures|album jeunesse|ouvrages pour la jeunesse|litt[ée]rature pour la jeunesse|bandes dessin[ée]es pour la jeunesse|contes pour enfants)\b/i;

export function buildCombinedGenres(classification: Pick<ClassificationResult, 'mainCategory' | 'subgenres'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of [classification.mainCategory, ...(classification.subgenres || [])]) {
    const clean = label?.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 6) break;
  }
  return out;
}

const MANGA_SIGNAL_RE =
  /\b(mangas?|sh[ôo]nen|sh[ôo]jo|seinen|josei|kodomo|manhwa|manhua|kanzenban|tank[ôo]bon|bandes?\s+dessin[ée]es?\s+japonaises?|webtoons?)\b/i;

const COMICS_STRONG_RE =
  /\b(super[- ]h[ée]ros|superheroes|bandes?\s+dessin[ée]es?\s+am[ée]ricaines?)\b/i;

const GENERIC_EN_GRAPHIC_SUBJECT_RE =
  /\b(?:comics?\s*&\s*graphic\s+novels?|comic\s+books?,?\s*strips(?:,?\s*etc\.?)?|graphic\s+novels?)\b/gi;

const BD_SIGNAL_RE =
  /\b(bandes?\s+dessin[ée]es?|b\.?d\.?|album\s+bd|franco[- ]belge|romans?\s+graphiques?)\b/i;

const POETRY_THEATRE_RE =
  /\b(po[ée]sie|po[èe]mes?|recueil\s+de\s+po[èe]mes?|th[ée][âa]tre|pi[èe]ces?\s+de\s+th[ée][âa]tre|trag[ée]dies?|dramaturgie)\b/i;

const POETRY_FALSE_POSITIVE_RE = /\b(com[ée]die\s+humaine|divine\s+com[ée]die)\b/i;

const PRATIQUE_SIGNAL_RE =
  /\b(cuisine|recettes|p[âa]tisserie|gastronomie|jardinage|permaculture|bricolage|couture|tricot|guide\s+pratique|tourisme|guide\s+de\s+voyage|manuel\s+pratique)\b/i;

const ART_SIGNAL_RE =
  /\b(beaux[- ]arts|histoire\s+de\s+l['’]art|peinture|sculpture|photographie|architecture|catalogue\s+d['’]exposition|monographie\s+d['’]art|art\s+contemporain)\b/i;

const NOVEL_STRUCTURAL_RE =
  /\b(romans?|fiction|nouvelles|thrillers?|polars?|policiers?|fantasy|science[- ]fiction|contes)\b/i;

const ESSAI_STRUCTURAL_RE =
  /(?:^|[^a-zA-ZÀ-ÿ])(essais?|histoire|philosophie|sociologie|sciences?|biographies?|autobiographies?|politique|[ée]conomie|psychologie|psychanalyse|documentaires?|astrophysique|physique|biologie|[ée]cologie|g[ée]opolitique)(?![a-zA-ZÀ-ÿ])/i;

export function classifyBookMetadata(input: {
  title?: string;
  series?: string;
  publisher?: string;
  collection?: string;
  deweyCode?: string;
  rawSubjects?: string[];
  description?: string;
  contentKind?: 'illustrated' | 'text_only';
  originalLanguage?: string;
}): ClassificationResult {
  const subjects = (input.rawSubjects || []).filter(Boolean);
  const subjectsText = subjects.join(' | ');
  const dewey = (input.deweyCode || '').trim();
  const origLang = (input.originalLanguage || '').trim().toLowerCase();
  const isJapaneseOrKorean = origLang === 'jpn' || origLang === 'kor' || origLang === 'ja' || origLang === 'ko';
  const isEnglishOriginal = origLang === 'eng' || origLang === 'en';
  const isFrenchOriginal = origLang === 'fre' || origLang === 'fra' || origLang === 'fr';

  const titleSeriesPubCol = [
    input.title || '',
    input.series || '',
    input.publisher || '',
    input.collection || ''
  ].join(' | ');

  const subjectsAndTitle = [
    input.title || '',
    input.series || '',
    input.collection || '',
    subjectsText
  ].join(' | ');

  // Quand le livre appartient déjà à une série, ne pas laisser un mot narratif du titre d'album
  // (ex. "L'histoire de Nathan", "La philosophie des hommes", "Sciences naturelles", "Petites nouvelles")
  // déclencher Essai/Roman/Poésie-Théâtre en Palier 1.
  const subjectsAndSeriesScope = input.series
    ? [input.series || '', input.collection || '', subjectsText].join(' | ')
    : subjectsAndTitle;

  const structuralText = [titleSeriesPubCol, dewey, subjectsText].join(' | ');

  // Retire les mentions d'adaptation de la description ("adapté en bande dessinée / manga / film")
  // pour éviter qu'un résumé de roman n'altère sa catégorie.
  const cleanedDescription = (input.description || '').replace(
    /\badapt[ée]s?\s+(?:en\s+)?(?:bandes?\s+dessin[ée]es?|b\.?d\.?|mangas?|comics?|romans?\s+graphiques?|films?|s[ée]ries?)/gi,
    ''
  );

  const combinedText = [structuralText, cleanedDescription].join(' | ');

  const isYouthDewey = /^(028\.5|j\b|\[j\]|e\b|\[e\])/i.test(dewey) || /\.083\b/.test(dewey);
  const isYouthStructural = YOUTH_SUBJECT_REGEX.test(subjectsAndTitle) || isYouthDewey;
  const isYouth = isYouthStructural || YOUTH_SUBJECT_REGEX.test(cleanedDescription);

  const isNovelOrStory =
    /\b(romans?|fiction|nouvelles|r[ée]cit|conte|fable)\b/i.test(combinedText) ||
    /^8\d\d\.3/.test(dewey) ||
    dewey.startsWith('8');

  const hasExplicitNonGraphicDewey = Boolean(
    dewey && !dewey.startsWith('741.5') && /^[0-9]/.test(dewey)
  );

  const hasGenericEnGraphicSubject = GENERIC_EN_GRAPHIC_SUBJECT_RE.test(subjectsText);
  GENERIC_EN_GRAPHIC_SUBJECT_RE.lastIndex = 0;
  const cleanedSubjectsForComics = subjectsText.replace(GENERIC_EN_GRAPHIC_SUBJECT_RE, '');

  const isGraphicSignal =
    dewey.startsWith('741.5') ||
    MANGA_SIGNAL_RE.test(structuralText) ||
    COMICS_STRONG_RE.test(structuralText) ||
    BD_SIGNAL_RE.test(structuralText) ||
    /\bcomics?\b/i.test(titleSeriesPubCol) ||
    (hasGenericEnGraphicSubject && input.contentKind !== 'text_only' && !hasExplicitNonGraphicDewey) ||
    (input.contentKind === 'illustrated' && !hasExplicitNonGraphicDewey && !isYouthStructural);

  const hasSpecificComicsSubject =
    /\bcomics?\b/i.test(cleanedSubjectsForComics) &&
    !isFrenchOriginal &&
    input.contentKind !== 'text_only' &&
    !hasExplicitNonGraphicDewey;

  let mainCategory: BookMainCategory = 'Autre';
  let confidence: 'explicit' | 'fallback' = 'explicit';

  // === TIER 1 : Signaux structurels fiables (Dewey, RAMEAU, langue originale MARC 041$h/101$c/ISBD, titre/collection) ===
  if (
    MANGA_SIGNAL_RE.test(structuralText) ||
    /^741\.595\s*[12]/.test(dewey) ||
    (isGraphicSignal && isJapaneseOrKorean)
  ) {
    mainCategory = 'Manga';
  } else if (
    COMICS_STRONG_RE.test(structuralText) ||
    /\bcomics?\b/i.test(titleSeriesPubCol) ||
    /^741\.597\s*3/.test(dewey) ||
    (isGraphicSignal && isEnglishOriginal && !isYouthStructural) ||
    hasSpecificComicsSubject
  ) {
    mainCategory = 'Comics';
  } else if (
    dewey.startsWith('741.5') ||
    BD_SIGNAL_RE.test(structuralText) ||
    (hasGenericEnGraphicSubject && !isEnglishOriginal && input.contentKind !== 'text_only' && !hasExplicitNonGraphicDewey)
  ) {
    mainCategory = 'BD';
  } else if (
    // En Dewey, le 3e chiffre code le genre pour les littératures 81x-88x : 8x1 = Poésie (ex. 841.91), 8x2 = Théâtre (ex. 842.91).
    // En 89x le chiffre après le point code la langue (ex. 895.13 = roman chinois), donc ne jamais tester `8xx.[12]`.
    /^8[1-8][12](?:\b|\.)/.test(dewey) ||
    (POETRY_THEATRE_RE.test(subjectsAndSeriesScope) && !POETRY_FALSE_POSITIVE_RE.test(subjectsAndSeriesScope))
  ) {
    mainCategory = 'Poésie / Théâtre';
  } else if (isYouthStructural) {
    mainCategory = 'Jeunesse';
  } else if (/^(64\d|635\b|794\.1)/.test(dewey) || PRATIQUE_SIGNAL_RE.test(subjectsAndTitle)) {
    mainCategory = 'Pratique';
  } else if (/^7[0-7]\d/.test(dewey) || ART_SIGNAL_RE.test(subjectsAndSeriesScope)) {
    mainCategory = 'Art / Beau livre';
  } else if (/^[0123459]\d\d|^6[012356789]\d|^7[89]\d|^8\d4\b|^809\b/.test(dewey)) {
    mainCategory = 'Essai';
  } else if (/^8\d\d/.test(dewey)) {
    mainCategory = 'Roman';
  } else if (NOVEL_STRUCTURAL_RE.test(subjectsAndSeriesScope)) {
    mainCategory = 'Roman';
  } else if (ESSAI_STRUCTURAL_RE.test(subjectsAndSeriesScope)) {
    mainCategory = 'Essai';
  } else if (cleanedDescription.trim().length > 0) {
    // === TIER 2 : Description (uniquement si aucun signal structurel décisif) ===
    if (MANGA_SIGNAL_RE.test(cleanedDescription)) {
      mainCategory = 'Manga';
    } else if (COMICS_STRONG_RE.test(cleanedDescription) || /\bcomics?\b/i.test(cleanedDescription)) {
      mainCategory = 'Comics';
    } else if (BD_SIGNAL_RE.test(cleanedDescription)) {
      mainCategory = 'BD';
    } else if (POETRY_THEATRE_RE.test(cleanedDescription) && !POETRY_FALSE_POSITIVE_RE.test(cleanedDescription)) {
      mainCategory = 'Poésie / Théâtre';
    } else if (YOUTH_SUBJECT_REGEX.test(cleanedDescription)) {
      mainCategory = 'Jeunesse';
    } else if (PRATIQUE_SIGNAL_RE.test(cleanedDescription)) {
      mainCategory = 'Pratique';
    } else if (ART_SIGNAL_RE.test(cleanedDescription)) {
      mainCategory = 'Art / Beau livre';
    } else if (/\b(romans?|fiction|nouvelles|r[ée]cit|thrillers?|polars?)\b/i.test(cleanedDescription)) {
      mainCategory = 'Roman';
    } else if (ESSAI_STRUCTURAL_RE.test(cleanedDescription)) {
      mainCategory = 'Essai';
    }
  }

  // === TIER 3 : Repli générique (marqué `fallback` pour préserver la catégorie de la série graine) ===
  if (mainCategory === 'Autre') {
    if (input.contentKind === 'text_only') {
      mainCategory = 'Roman';
      confidence = 'explicit';
    } else if (input.contentKind === 'illustrated') {
      mainCategory = 'BD';
      confidence = 'fallback';
    } else if (input.series) {
      mainCategory = 'BD';
      confidence = 'fallback';
    } else {
      mainCategory = 'Roman';
      confidence = 'fallback';
    }
  }

  const subgenreSet = new Set<string>();
  if (isYouth && mainCategory !== 'Jeunesse') subgenreSet.add('Jeunesse');
  if (mainCategory === 'Jeunesse' && isNovelOrStory && !/\b(album|imagier|coloriage)\b/i.test(combinedText)) {
    subgenreSet.add('Roman');
  }

  for (const rule of SUBGENRE_RULES) {
    if (rule.pattern.test(combinedText) && rule.label !== mainCategory) {
      subgenreSet.add(rule.label);
    }
  }

  for (const raw of subjects) {
    const cleaned = raw.replace(/--.*$/, '').replace(/\([^)]*\)/g, '').trim();
    if (cleaned.length >= 3 && cleaned.length <= 28 && subgenreSet.size < 5) {
      if (!/^(bandes dessinées|romans|livres|ouvrages|fiction|juvenile fiction|children's fiction|general)$/i.test(cleaned)) {
        const formatted = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        if (formatted.toLowerCase() !== mainCategory.toLowerCase()) {
          subgenreSet.add(formatted);
        }
      }
    }
  }

  return {
    mainCategory,
    subgenres: Array.from(subgenreSet).slice(0, 5),
    deweyCode: dewey || undefined,
    confidence
  };
}
