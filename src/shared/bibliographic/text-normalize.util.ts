// src/shared/bibliographic/text-normalize.util.ts
// Primitives pures de normalisation textuelle et nettoyage bibliographique (zéro import externe).

const LEADING_ARTICLES_RE = /^(?:l'|le\s+|la\s+|les\s+|un\s+|une\s+|des\s+|du\s+|the\s+|a\s+|an\s+)/i;

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'ou', 'au', 'aux',
  'en', 'dans', 'sur', 'par', 'pour', 'avec', 'sans', 'sous', 'vers', 'chez',
  'the', 'of', 'and', 'in', 'to', 'for', 'on', 'with'
]);

const UNIMARC_100_CODED_RE = /^\d{8}[a-z|]\d{4}|y0frey\d{2}/i;

export function normalizeTextKey(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’".,:;!?()[\]-]+/g, ' ')
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
