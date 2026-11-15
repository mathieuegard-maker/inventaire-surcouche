// src/core/utils/category-classifier.util.ts
// Classification fine (KISS & DRY) de tous types de livres à partir des indices Dewey (BnF 676),
// vedettes RAMEAU (BnF 606/608), catégories Google Books, sujets Open Library et indices éditoriaux.

import type { BookMainCategory } from '../domain/v2.types';

export interface ClassificationResult {
  mainCategory: BookMainCategory;
  subgenres: string[];
  deweyCode?: string;
}

export const SUGGESTED_GENRE_CHIPS: string[] = [
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

const MANGA_PUBLISHERS_REGEX = /\b(kana|pika|glénat manga|ki-oon|kurokawa|kazé|crunchyroll|delcourt\/tonkam|tonkam|akata|panini manga|soleil manga|meian|naBan|ototo)\b/i;
const COMICS_PUBLISHERS_REGEX = /\b(urban comics|panini comics|marvel|dc comics|hi comics|bliss comics)\b/i;
const BD_PUBLISHERS_REGEX = /\b(dargaud|dupuis|lombard|casterman|delcourt|soleil|glénat|futuropolis|fluide glacial|bamboo|les humanoïdes associés|vents d'ouest|rue de sèvres|sarbacane|l'association|cornélius|bd kids)\b/i;
const YOUTH_PUBLISHERS_OR_COLLECTIONS_REGEX =
  /\b(l'école des loisirs|ecole des loisirs|bayard jeunesse|milan jeunesse|père castor|pere castor|bibliothèque rose|bibliotheque rose|bibliothèque verte|bibliotheque verte|mini syros|syros jeunesse|bd kids|casterman jeunesse|nathan jeunesse|rageot|gallimard jeunesse|folio junior|hachette jeunesse|flammarion jeunesse|albin michel jeunesse|seuil jeunesse|gautier-languereau|little urban|fleurus|pkj|pocket jeunesse|poulpe fictions)\b/i;
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

export function classifyBookMetadata(input: {
  title?: string;
  series?: string;
  publisher?: string;
  collection?: string;
  deweyCode?: string;
  rawSubjects?: string[];
  description?: string;
}): ClassificationResult {
  const subjects = (input.rawSubjects || []).filter(Boolean);
  const pubAndCol = `${input.publisher || ''} ${input.collection || ''}`;
  const subjectsText = subjects.join(' | ');
  const combinedText = [
    input.title || '',
    input.series || '',
    pubAndCol,
    subjectsText,
    input.description || ''
  ].join(' | ');

  const dewey = (input.deweyCode || '').trim();
  const isYouth =
    YOUTH_SUBJECT_REGEX.test(`${subjectsText} ${input.title || ''} ${input.description || ''}`) ||
    YOUTH_PUBLISHERS_OR_COLLECTIONS_REGEX.test(pubAndCol) ||
    /^(028\.5|j\b|\[j\]|e\b|\[e\])/i.test(dewey) ||
    /\.083\b/.test(dewey);

  const isNovelOrStory =
    /\b(romans?|fiction|nouvelles|r[ée]cit|conte|fable)\b/i.test(combinedText) ||
    /^8\d\d\.3/.test(dewey) ||
    dewey.startsWith('8');

  let mainCategory: BookMainCategory = 'Autre';

  // 1. Détection fine Manga / Comics / BD (format visuel prioritaire)
  if (
    /\b(mangas?|shonen|shojo|seinen|josei|manhwa|manhua)\b/i.test(combinedText) ||
    MANGA_PUBLISHERS_REGEX.test(pubAndCol)
  ) {
    mainCategory = 'Manga';
  } else if (
    /\b(super-héros|marvel|dc comics?)\b/i.test(combinedText) ||
    COMICS_PUBLISHERS_REGEX.test(pubAndCol)
  ) {
    mainCategory = 'Comics';
  } else if (
    dewey.startsWith('741.5') ||
    /\b(bandes? dessinées?|b\.?d\.?|album bd|franco-belge)\b/i.test(combinedText) ||
    BD_PUBLISHERS_REGEX.test(pubAndCol)
  ) {
    mainCategory = 'BD';
  } else if (
    /\b(comics?|comic book)\b/i.test(combinedText) ||
    /\bgraphic novels?\b/i.test(subjectsText)
  ) {
    mainCategory = 'Comics';
  } else if (/\b(poésie|poèmes?|théâtre|pièce de théâtre|tragédie)\b/i.test(combinedText) || /^8\d\d\.[12]/.test(dewey)) {
    mainCategory = 'Poésie / Théâtre';
  } else if (isYouth) {
    // IMPORTANT : Un livre identifié pour enfants / jeunesse (même tagué "Juvenile Fiction" ou Dewey 843)
    // doit être classé "Jeunesse" et non écrasé par "Roman" !
    mainCategory = 'Jeunesse';
  } else if (
    /\b(romans?|fiction|nouvelles|récit|thriller|polar)\b/i.test(combinedText) ||
    /^8\d\d\.3/.test(dewey) ||
    dewey.startsWith('8')
  ) {
    mainCategory = 'Roman';
  } else if (/\b(cuisine|recettes|jardinage|bricolage|guide pratique|tourisme|voyage)\b/i.test(combinedText) || dewey.startsWith('64')) {
    mainCategory = 'Pratique';
  } else if (/\b(beaux-arts|peinture|photographie|architecture|catalogue d'exposition)\b/i.test(combinedText) || dewey.startsWith('7')) {
    mainCategory = 'Art / Beau livre';
  } else if (
    /\b(essais?|histoire|philosophie|sociologie|sciences?|biographie|politique|économie|psychologie|documentaire)\b/i.test(combinedText) ||
    /^[01234569]/.test(dewey)
  ) {
    mainCategory = 'Essai';
  } else if (input.series) {
    mainCategory = 'BD';
  } else {
    mainCategory = 'Roman';
  }

  // 2. Extraction des sous-genres normalisés (multi-genres combinables)
  const subgenreSet = new Set<string>();
  if (isYouth && mainCategory !== 'Jeunesse') {
    subgenreSet.add('Jeunesse');
  }
  if (mainCategory === 'Jeunesse' && isNovelOrStory && !/\b(album|imagier|coloriage)\b/i.test(combinedText)) {
    subgenreSet.add('Roman');
  }

  for (const rule of SUBGENRE_RULES) {
    if (rule.pattern.test(combinedText) && rule.label !== mainCategory) {
      subgenreSet.add(rule.label);
    }
  }

  // Ajout des sujets propres courts qui ne font pas doublon
  for (const raw of subjects) {
    const cleaned = raw
      .replace(/--.*$/, '')
      .replace(/\([^)]*\)/g, '')
      .trim();
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
    deweyCode: dewey || undefined
  };
}
