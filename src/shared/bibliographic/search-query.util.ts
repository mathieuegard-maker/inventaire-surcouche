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
  if (/^\d{1,3}$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n > 0 ? String(n) : null;
  }
  const roman = ROMAN_MAP[trimmed.toLowerCase()];
  if (roman) return String(roman);
  const norm = normalizeSeriesNumber(trimmed);
  if (norm && /^\d{1,3}$/.test(norm)) {
    const n = parseInt(norm, 10);
    return n > 0 ? String(n) : null;
  }
  return norm || null;
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
  /^(.{2,}?)\s*[-–:,]\s*(?:tome|t\.|vol\.?|volume|livre|[ée]pisode)\s*(\d{1,3}|[ivx]{1,5})\s*[:\-–]\s*(.{2,})$/i;

const TRAILING_VOLUME_RE =
  /(?:\s*[-–:,]\s*|\s+)(?:(?:tome|t\.|vol\.?|volume|n°|#|livre|[ée]pisode)\s*(\d{1,3}|[ivx]{1,5})|\bt(\d{1,3}))\s*$/i;

const EDITION_FORMAT_QUALIFIERS_RE =
  /\b(?:[ée]ditions?|ed\.?|deluxe|perfect|black\s+edition|edition\s+black|black|ultimate|collector|kanzenban|full\s+color|grand\s+format|poche|coffret|cult|signatures?)\b/gi;

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
  let relaxed = text;

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

export function parseSearchIntent(input: SearchIntentInput): ParsedSearchIntent {
  const state = {
    requestedMedia: null as RequestedMediaHint | null,
    wantsIntegral: Boolean(input.isIntegral),
    integralRange: new Set<string>(),
    editionHintTokens: new Set<string>(),
    inferredPublisher: undefined as string | undefined
  };

  let rawTitle = (input.title || '').trim();
  let rawSeries = (input.series || '').trim();
  const explicitPub = input.publisher?.trim() || undefined;
  const cleanAuthor = input.author?.trim() || undefined;

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
  if (!state.wantsIntegral && cleanTitle) {
    const trailingMatch = TRAILING_VOLUME_RE.exec(cleanTitle);
    if (trailingMatch) {
      const rawToken = trailingMatch[1] || trailingMatch[2];
      const parsedVol = parseVolumeToken(rawToken);
      const stripped = collapseSpaces(cleanTitle.slice(0, trailingMatch.index));
      if (parsedVol && stripped.length >= 2) {
        if (!volumeNumber) volumeNumber = parsedVol;
        cleanTitle = stripped;
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
    effectivePublisher
  };
}
