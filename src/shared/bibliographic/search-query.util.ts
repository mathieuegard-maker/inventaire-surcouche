// src/shared/bibliographic/search-query.util.ts
// Pré-nettoyage pur d'intention de recherche textuelle (média entre parenthèses, numéro de tome collé/romain,
// intégrales/coffrets, qualificatifs d'édition relâchables en passe de secours) — zéro dépendance Node/Vue/SQL.

import { parseIncludedVolumeNumbers } from './integral.util';
import { normalizeSeriesNumber, normalizeTextKey } from './text-normalize.util';

export type RequestedMediaHint = 'BD' | 'Manga' | 'Comics' | 'Roman';

export interface SearchIntentInput {
  title?: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  publisher?: string;
  isIntegral?: boolean;
}

export interface ParsedSearchIntent {
  /** Titre nettoyé (sans marqueurs (BD)/(manga), sans suffixe "Tome N" extrait). */
  cleanTitle: string;
  /** Série nettoyée (sans marqueurs (BD)/(manga)). */
  cleanSeries: string;
  /** Titre relâché pour la passe de secours (qualificatifs d'édition/éditeur retirés). */
  relaxedTitle: string;
  /** Série relâchée pour la passe de secours. */
  relaxedSeries: string;
  /** Base de série propre pour `searchSeriesIntegrals` lorsque `wantsIntegral` est vrai. */
  integralSeriesBase: string;
  /** Numéro de tome normalisé (explicite ou extrait du titre, chiffres romains inclus). */
  volumeNumber: string | null;
  volumeNumeric: number | null;
  /** Média explicitement demandé entre parenthèses `(BD)`, `(manga)`, `(comics)`, `(roman graphique)`, `(roman)`. */
  requestedMedia: RequestedMediaHint | null;
  /** Vrai si l'intention concerne une intégrale ou un coffret. */
  wantsIntegral: boolean;
  /** Plage de tomes incluse détectée (ex. `T.1-3` -> `['1','2','3']`). */
  integralRange: string[];
  /** Jetons d'édition/éditeur extraits pour bonifier le scoring sans casser les requêtes strictes. */
  editionHintTokens: string[];
  /** Chaîne auteur brute nettoyée (transmise aux connecteurs). */
  cleanAuthor?: string;
  /** Liste des noms/segments d'auteurs séparés (`&`, `,`, `/`, `;`, `et`). */
  allAuthorParts: string[];
  /** Éditeur effectif (fourni ou déduit d'une parenthèse type `(manga Kurokawa)`). */
  effectivePublisher?: string;
  /** Vrai si l'auteur a été déduit d'une saisie mélangée (ex. "Les Chroniques d'Arslan T5 Arakawa"). */
  authorInferredFromTitle?: boolean;
}

export interface OmniboxSplitCandidate {
  titlePart: string;
  authorPart: string;
  volumeNumber: string | null;
}

const ROMAN_MAP: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
  xiii: 13,
  xiv: 14,
  xv: 15,
  xvi: 16,
  xvii: 17,
  xviii: 18,
  xix: 19,
  xx: 20
};

export function parseVolumeToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{1,3}(?:\.\d)?$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    return n > 0 ? String(n) : null;
  }
  const roman = ROMAN_MAP[trimmed.toLowerCase()];
  if (roman) return String(roman);
  const norm = normalizeSeriesNumber(trimmed);
  if (norm && /^\d{1,3}(?:\.\d)?$/.test(norm)) {
    const n = parseFloat(norm);
    return n > 0 ? String(n) : null;
  }
  return norm || null;
}

const GENERIC_RELEVANCE_WORDS = new Set([
  'integrale',
  'integral',
  'integrales',
  'cycle',
  'tome',
  'tomes',
  'volume',
  'volumes',
  'vol',
  'coffret',
  'edition',
  'editions',
  'ed',
  'livre',
  'livres',
  'omnibus',
  'compendium',
  'saison',
  'partie',
  'deluxe',
  'perfect',
  'collector',
  'prestige',
  'zero',
  'premier',
  'premiere'
]);

/**
 * Retire les mots bibliographiques génériques ("Intégrale", "Cycle", "Tome", "Volume", nombres isolés)
 * pour le garde-fou anti-hors-sujet : empêche "Les Innommables - Intégrale Cycle zéro" de matcher
 * "Le cycle de Fondation Intégrale Tome 1" sur les seuls mots "cycle" et "intégrale".
 */
export function stripGenericRelevanceWords(raw: string): string {
  const tokens = normalizeTextKey(raw)
    .split(' ')
    .filter((tok) => tok.length >= 2 && !GENERIC_RELEVANCE_WORDS.has(tok) && !/^\d+$/.test(tok));
  return tokens.join(' ');
}

const OMNIBOX_NOISE_RE =
  /(?:^|(?<=[^a-zA-ZÀ-ÿ]))(?:livre\s+de\s+poche|pocket\s+sf|pocket|folio\s+sf|folio|10\s*\/\s*18|j['’]ai\s+lu|points|babel|light\s+novel|ofelbe|urban\s+comics?|urban|panini|gl[ée]nat|glenat|kana|pika|delcourt|tonkam|kurokawa|dupuis|dargaud|casterman|manga|comics|bd)(?![a-zA-ZÀ-ÿ])/gi;

const NON_AUTHOR_START_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux', 'en', 'et', 'ou', 'pour', 'par', 'sur', 'dans', 'avec', 'sans', 'the', 'of', 'and', 'in', 'to'
]);

/**
 * Nettoie une saisie omnibox (ex. "la mort a venise thomas mann livre de poche") en retirant les tags éditeur/poche
 * et propose au plus 2 à 3 découpages ciblés `(titlePart, authorPart)` en ultime recours quand la recherche normale renvoie 0 résultat.
 */
export function buildOmniboxSplitCandidates(rawText: string): OmniboxSplitCandidate[] {
  const raw = collapseSpaces(rawText);
  if (!raw) return [];

  // Extrait un éventuel n° de tome au milieu ou en fin (ex. "tokyo yamimushi 2 honda", "Les Chroniques d'Arslan T5 Arakawa")
  let cleaned = collapseSpaces(raw.replace(OMNIBOX_NOISE_RE, ' '));
  if (normalizeTextKey(cleaned).length < 4) cleaned = raw;

  const out: OmniboxSplitCandidate[] = [];
  const seen = new Set<string>();
  const pushSplit = (titlePart: string, authorPart: string, volumeNumber: string | null) => {
    const tClean = collapseSpaces(titlePart);
    const aClean = collapseSpaces(authorPart);
    if (normalizeTextKey(tClean).length < 3 || normalizeTextKey(aClean).length < 3) return;
    const key = `${normalizeTextKey(tClean)}|${normalizeTextKey(aClean)}|${volumeNumber ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ titlePart: tClean, authorPart: aClean, volumeNumber });
  };

  // 1. Découpage naturel autour d'un numéro de tome en milieu de texte (ex. "tokyo yamimushi 2 honda" ou "arslan t5 arakawa")
  const midNumMatch = /^(.{3,}?)\s+(?:(?:tome|t\.|vol\.?|volume)\s*(\d{1,3}(?:\.\d)?)|t(\d{1,3}(?:\.\d)?)|(\d{1,2}))\s+([a-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ'’.\-\s]{1,35})$/i.exec(
    cleaned
  );
  if (midNumMatch) {
    const vol = parseVolumeToken(midNumMatch[2] || midNumMatch[3] || midNumMatch[4]);
    const tailWords = midNumMatch[5].trim().split(/\s+/);
    if (vol && tailWords.length >= 1 && tailWords.length <= 3 && !NON_AUTHOR_START_WORDS.has(normalizeTextKey(tailWords[0]))) {
      pushSplit(midNumMatch[1], midNumMatch[5], vol);
    }
  }

  // 2. Découpages en fin de chaîne : dernier mot = nom d'auteur (ex. "mythe de sisyphe" + "camus"), puis 2 derniers mots ("la mort a venise" + "thomas mann")
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    const last1 = words[words.length - 1];
    const normLast1 = normalizeTextKey(last1);
    if (normLast1.length >= 3 && !/^\d+$/.test(normLast1) && !NON_AUTHOR_START_WORDS.has(normLast1)) {
      pushSplit(words.slice(0, -1).join(' '), last1, null);
    }
  }
  if (words.length >= 4) {
    const last2First = normalizeTextKey(words[words.length - 2]);
    const last2Second = normalizeTextKey(words[words.length - 1]);
    if (
      last2Second.length >= 3 &&
      !/^\d+$/.test(last2Second) &&
      (last2First.length >= 1 && (!NON_AUTHOR_START_WORDS.has(last2First) || last2First === 'du' || last2First === 'de'))
    ) {
      pushSplit(words.slice(0, -2).join(' '), words.slice(-2).join(' '), null);
    }
  }

  return out.slice(0, 3);
}

const PAREN_MEDIA_MANGA_RE = /\b(?:mangas?|manhwa|manhua|sh[ôo]nen|seinen|sh[ôo]jo|josei)\b/i;
const PAREN_MEDIA_COMICS_RE = /\b(?:comics?|comic\s*books?)\b/i;
const PAREN_MEDIA_BD_RE = /\b(?:bd|b\.?d\.?|bandes?\s+dessin[ée]es?|romans?\s+graphiques?)\b/i;
const PAREN_MEDIA_ROMAN_RE = /^\s*romans?\s*$/i;
const PAREN_RANGE_RE = /^(?:t\.?|tomes?|vol\.?)\s*\d{1,3}\s*(?:[-–à&]|et)\s*\d{1,3}$/i;
const PAREN_EDITION_HINT_RE =
  /^(?:[ée]ditions?\s+|ed\.?\s+)?(?:deluxe|perfect|black|ultimate|collector|grand\s+format|int[ée]grale|omnibus|vertigo|urban|panini|gl[ée]nat|glenat|kana|pika|tonkam|kurokawa|delcourt|dupuis|dargaud|casterman|ki-?oon|soleil|akata|pocket|folio)/i;

const INTEGRAL_SIGNAL_RE =
  /\b(?:l['’])?int[ée]grale\b|\bcoffret\b|\bomnibus\b|\bcompendium\b|\btomes?\s*\d{1,2}\s*(?:[-–à&]|\bet\b)\s*\d{1,2}\b|\bt\.?\s*\d{1,2}\s*[-–]\s*\d{1,2}\b/i;

const INLINE_SERIES_VOL_TITLE_RE =
  /^(.{2,}?)\s*[-–:,]\s*(?:tome|t\.|vol\.?|volume|livre|[ée]pisode)\s*(\d{1,3}(?:\.\d)?|[ivx]{1,5})\s*[:\-–]\s*(.{2,})$/i;

const TRAILING_VOLUME_RE =
  /(?:\s*[-–:,]\s*|\s+)(?:(?:tome|t\.|vol\.?|volume|n°|#|livre|[ée]pisode)\s*(\d{1,3}(?:\.\d)?|[ivx]{1,5})|\bt(\d{1,3}(?:\.\d)?))\s*$/i;

const MID_VOLUME_AUTHOR_TAIL_RE =
  /^(.{3,}?)\s+(?:(?:tome|t\.|vol\.?|volume)\s*(\d{1,3}(?:\.\d)?)|t(\d{1,3}(?:\.\d)?))\s+([a-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ'’.\-\s]{1,40})$/i;

const EDITION_FORMAT_QUALIFIERS_RE =
  /(?:^|(?<=[^a-zA-ZÀ-ÿ]))(?:[ée]ditions?|ed\.?|deluxe|perfect|black\s+edition|edition\s+black|black|ultimate|collector|kanzenban|full\s+color|grand\s+format|poche|coffret|cult|signatures?)(?![a-zA-ZÀ-ÿ])/gi;

const TRAILING_PUBLISHER_HINT_RE =
  /\b(?:gl[ée]nat|glenat|kana|pika|panini|tonkam|kurokawa|urban|vertigo|delcourt|dupuis|dargaud|casterman|ki-?oon|soleil|akata)\b/gi;

const INTEGRAL_SUFFIX_STRIP_RE =
  /\s*[-–:,]?\s*(?:(?:l['’])?int[ée]grale\b.*|coffret\b.*|omnibus\b.*|compendium\b.*|tomes?\s*\d+\s*(?:[-–à&]|\bet\b)\s*\d+.*|t\.?\s*\d+\s*[-–]\s*\d+.*)$/i;

function collapseSpaces(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–:,/]+|[\s\-–:,/]+$/g, '')
    .trim();
}

function extractParentheticalHints(
  rawText: string,
  state: {
    requestedMedia: RequestedMediaHint | null;
    wantsIntegral: boolean;
    integralRange: Set<string>;
    editionHintTokens: Set<string>;
    inferredPublisher?: string;
  }
): string {
  if (!rawText) return '';
  return collapseSpaces(
    rawText.replace(/\(([^)]{1,45})\)/g, (fullMatch, innerRaw: string) => {
      const inner = innerRaw.trim();
      if (!inner) return '';

      if (PAREN_RANGE_RE.test(inner)) {
        state.wantsIntegral = true;
        for (const v of parseIncludedVolumeNumbers(inner)) {
          const n = parseInt(v, 10);
          if (n > 0 && n <= 150) state.integralRange.add(v);
        }
        return ' ';
      }

      let matchedMedia: RequestedMediaHint | null = null;
      let remainder = inner;

      if (PAREN_MEDIA_MANGA_RE.test(inner)) {
        matchedMedia = 'Manga';
        remainder = inner.replace(PAREN_MEDIA_MANGA_RE, ' ').trim();
      } else if (PAREN_MEDIA_COMICS_RE.test(inner)) {
        matchedMedia = 'Comics';
        remainder = inner.replace(PAREN_MEDIA_COMICS_RE, ' ').trim();
      } else if (PAREN_MEDIA_BD_RE.test(inner)) {
        matchedMedia = 'BD';
        remainder = inner.replace(PAREN_MEDIA_BD_RE, ' ').trim();
      } else if (PAREN_MEDIA_ROMAN_RE.test(inner)) {
        matchedMedia = 'Roman';
        remainder = '';
      }

      if (matchedMedia) {
        if (!state.requestedMedia) state.requestedMedia = matchedMedia;
        const cleanRem = collapseSpaces(remainder);
        if (cleanRem.length >= 2) {
          for (const tok of normalizeTextKey(cleanRem).split(' ')) {
            if (tok.length >= 2) state.editionHintTokens.add(tok);
          }
          if (!state.inferredPublisher) state.inferredPublisher = cleanRem;
        }
        return ' ';
      }

      if (PAREN_EDITION_HINT_RE.test(inner)) {
        for (const tok of normalizeTextKey(inner).split(' ')) {
          if (tok.length >= 2 && tok !== 'edition' && tok !== 'ed') {
            state.editionHintTokens.add(tok);
          }
        }
        return ' ';
      }

      return fullMatch;
    })
  );
}

function buildRelaxedText(
  text: string,
  explicitPublisher: string | undefined,
  editionHintTokens: Set<string>
): string {
  if (!text) return '';
  // Normalise les acronymes pointés en passe relâchée : "S.P.Q.R." -> "SPQR", "B.P.R.D." -> "BPRD"
  let relaxed = text.replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ''));

  const collectRemoved = (match: string) => {
    for (const tok of normalizeTextKey(match).split(' ')) {
      if (tok.length >= 3 && tok !== 'edition' && tok !== 'editions') {
        editionHintTokens.add(tok);
      }
    }
    return ' ';
  };

  const withoutEdition = collapseSpaces(relaxed.replace(EDITION_FORMAT_QUALIFIERS_RE, collectRemoved));
  if (normalizeTextKey(withoutEdition).length >= 4) {
    relaxed = withoutEdition;
  }

  // Retirer dynamiquement les jetons correspondant à l'éditeur explicitement fourni (zéro hardcoding)
  if (explicitPublisher) {
    const pubTokens = normalizeTextKey(explicitPublisher)
      .split(' ')
      .filter((t) => t.length >= 4);
    if (pubTokens.length > 0) {
      const words = relaxed.split(/\s+/);
      const filtered = words.filter((w) => {
        const nw = normalizeTextKey(w);
        if (pubTokens.includes(nw)) {
          editionHintTokens.add(nw);
          return false;
        }
        return true;
      });
      const candidate = collapseSpaces(filtered.join(' '));
      if (normalizeTextKey(candidate).length >= 4) {
        relaxed = candidate;
      }
    }
  }

  // Retirer aussi un tag éditeur collé en fin/milieu de saisie informelle (ex. "preacher panini", "jojo golden wind tonkam")
  const withoutPubTag = collapseSpaces(relaxed.replace(TRAILING_PUBLISHER_HINT_RE, collectRemoved));
  if (normalizeTextKey(withoutPubTag).length >= 4) {
    relaxed = withoutPubTag;
  }

  return relaxed;
}

function sanitizeSearchSymbols(raw: string): string {
  return raw
    .replace(/[™®©]/g, '')
    .replace(/(?:^|\s)_+|_+(?=\s|$|[.,:;!?])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSearchIntent(input: SearchIntentInput): ParsedSearchIntent {
  const state = {
    requestedMedia: null as RequestedMediaHint | null,
    wantsIntegral: Boolean(input.isIntegral),
    integralRange: new Set<string>(),
    editionHintTokens: new Set<string>(),
    inferredPublisher: undefined as string | undefined
  };

  let rawTitle = sanitizeSearchSymbols((input.title || '').trim());
  let rawSeries = sanitizeSearchSymbols((input.series || '').trim());
  const explicitPub = input.publisher?.trim() || undefined;
  let cleanAuthor = input.author?.trim() || undefined;
  let authorInferredFromTitle = false;

  const allAuthorParts = cleanAuthor
    ? cleanAuthor
        .split(/\s*(?:\/|&|;|,|\bet\b|\band\b)\s*/i)
        .map((p) => p.trim())
        .filter((p) => p.length >= 2)
    : [];

  // 1. Extraction des marqueurs parenthétiques sur série et titre : (BD), (manga Kurokawa), (comics), (T.1-4)...
  let cleanSeries = extractParentheticalHints(rawSeries, state);
  let cleanTitle = extractParentheticalHints(rawTitle, state);

  // 2. Détection intégrale / coffret / plage multi-tomes
  const combinedBeforeVol = `${cleanSeries} ${cleanTitle}`.trim();
  if (!state.wantsIntegral && INTEGRAL_SIGNAL_RE.test(combinedBeforeVol)) {
    state.wantsIntegral = true;
  }
  if (state.wantsIntegral) {
    const rangeCandidates = parseIncludedVolumeNumbers(combinedBeforeVol);
    if (rangeCandidates.length >= 2) {
      for (const v of rangeCandidates) {
        const n = parseInt(v, 10);
        if (n > 0 && n <= 150) state.integralRange.add(v);
      }
    }
  }

  // 3. Extraction du numéro de tome (priorité au champ explicite, sinon extraction depuis le titre/série)
  let volumeNumber = parseVolumeToken(input.volumeNumber);

  // Cas "Série - Tome 1 : Titre d'album" (ex. "Le Fléau - Tome 1 : L'Épidémie")
  if (!state.wantsIntegral && cleanTitle) {
    const inlineMatch = INLINE_SERIES_VOL_TITLE_RE.exec(cleanTitle);
    if (inlineMatch) {
      const leftSeries = collapseSpaces(inlineMatch[1]);
      const parsedVol = parseVolumeToken(inlineMatch[2]);
      const rightTitle = collapseSpaces(inlineMatch[3]);
      if (parsedVol && leftSeries.length >= 2 && rightTitle.length >= 2) {
        if (!cleanSeries) cleanSeries = leftSeries;
        if (!volumeNumber) volumeNumber = parsedVol;
        cleanTitle = rightTitle;
      }
    }
  }

  // Cas suffixe de tome collé dans le titre (ex. "Assassination Classroom Tome 19", "bleach deluxe t2", "Blast Tome II", "Millénium Saga - Tome 3")
  let matchedTrailingVol = false;
  if (!state.wantsIntegral && cleanTitle) {
    const trailingMatch = TRAILING_VOLUME_RE.exec(cleanTitle);
    if (trailingMatch) {
      const rawToken = trailingMatch[1] || trailingMatch[2];
      const parsedVol = parseVolumeToken(rawToken);
      const stripped = collapseSpaces(cleanTitle.slice(0, trailingMatch.index));
      if (parsedVol && stripped.length >= 2) {
        if (!volumeNumber) volumeNumber = parsedVol;
        cleanTitle = stripped;
        matchedTrailingVol = true;
      }
    }
  }

  // Cas saisie omnibox avec tome au milieu suivi d'un nom d'auteur/éditeur (ex. "Les Chroniques d'Arslan T5 Arakawa",
  // "echoes tome 2 sanbe", "les enquetes d'enola holmes tome 1 serena blasco", "les montagnes hallucinees t1 manga gou tanabe")
  if (!state.wantsIntegral && !matchedTrailingVol && cleanTitle) {
    const midMatch = MID_VOLUME_AUTHOR_TAIL_RE.exec(cleanTitle);
    if (midMatch) {
      const parsedVol = parseVolumeToken(midMatch[2] || midMatch[3]);
      let tail = collapseSpaces(midMatch[4]);
      const leftTitle = collapseSpaces(midMatch[1]);
      // Détecter éventuel mot média collé juste après le tome ("t1 manga gou tanabe", "t1 light novel ofelbe")
      if (/\bmangas?\b/i.test(tail)) {
        if (!state.requestedMedia) state.requestedMedia = 'Manga';
        tail = collapseSpaces(tail.replace(/\bmangas?\b/gi, ' '));
      } else if (/\bcomics?\b/i.test(tail)) {
        if (!state.requestedMedia) state.requestedMedia = 'Comics';
        tail = collapseSpaces(tail.replace(/\bcomics?\b/gi, ' '));
      } else if (/\blight\s+novel\b/i.test(tail)) {
        if (!state.requestedMedia) state.requestedMedia = 'Roman';
        tail = collapseSpaces(tail.replace(/\blight\s+novel\b/gi, ' '));
      }
      const tailCleaned = collapseSpaces(tail.replace(OMNIBOX_NOISE_RE, ' '));
      const tailWords = tailCleaned.split(/\s+/).filter(Boolean);
      const firstTailNorm = tailWords[0] ? normalizeTextKey(tailWords[0]) : '';
      if (
        parsedVol &&
        leftTitle.length >= 3 &&
        (tailWords.length === 0 ||
          (tailWords.length <= 3 && Boolean(firstTailNorm) && !NON_AUTHOR_START_WORDS.has(firstTailNorm)))
      ) {
        if (!volumeNumber) volumeNumber = parsedVol;
        cleanTitle = leftTitle;
        if (!cleanAuthor && tailCleaned.length >= 3) {
          cleanAuthor = tailCleaned;
          authorInferredFromTitle = true;
          allAuthorParts.push(tailCleaned);
        }
      }
    }
  }

  // 4. Construction des versions relâchées pour la passe de secours (sans qualificatifs d'édition/éditeur)
  const effectivePublisher = explicitPub || state.inferredPublisher;
  const relaxedSeries = buildRelaxedText(cleanSeries, effectivePublisher, state.editionHintTokens);
  const relaxedTitle = buildRelaxedText(cleanTitle, effectivePublisher, state.editionHintTokens);

  // 5. Base de série pour recherche d'intégrales BnF (ex. "Les Vieux Fourneaux - L'intégrale T.1-3" -> "Les Vieux Fourneaux")
  let integralSeriesBase = relaxedSeries || cleanSeries;
  if (!integralSeriesBase && state.wantsIntegral) {
    const baseFromTitle = collapseSpaces((cleanTitle || rawTitle).replace(INTEGRAL_SUFFIX_STRIP_RE, ''));
    const relaxedBase = buildRelaxedText(baseFromTitle, effectivePublisher, state.editionHintTokens);
    integralSeriesBase = relaxedBase || baseFromTitle;
  }

  const volumeNumeric = volumeNumber && /^\d+$/.test(volumeNumber) ? parseInt(volumeNumber, 10) : null;

  return {
    cleanTitle,
    cleanSeries,
    relaxedTitle,
    relaxedSeries,
    integralSeriesBase,
    volumeNumber,
    volumeNumeric,
    requestedMedia: state.requestedMedia,
    wantsIntegral: state.wantsIntegral,
    integralRange: Array.from(state.integralRange).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
    editionHintTokens: Array.from(state.editionHintTokens),
    cleanAuthor,
    allAuthorParts,
    effectivePublisher,
    authorInferredFromTitle
  };
}
