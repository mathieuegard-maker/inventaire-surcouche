// src/core/utils/category-classifier.util.ts
// Classification fine (KISS & DRY) de tous types de livres à partir des indices Dewey (BnF 676),
// vedettes RAMEAU (BnF 606/608), catégories Google Books et indices éditoriaux.

import type { BookMainCategory } from '../domain/v2.types';

export interface ClassificationResult {
  mainCategory: BookMainCategory;
  subgenres: string[];
  deweyCode?: string;
}

const SUBGENRE_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Science-Fiction', pattern: /\b(science[- ]fiction|cyberpunk|space opera|anticipation|dystopi|post-apocalypt)/i },
  { label: 'Fantasy / Fantastique', pattern: /\b(fantasy|heroic fantasy|fantastique|sorcellerie|magie|dragons?|féeri)/i },
  { label: 'Polar / Thriller', pattern: /\b(policier|polar|thriller|suspense|enquête|detective|crime|noir)\b/i },
  { label: 'Historique', pattern: /\b(histoire|historique|moyen[- ]âge|antiquité|guerre mondiale|révolution)/i },
  { label: 'Humour', pattern: /\b(humour|humoristiques?|satir|comédies?|gags?)\b/i },
  { label: 'Aventure', pattern: /\b(aventure|exploration|western|pirate|espionnage)\b/i },
  { label: 'Biographie / Témoignage', pattern: /\b(biographi|autobiographi|mémoires|témoignage|journal intime)\b/i },
  { label: 'Philosophie', pattern: /\b(philosophi|éthique|métaphysique|épistémologie)\b/i },
  { label: 'Sciences & Nature', pattern: /\b(sciences?|physique|biologie|astronomie|mathématiques|écologie|nature|climat)\b/i },
  { label: 'Société & Politique', pattern: /\b(sociologie|politique|économie|féminisme|géopolitique|médias|société)\b/i },
  { label: 'Psychologie & Santé', pattern: /\b(psychologie|psychanalyse|développement personnel|santé|bien-être)\b/i },
  { label: 'Romance', pattern: /\b(romance|sentimental|amour)\b/i },
  { label: 'Jeunesse', pattern: /\b(jeunesse|enfants?|adolescents?|young adult)\b/i }
];

const MANGA_PUBLISHERS_REGEX = /\b(kana|pika|glénat manga|ki-oon|kurokawa|kazé|crunchyroll|delcourt\/tonkam|tonkam|akata|panini manga|soleil manga|meian|naBan|ototo)\b/i;
const COMICS_PUBLISHERS_REGEX = /\b(urban comics|panini comics|marvel|dc comics|hi comics|bliss comics)\b/i;
const BD_PUBLISHERS_REGEX = /\b(dargaud|dupuis|lombard|casterman|delcourt|soleil|glénat|futuropolis|fluide glacial|bamboo|les humanoïdes associés|vents d'ouest|rue de sèvres|sarbacane|l'association|cornélius)\b/i;

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
  const combinedText = [
    input.title || '',
    input.series || '',
    input.publisher || '',
    input.collection || '',
    ...subjects,
    input.description || ''
  ].join(' | ');

  const dewey = (input.deweyCode || '').trim();
  let mainCategory: BookMainCategory = 'Autre';

  // 1. Détection fine Manga / Comics / BD
  if (
    /\b(mangas?|shonen|shojo|seinen|josei|manhwa|manhua)\b/i.test(combinedText) ||
    MANGA_PUBLISHERS_REGEX.test(`${input.publisher || ''} ${input.collection || ''}`)
  ) {
    mainCategory = 'Manga';
  } else if (
    /\b(comics?|comic book|graphic novel|super-héros|marvel|dc)\b/i.test(combinedText) ||
    COMICS_PUBLISHERS_REGEX.test(`${input.publisher || ''} ${input.collection || ''}`)
  ) {
    mainCategory = 'Comics';
  } else if (
    dewey.startsWith('741.5') ||
    /\b(bandes? dessinées?|b\.?d\.?|album bd|franco-belge)\b/i.test(combinedText) ||
    BD_PUBLISHERS_REGEX.test(`${input.publisher || ''} ${input.collection || ''}`)
  ) {
    mainCategory = 'BD';
  } else if (/\b(poésie|poèmes?|théâtre|pièce de théâtre|tragédie)\b/i.test(combinedText) || /^8\d\d\.[12]/.test(dewey)) {
    mainCategory = 'Poésie / Théâtre';
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
  } else if (/\b(album jeunesse|conte|illustré jeunesse)\b/i.test(combinedText)) {
    mainCategory = 'Jeunesse';
  } else if (
    /\b(essais?|histoire|philosophie|sociologie|sciences?|biographie|politique|économie|psychologie|documentaire)\b/i.test(combinedText) ||
    /^[01234569]/.test(dewey)
  ) {
    mainCategory = 'Essai';
  } else if (input.series) {
    // Si le livre possède une série mais pas d'indice explicite, c'est le plus souvent une BD ou saga Roman
    mainCategory = 'BD';
  } else {
    mainCategory = 'Roman';
  }

  // 2. Extraction des sous-genres normalisés
  const subgenreSet = new Set<string>();
  for (const rule of SUBGENRE_RULES) {
    if (rule.pattern.test(combinedText)) {
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
      if (!/^(bandes dessinées|romans|livres|ouvrages|fiction)$/i.test(cleaned)) {
        subgenreSet.add(cleaned.charAt(0).toUpperCase() + cleaned.slice(1));
      }
    }
  }

  return {
    mainCategory,
    subgenres: Array.from(subgenreSet).slice(0, 5),
    deweyCode: dewey || undefined
  };
}
