// src/shared/bibliographic/text-normalize.util.ts
// Primitives pures de normalisation textuelle et nettoyage bibliographique (zéro import externe).

const LEADING_ARTICLES_RE = /^(?:l'|le\s+|la\s+|les\s+|un\s+|une\s+|des\s+|du\s+|the\s+|a\s+|an\s+)/i;

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'ou', 'au', 'aux',
  'en', 'dans', 'sur', 'par', 'pour', 'avec', 'sans', 'sous', 'vers', 'chez',
  'the', 'of', 'and', 'in', 'to', 'for', 'on', 'with'
]);

const UNIMARC_100_CODED_RE = /^\d{8}[a-z|]\d{4}|y0frey\d{2}/i;
const GENERIC_VOLUME_TITLE_RE = /^(?:tome|vol\.?|volume|t\.?|n°|#)?\s*\d+(?:\s*[-–]\s*\d+)?$/i;
const SERIES_PREFIX_NOISE_RE = /^(?:les\s+aventures\s+d[e'’]\s*|une\s+aventure\s+d[e'’]\s*|la\s+s[ée]rie\s+)/i;

export function normalizeTextKey(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’".,:;!?()[\]/&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripLeadingArticles(value: string): string {
  return (value || '').trim().replace(LEADING_ARTICLES_RE, '').trim();
}

export function normalizeSeriesNumber(raw?: string | number | null): string {
  if (raw === undefined || raw === null) return '';
  const cleaned = String(raw)
    .replace(/^\[|\]$/g, '')
    .replace(/^(?:tome|vol\.?|volume|t\.?|n°|#)\s*/i, '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .trim();
  if (!cleaned || cleaned.length > 12 || /\s/.test(cleaned)) return '';
  return /^\d+$/.test(cleaned) ? String(parseInt(cleaned, 10)) : cleaned;
}

export function getLevenshteinDistance(a: string, b: string): number {
  const s1 = normalizeTextKey(a);
  const s2 = normalizeTextKey(b);
  if (s1 === s2) return 0;
  if (!s1.length) return s2.length;
  if (!s2.length) return s1.length;

  const prev = new Array<number>(s2.length + 1);
  const curr = new Array<number>(s2.length + 1);
  for (let j = 0; j <= s2.length; j++) prev[j] = j;

  for (let i = 1; i <= s1.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= s2.length; j++) prev[j] = curr[j];
  }
  return prev[s2.length];
}

export function tokenOverlapRatio(needle: string, haystack: string): number {
  const rawNeedle = normalizeTextKey(needle).split(' ').filter((tok) => tok.length >= 2);
  const filteredNeedle = rawNeedle.filter((tok) => !STOP_WORDS.has(tok));
  const needleTokens = filteredNeedle.length > 0 ? filteredNeedle : rawNeedle;
  const hayTokens = new Set(normalizeTextKey(haystack).split(' ').filter((tok) => tok.length >= 2));
  if (needleTokens.length === 0 || hayTokens.size === 0) return 0;

  let hits = 0;
  for (const tok of needleTokens) {
    if (hayTokens.has(tok)) hits++;
  }
  return hits / needleTokens.length;
}

export function cleanTitle(rawTitle: string): string {
  if (!rawTitle) return '';
  return rawTitle.replace(/\|/g, '').split('/')[0].trim();
}

export function isTechnicalUnimarcHeader(raw: string): boolean {
  return UNIMARC_100_CODED_RE.test((raw || '').trim());
}

/**
 * Nettoie un nom d'auteur MARC (rejette l'en-tête codé UNIMARC 100$a, retire les rôles et dates, inverse Nom, Prénom).
 */
export function cleanAuthor(rawAuthor: string): string {
  if (!rawAuthor) return '';
  if (isTechnicalUnimarcHeader(rawAuthor)) return '';

  let cleaned = rawAuthor
    .replace(
      /\.\s*(?:auteur(?:\s+du\s+texte|\s+adaptateur)?|illustrateur|dessinateur|sc[ée]nariste|traducteur|coloriste|directeur(?:\s+de\s+publication)?|pr[ée]facier|[ée]diteur(?:\s+scientifique)?|collaborateur|adaptateur|postfacier|photographe|cartographe|compositeur|interpr[èe]te)\b.*$/i,
      ''
    )
    .trim();

  cleaned = cleaned
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/^\d{4}-\d{0,4}\s+/, '')
    .replace(/\s+\d{4}-\d{0,4}$/, '')
    .trim();

  if (!/\b[A-Z]\.$/.test(cleaned)) {
    cleaned = cleaned.replace(/[.\s]+$/, '').trim();
  }

  if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    const lastName = parts[0].trim();
    const firstName = parts.slice(1).join(',').trim();
    return `${firstName} ${lastName}`.trim();
  }
  return cleaned;
}

export function cleanPublisher(rawPublisher: string): string {
  if (!rawPublisher) return '';
  return rawPublisher.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function cleanPublishDate(rawDate: string): string {
  if (!rawDate) return '';
  const match = rawDate.match(/\d{4}/);
  return match ? match[0] : '';
}

export function cleanPageCount(rawFormat: string): number | undefined {
  if (!rawFormat) return undefined;
  const match = rawFormat.match(/(\d+)\s*p\b/i);
  return match ? parseInt(match[1], 10) : undefined;
}

export function cleanSeriesName(series: string): string {
  if (!series) return '';
  return series
    .replace(/\|/g, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\.+$/, '')
    .trim();
}

export function extractAuthorLastNameForQuery(rawAuthor?: string): string {
  if (!rawAuthor) return '';
  const trimmed = rawAuthor.trim();
  if (isTechnicalUnimarcHeader(trimmed) || /^(?:auteur\s+inconnu|inconnu)$/i.test(trimmed)) {
    return '';
  }
  const cleaned = trimmed
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/["()]/g, ' ')
    .split(/\s+(?:et|and)\s+|[,;/&]|\s+-\s+/i)[0]
    .trim();
  if (!cleaned) return '';
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.replace(/^[.'’]+|[.'’]+$/g, ''))
    .filter((w) => w.replace(/[^a-zA-ZÀ-ÿ]/g, '').length >= 2);
  return words.length > 0 ? words[words.length - 1] : '';
}

/**
 * Extrait le tronc commun normalisé d'une franchise (ex: "Astérix, la grande collection" -> "asterix",
 * "Les Aventures d'Astérix" -> "asterix") sans liste éditoriale codée en dur.
 */
export function extractFranchiseBaseName(rawSeriesName: string): { baseName: string; normalizedKey: string } {
  const cleaned = cleanSeriesName(rawSeriesName);
  const head = cleaned.split(/\s*[,—–]\s*/)[0].trim();
  const stripped = head.replace(SERIES_PREFIX_NOISE_RE, '').trim();
  const baseName = stripped.length >= 2 ? stripped : cleaned;
  return {
    baseName,
    normalizedKey: normalizeTextKey(baseName)
  };
}

/**
 * Indique si un titre d'ouvrage est générique vis-à-vis de sa série (ex: "Tome 1", "Bug", "Bug, Tome 4")
 * et ne permet donc pas à lui seul de distinguer deux tomes ou d'écraser un titre distinctif.
 */
export function isGenericVolumeTitle(title: string, seriesName: string): boolean {
  const cleanT = normalizeTextKey(title);
  const cleanS = normalizeTextKey(seriesName);
  if (!cleanT) return true;
  if (GENERIC_VOLUME_TITLE_RE.test(title.trim())) return true;
  if (cleanS && cleanT === cleanS) return true;
  if (cleanS && cleanT.startsWith(cleanS)) {
    const rest = cleanT.slice(cleanS.length).trim();
    if (!rest || GENERIC_VOLUME_TITLE_RE.test(rest)) return true;
  }
  return false;
}

/**
 * Vérifie si un nom de série candidat (ex. issu d'une colonne BnF 460) est structurellement compatible
 * avec la série retenue (même clé normalisée, même tronc de franchise ou fort recouvrement bilatéral).
 * Empêche une collection éditoriale hétérogène (ex. "Les archives Tintin") de contaminer une série canonique ("Les Aventures de Tintin").
 */
export function isCompatibleSeriesName(candidateSeries: string | undefined, winningSeries: string): boolean {
  if (!candidateSeries || !winningSeries) return false;
  const cleanCand = cleanSeriesName(candidateSeries);
  const cleanWin = cleanSeriesName(winningSeries);
  const normCand = normalizeTextKey(cleanCand);
  const normWin = normalizeTextKey(cleanWin);
  if (!normCand || !normWin) return false;
  if (normCand === normWin) return true;

  const candBase = extractFranchiseBaseName(cleanCand).normalizedKey;
  const winBase = extractFranchiseBaseName(cleanWin).normalizedKey;
  if (candBase && winBase && candBase === winBase) return true;

  return tokenOverlapRatio(cleanCand, cleanWin) >= 0.7 && tokenOverlapRatio(cleanWin, cleanCand) >= 0.7;
}

/**
 * Compare un nom d'auteur candidat à une cible (simple ou duo "Auteur 1 / Auteur 2", "Auteur 1 & Auteur 2")
 * de manière insensible aux accents, tirets, majuscules et ordre "Prénom Nom" vs "Nom, Prénom".
 */
export function matchesAuthorName(candidateAuthor: string, targetAuthor: string): boolean {
  const cand = normalizeTextKey(candidateAuthor);
  if (!cand || !targetAuthor?.trim()) return false;

  const targetParts = targetAuthor
    .split(/\s*(?:\/|&|;|\bet\b|\band\b)\s*/i)
    .map((p) => normalizeTextKey(p))
    .filter(Boolean);
  if (targetParts.length === 0) return false;

  const candTokens = new Set(cand.split(' ').filter((tok) => tok.length >= 2));

  return targetParts.some((target) => {
    if (cand === target) return true;
    if (target.length >= 3 && cand.includes(target)) return true;
    if (cand.length >= 3 && target.includes(cand)) return true;
    const targetTokens = target.split(' ').filter((tok) => tok.length >= 2);
    return targetTokens.length > 0 && targetTokens.every((tok) => candTokens.has(tok));
  });
}
