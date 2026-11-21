// src/core/resolvers/series-canonical.resolver.ts
// Résolveur canonique de séries (Wikidata P527/P179/P1545 + vote majoritaire pondéré multi-sources)
// 100% portable sur fetch() standard, zéro dépendance propriétaire Cloudflare.

import { normalizeSeriesNumber, normalizeTextKey, parseSeriesFromTitle } from './bnf.resolver';
import { getLevenshteinDistance } from '../utils/string.util';

const USER_AGENT_BASE = 'BiblioCollectionPWA/4.0 (mathieu.egard@gmail.com)';
const SERIES_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Collections/rééditions secondaires dont la numérotation interne diverge fréquemment
 * de l'ordre officiel de la série (ex: Fac-similés, Archives Tintin, Le Soir, France Loisirs, Atlas...).
 */
const DIVERGENT_NUMBERING_EDITION_REGEX =
  /\b(fac[- ]?simil[ée]?s?|archives?|france\s+loisirs|le\s+soir|atlas|hachette\s+collections?|club|collector|reporter|chronologique|poche|d[ée]couverte|s[ée]lection|hors[- ]commerce)\b/i;

export interface CanonicalVolumeEntry {
  volumeNumber: number;
  title: string;
  normalizedTitle: string;
  wikidataWorkQid?: string;
}

export interface CanonicalSeriesIndex {
  wikidataSeriesQid: string;
  canonicalSeriesName?: string;
  volumesByQid: Record<string, CanonicalVolumeEntry>;
  volumesByNormTitle: Record<string, CanonicalVolumeEntry>;
  fetchedAt: number;
}

export interface VolumeVoteCandidate {
  source: 'bnf' | 'inventaire' | 'wikidata' | 'openlibrary' | 'google_books' | string;
  volumeNumber?: string;
  seriesRaw?: string;
  collectionRaw?: string;
  publisher?: string;
  title?: string;
}

const canonicalSeriesCache = new Map<string, CanonicalSeriesIndex>();

/**
 * Normalise un titre d'album pour comparaison robuste au sein d'une série :
 * retire le nom de série en préfixe et les articles français initiaux (le, la, les, l', un, une, des).
 */
export function normalizeWorkTitleForSeriesMatch(rawTitle: string, seriesName?: string): string {
  let text = String(rawTitle || '').trim();
  if (!text) return '';
  if (seriesName?.trim()) {
    const escaped = seriesName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^${escaped}\\s*[-:–,|]\\s*`, 'i'), '').trim();
  }
  const parsed = parseSeriesFromTitle(text);
  const core = parsed.title || text;
  const norm = normalizeTextKey(core)
    .replace(/^(?:les|la|le|l|une|un|des|du|de|d)\s+/i, '')
    .trim();
  return norm || normalizeTextKey(core);
}

/**
 * Détermine si deux titres au sein d'une même série représentent deux albums DISTINCTS
 * (ex: "L'île noire" vs "L'étoile mystérieuse", "Le sceptre d'Ottokar" vs "Le trésor de Rackham le Rouge").
 * Retourne `false` si l'un des titres est générique (identique au nom de série, ex: "Culottées", "Boule & Bill")
 * ou si les deux titres sont des variantes du même album ("Temple du soleil" vs "Le temple du soleil").
 */
export function areDistinctSeriesWorkTitles(
  titleA?: string | null,
  titleB?: string | null,
  seriesName?: string | null
): boolean {
  const normA = normalizeWorkTitleForSeriesMatch(titleA || '', seriesName || undefined);
  const normB = normalizeWorkTitleForSeriesMatch(titleB || '', seriesName || undefined);
  if (!normA || !normB) return false;

  const normSeries = seriesName ? normalizeWorkTitleForSeriesMatch(seriesName) : '';
  const isGenericA = normA.length < 4 || (normSeries.length >= 3 && (normA === normSeries || normSeries.includes(normA)));
  const isGenericB = normB.length < 4 || (normSeries.length >= 3 && (normB === normSeries || normSeries.includes(normB)));
  if (isGenericA || isGenericB) return false;

  if (normA === normB) return false;
  if (normA.includes(normB) || normB.includes(normA)) return false;
  if (Math.min(normA.length, normB.length) >= 5 && getLevenshteinDistance(normA, normB) <= 2) {
    return false;
  }

  const tokensA = normA.split(/\s+/).filter((t) => t.length >= 3);
  const tokensB = normB.split(/\s+/).filter((t) => t.length >= 3);
  if (tokensA.length > 0 && tokensB.length > 0) {
    const setB = new Set(tokensB);
    const shared = tokensA.filter((t) => setB.has(t)).length;
    const minLen = Math.min(tokensA.length, tokensB.length);
    if (shared / minLen >= 0.6) return false;
  }

  return true;
}

/**
 * Indique si `candidateName` (ex: Wikidata "Les Aventures de Tintin") est un nom canonique
 * plus propre que `currentName` (ex: "Les aventures de Tintin reporter").
 */
export function isCleanerCanonicalSeriesName(candidateName?: string | null, currentName?: string | null): boolean {
  const cand = (candidateName || '').trim();
  const curr = (currentName || '').trim();
  if (!cand || cand.length < 2) return false;
  if (!curr) return true;
  if (normalizeTextKey(cand) === normalizeTextKey(curr)) return false;

  const currHasDivergent = DIVERGENT_NUMBERING_EDITION_REGEX.test(curr);
  const candHasDivergent = DIVERGENT_NUMBERING_EDITION_REGEX.test(cand);
  if (currHasDivergent && !candHasDivergent) return true;

  // Si le nom actuel englobe le nom canonique avec un suffixe parasite
  const normCand = normalizeTextKey(cand);
  const normCurr = normalizeTextKey(curr);
  if (normCurr.startsWith(normCand) && normCurr.length > normCand.length + 3) {
    return true;
  }
  return false;
}

/**
 * Recherche le numéro de tome dans un index canonique Wikidata (par QID puis par titre normalisé).
 */
export function lookupVolumeInCanonicalIndex(
  index: CanonicalSeriesIndex | null | undefined,
  params: {
    wikidataWorkQid?: string;
    titles: string[];
    seriesName?: string;
  }
): CanonicalVolumeEntry | null {
  if (!index) return null;

  if (params.wikidataWorkQid && index.volumesByQid[params.wikidataWorkQid]) {
    return index.volumesByQid[params.wikidataWorkQid];
  }

  const entries = Object.values(index.volumesByNormTitle);
  if (entries.length === 0) return null;

  for (const rawTitle of params.titles) {
    const norm = normalizeWorkTitleForSeriesMatch(rawTitle, params.seriesName || index.canonicalSeriesName);
    if (!norm || norm.length < 3) continue;
    if (index.volumesByNormTitle[norm]) {
      return index.volumesByNormTitle[norm];
    }
    // Match proche (Levenshtein <= 2 ou inclusion sur titre significatif)
    const fuzzy = entries.find(
      (e) =>
        e.normalizedTitle.length >= 5 &&
        norm.length >= 5 &&
        (e.normalizedTitle === norm ||
          e.normalizedTitle.includes(norm) ||
          norm.includes(e.normalizedTitle) ||
          getLevenshteinDistance(e.normalizedTitle, norm) <= 2)
    );
    if (fuzzy) return fuzzy;
  }

  return null;
}

/**
 * Résout le numéro de tome canonique d'un album par priorité :
 * 1. Arbitrage explicite utilisateur (`userHintVolume`)
 * 2. Index canonique Wikidata de la série (`canonicalSeriesIndex`)
 * 3. Vote majoritaire pondéré sur toutes les éditions sœurs (déclassement des rééditions/clubs à numérotation divergente)
 * 4. Extraction depuis les titres bruts en dernier recours.
 */
export function resolveCanonicalVolumeNumber(params: {
  userHintVolume?: string;
  wikidataWorkQid?: string;
  canonicalSeriesIndex?: CanonicalSeriesIndex | null;
  sisterEditions: VolumeVoteCandidate[];
  rawTitles: string[];
  seriesName?: string;
}): { volumeNumber: string; source: 'user_hint' | 'wikidata_series_index' | 'weighted_vote' | 'title_parse' | 'none' } {
  // 1. Arbitrage explicite utilisateur
  if (params.userHintVolume) {
    const normUser = normalizeSeriesNumber(params.userHintVolume);
    if (normUser && /^\d+$/.test(normUser) && Number(normUser) > 0) {
      return { volumeNumber: normUser, source: 'user_hint' };
    }
  }

  // 2. Index canonique de la série (Wikidata P179/P1545)
  const indexHit = lookupVolumeInCanonicalIndex(params.canonicalSeriesIndex, {
    wikidataWorkQid: params.wikidataWorkQid,
    titles: params.rawTitles,
    seriesName: params.seriesName
  });
  if (indexHit && indexHit.volumeNumber > 0) {
    return { volumeNumber: String(indexHit.volumeNumber), source: 'wikidata_series_index' };
  }

  // 3. Vote majoritaire pondéré sur toutes les éditions sœurs
  const votes = new Map<string, number>();
  for (const ed of params.sisterEditions) {
    if (!ed.volumeNumber) continue;
    const norm = normalizeSeriesNumber(ed.volumeNumber);
    if (!norm || !/^\d+$/.test(norm) || Number(norm) <= 0 || Number(norm) > 500) continue;

    let weight = 1.5;
    if (ed.source === 'wikidata') {
      weight = 4.5;
    } else if (ed.source === 'inventaire') {
      weight = 2.5;
    } else if (ed.source === 'bnf') {
      const editionBlob = [ed.seriesRaw, ed.collectionRaw, ed.publisher, ed.title].filter(Boolean).join(' ');
      weight = DIVERGENT_NUMBERING_EDITION_REGEX.test(editionBlob) ? 0.5 : 2.0;
    } else if (ed.source === 'google_books' || ed.source === 'openlibrary') {
      weight = 1.2;
    }
    votes.set(norm, (votes.get(norm) || 0) + weight);
  }

  if (votes.size > 0) {
    const ranked = Array.from(votes.entries()).sort((a, b) => b[1] - a[1]);
    return { volumeNumber: ranked[0][0], source: 'weighted_vote' };
  }

  // 4. Fallback sur les titres bruts
  for (const t of params.rawTitles) {
    const p = parseSeriesFromTitle(t);
    if (p.seriesNumber && /^\d+$/.test(p.seriesNumber) && Number(p.seriesNumber) > 0) {
      return { volumeNumber: p.seriesNumber, source: 'title_parse' };
    }
  }

  return { volumeNumber: '', source: 'none' };
}

/**
 * Interroge Wikidata pour construire l'index canonique d'une série (nom FR officiel + ordre des tomes via P179/P1545).
 * Non-bloquant et mis en cache en mémoire pour éviter tout ralentissement.
 */
export async function fetchCanonicalSeriesIndex(
  wikidataSeriesQid?: string | null
): Promise<CanonicalSeriesIndex | null> {
  const qid = (wikidataSeriesQid || '').trim().replace(/^wd:/i, '');
  if (!/^Q\d+$/i.test(qid)) return null;

  const cached = canonicalSeriesCache.get(qid);
  if (cached && Date.now() - cached.fetchedAt < SERIES_CACHE_TTL_MS) {
    return cached;
  }

  const volumesByQid: Record<string, CanonicalVolumeEntry> = {};
  const volumesByNormTitle: Record<string, CanonicalVolumeEntry> = {};
  let canonicalSeriesName: string | undefined;

  const registerEntry = (entry: CanonicalVolumeEntry) => {
    if (entry.volumeNumber <= 0 || entry.volumeNumber > 500) return;
    if (entry.wikidataWorkQid && !volumesByQid[entry.wikidataWorkQid]) {
      volumesByQid[entry.wikidataWorkQid] = entry;
    }
    if (entry.normalizedTitle && !volumesByNormTitle[entry.normalizedTitle]) {
      volumesByNormTitle[entry.normalizedTitle] = entry;
    }
  };

  // 1. Récupérer le label canonique FR de la série (+ éventuels P527)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=labels|claims&languages=fr|en&format=json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT_BASE },
        signal: controller.signal
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        const sEnt = json?.entities?.[qid];
        const frLabel = sEnt?.labels?.fr?.value || sEnt?.labels?.en?.value;
        if (typeof frLabel === 'string' && frLabel.trim()) {
          canonicalSeriesName = frLabel.trim();
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Non-bloquant
  }

  // 2. Requête SPARQL ciblée sur la série pour obtenir l'ordre officiel (pq:P1545 ou wdt:P1545) de tous les albums
  try {
    const sparql = `
SELECT ?work ?workLabel ?ordinal WHERE {
  ?work p:P179 ?stmt .
  ?stmt ps:P179 wd:${qid} .
  OPTIONAL { ?stmt pq:P1545 ?stmtOrd . }
  OPTIONAL { ?work wdt:P1545 ?directOrd . }
  BIND(COALESCE(?stmtOrd, ?directOrd) AS ?ordinal)
  FILTER(BOUND(?ordinal))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
}
LIMIT 120`.trim();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const sparqlUrl = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
      const res = await fetch(sparqlUrl, {
        headers: {
          'User-Agent': USER_AGENT_BASE,
          Accept: 'application/sparql-results+json'
        },
        signal: controller.signal
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const bindings = Array.isArray(data?.results?.bindings) ? data.results.bindings : [];
        for (const row of bindings) {
          const rawOrd = row?.ordinal?.value;
          const normOrd = rawOrd ? normalizeSeriesNumber(String(rawOrd)) : '';
          if (!normOrd || !/^\d+$/.test(normOrd)) continue;
          const volNum = parseInt(normOrd, 10);
          const rawWorkUri = String(row?.work?.value || '');
          const workQid = /Q\d+$/.exec(rawWorkUri)?.[0];
          const label = String(row?.workLabel?.value || '').trim();
          if (!label || /^Q\d+$/.test(label)) continue;
          registerEntry({
            volumeNumber: volNum,
            title: label,
            normalizedTitle: normalizeWorkTitleForSeriesMatch(label, canonicalSeriesName),
            wikidataWorkQid: workQid
          });
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Non-bloquant si SPARQL indisponible ou lent
  }

  const index: CanonicalSeriesIndex = {
    wikidataSeriesQid: qid,
    canonicalSeriesName,
    volumesByQid,
    volumesByNormTitle,
    fetchedAt: Date.now()
  };
  canonicalSeriesCache.set(qid, index);
  return index;
}

export function clearCanonicalSeriesCache(): void {
  canonicalSeriesCache.clear();
}
