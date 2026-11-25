// src/server/connectors/wikidata.connector.ts
// Connecteur Wikidata : wbgetentities (P179/P1545/P50/P18) + SPARQL d'expansion de série par le graphe.

import {
  cleanPublishDate,
  cleanSeriesName,
  cleanTitle,
  extractAuthorLastNameForQuery,
  normalizeSeriesNumber,
  normalizeTextKey
} from '../../shared/bibliographic/text-normalize.util';
import type { HttpClient } from './http-client';
import type { GraphSeriesWork, SourceCandidateRecord, WikidataConnector } from './types';

const WD_API = 'https://www.wikidata.org/w/api.php';
const WD_SPARQL = 'https://query.wikidata.org/sparql';

interface WdEntity {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  sitelinks?: {
    frwiki?: { title?: string };
  };
  claims?: Record<
    string,
    Array<{
      mainsnak?: {
        datavalue?: {
          value?: string | { id?: string; time?: string };
        };
      };
      qualifiers?: Record<
        string,
        Array<{
          datavalue?: { value?: string };
        }>
      >;
    }>
  >;
}

interface WdEntitiesResponse {
  entities?: Record<string, WdEntity>;
}

interface SparqlResponse {
  results?: {
    bindings?: Array<Record<string, { value: string }>>;
  };
}

interface WdSearchResponse {
  search?: Array<{
    id?: string;
    label?: string;
    description?: string;
  }>;
}

function stripWikipediaDisambiguator(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  const stripped = trimmed.replace(/\s+\([^)]+\)$/, '').trim();
  return stripped.length >= 2 ? stripped : trimmed;
}

function getWdLabel(entity: WdEntity | undefined): string {
  if (!entity) return '';
  const frLabel = entity.labels?.fr?.value?.trim() || '';
  const frWikiRaw = entity.sitelinks?.frwiki?.title?.trim() || '';
  const frWiki = frWikiRaw ? stripWikipediaDisambiguator(frWikiRaw) : '';

  if (frWiki) {
    if (!frLabel) return frWiki;
    const copiedFromForeign = ['en', 'it', 'de', 'es'].some(
      (lang) => entity.labels?.[lang]?.value?.trim() === frLabel
    );
    if (copiedFromForeign && normalizeTextKey(frWiki) !== normalizeTextKey(frLabel)) {
      return frWiki;
    }
  }

  if (!entity.labels) return frWiki;
  return frLabel || entity.labels.en?.value || Object.values(entity.labels)[0]?.value || '';
}

function getWdClaimQids(entity: WdEntity | undefined, prop: string): string[] {
  const list = entity?.claims?.[prop] ?? [];
  const out: string[] = [];
  for (const stmt of list) {
    const val = stmt.mainsnak?.datavalue?.value;
    if (val && typeof val === 'object' && val.id) {
      out.push(val.id);
    }
  }
  return out;
}

function commonsFilenameToUrl(filename?: string): string | undefined {
  if (!filename) return undefined;
  const clean = filename.replace(/^Special:FilePath\//i, '').trim();
  if (!clean || /\.svg$/i.test(clean)) return undefined;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(clean)}?width=400`;
}

export function createWikidataConnector(http: HttpClient): WikidataConnector {
  async function getEntities(qids: string[]): Promise<Record<string, WdEntity>> {
    const clean = Array.from(new Set(qids.filter((q) => /^Q\d+$/i.test(q)).map((q) => q.toUpperCase())));
    if (clean.length === 0) return {};

    const url = `${WD_API}?action=wbgetentities&ids=${encodeURIComponent(clean.join('|'))}&languages=fr|en|it|de|es&props=labels|descriptions|claims|sitelinks&sitefilter=frwiki&format=json`;
    const data = await http.fetchJson<WdEntitiesResponse>({
      source: 'wikidata',
      url,
      timeoutMs: 8000,
      minIntervalMs: 250,
      cacheKey: `wd:entities:v2:${clean.sort().join('|')}`,
      cacheTtlSec: 60 * 60 * 24 * 7
    });
    return data?.entities ?? {};
  }

  function buildWorkCandidate(
    qid: string,
    work: WdEntity,
    related: Record<string, WdEntity>,
    fallbackIsbn13: string
  ): SourceCandidateRecord | null {
    const title = cleanTitle(getWdLabel(work));
    if (!title) return null;

    const seriesQids = getWdClaimQids(work, 'P179');
    const authorQids = getWdClaimQids(work, 'P50');
    const seriesQid = seriesQids[0];
    const seriesName = seriesQid ? cleanSeriesName(getWdLabel(related[seriesQid])) : undefined;
    const authors = authorQids.map((id) => getWdLabel(related[id])).filter(Boolean);

    // Numéro de tome dans le qualificateur P1545 sur P179 ou directement P1545
    const p179Stmt = work.claims?.P179?.[0];
    const qualOrdinal = p179Stmt?.qualifiers?.P1545?.[0]?.datavalue?.value;
    const directOrdinal = work.claims?.P1545?.[0]?.mainsnak?.datavalue?.value;
    const volumeNumber = normalizeSeriesNumber(
      qualOrdinal ?? (typeof directOrdinal === 'string' ? directOrdinal : '')
    );

    const pubTime = work.claims?.P577?.[0]?.mainsnak?.datavalue?.value;
    const publishYear =
      pubTime && typeof pubTime === 'object' && pubTime.time ? cleanPublishDate(pubTime.time) : undefined;

    const imgVal = work.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    const coverUrl = typeof imgVal === 'string' ? commonsFilenameToUrl(imgVal) : undefined;

    return {
      source: 'wikidata',
      isbn13: fallbackIsbn13,
      title,
      seriesName: seriesName || undefined,
      seriesLinkKind: seriesName ? 'graph_p179' : undefined,
      volumeNumber: volumeNumber || undefined,
      wikidataSeriesQid: seriesQid,
      wikidataWorkQid: qid,
      authors,
      scriptwriters: [],
      illustrators: [],
      publishYear: publishYear || undefined,
      description: work.descriptions?.fr?.value || work.descriptions?.en?.value,
      rawSubjects: [],
      coverUrl
    };
  }

  return {
    async lookupWorkByQid(workQid: string, fallbackIsbn13 = ''): Promise<SourceCandidateRecord | null> {
      const qid = workQid.toUpperCase();
      if (!/^Q\d+$/.test(qid)) return null;

      const entities = await getEntities([qid]);
      const work = entities[qid];
      if (!work) return null;

      const seriesQids = getWdClaimQids(work, 'P179');
      const authorQids = getWdClaimQids(work, 'P50');
      const relatedIds = [...seriesQids.slice(0, 1), ...authorQids.slice(0, 5)];
      const related = relatedIds.length > 0 ? await getEntities(relatedIds) : {};

      return buildWorkCandidate(qid, work, related, fallbackIsbn13);
    },

    /**
     * Recherche une Œuvre canonique sur Wikidata par (Titre + Auteur) avec triple verrou strict :
     *   1. Titre normalisé exactement égal au label FR ou EN de l'entité Wikidata ;
     *   2. L'entité appartient à une série (P179 présent -> exclut les homonymes isolés et les séries elles-mêmes) ;
     *   3. Le nom de famille normalisé de l'auteur correspond en mot entier à un créateur (P50 / P58 / P110).
     */
    async lookupWorkByTitleAndAuthor(
      title: string,
      author: string,
      fallbackIsbn13 = ''
    ): Promise<SourceCandidateRecord | null> {
      const cleanT = cleanTitle(title);
      const normTargetTitle = normalizeTextKey(cleanT);
      const authorLast = extractAuthorLastNameForQuery(author);
      const normAuthorLast = normalizeTextKey(authorLast);

      if (normTargetTitle.length < 4 || normAuthorLast.length < 2) return null;

      const searchUrl = `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(cleanT)}&language=fr&limit=6&format=json`;
      const data = await http.fetchJson<WdSearchResponse>({
        source: 'wikidata',
        url: searchUrl,
        timeoutMs: 7000,
        minIntervalMs: 250,
        cacheKey: `wd:search:work:${normTargetTitle}`,
        cacheTtlSec: 60 * 60 * 24 * 7
      });

      const rawCandidates = (data?.search ?? []).filter((c): c is { id: string; label?: string } =>
        Boolean(c.id && /^Q\d+$/i.test(c.id))
      );
      if (rawCandidates.length === 0) return null;

      // Prioriser les candidats dont le libellé de recherche correspond exactement au titre normalisé
      const exactFirst = [
        ...rawCandidates.filter((c) => normalizeTextKey(cleanTitle(c.label ?? '')) === normTargetTitle),
        ...rawCandidates.filter((c) => normalizeTextKey(cleanTitle(c.label ?? '')) !== normTargetTitle)
      ].slice(0, 5);

      const candidateQids = exactFirst.map((c) => c.id.toUpperCase());
      const entities = await getEntities(candidateQids);

      // Filtrer d'abord sur Verrou 1 (titre exact FR/EN) + Verrou 2 (présence de P179)
      const eligible: Array<{ qid: string; work: WdEntity; seriesQids: string[]; creatorQids: string[] }> = [];
      const relatedIdsToFetch = new Set<string>();

      for (const qid of candidateQids) {
        const work = entities[qid];
        if (!work) continue;

        const frNorm = normalizeTextKey(cleanTitle(work.labels?.fr?.value ?? ''));
        const enNorm = normalizeTextKey(cleanTitle(work.labels?.en?.value ?? ''));
        if (frNorm !== normTargetTitle && enNorm !== normTargetTitle) continue;

        const seriesQids = getWdClaimQids(work, 'P179');
        if (seriesQids.length === 0) continue;

        const creatorQids = Array.from(
          new Set([
            ...getWdClaimQids(work, 'P50'),
            ...getWdClaimQids(work, 'P58'),
            ...getWdClaimQids(work, 'P110')
          ])
        ).slice(0, 8);
        if (creatorQids.length === 0) continue;

        eligible.push({ qid, work, seriesQids, creatorQids });
        relatedIdsToFetch.add(seriesQids[0]);
        for (const cid of creatorQids) relatedIdsToFetch.add(cid);
      }

      if (eligible.length === 0) return null;

      const related = await getEntities(Array.from(relatedIdsToFetch));

      // Verrou 3 : au moins un créateur (P50 / P58 / P110) porte exactement le nom de famille de l'auteur
      for (const item of eligible) {
        const authorMatches = item.creatorQids.some((cid) => {
          const creatorEntity = related[cid];
          const frLabel = normalizeTextKey(creatorEntity?.labels?.fr?.value ?? '');
          const enLabel = normalizeTextKey(creatorEntity?.labels?.en?.value ?? '');
          return [frLabel, enLabel].some((lbl) => {
            if (!lbl) return false;
            return lbl === normAuthorLast || lbl.split(' ').includes(normAuthorLast);
          });
        });

        if (!authorMatches) continue;

        const candidate = buildWorkCandidate(item.qid, item.work, related, fallbackIsbn13);
        if (candidate?.seriesName) return candidate;
      }

      return null;
    },

    async fetchSeriesWorksByQid(seriesQid: string): Promise<GraphSeriesWork[]> {
      const qid = seriesQid.toUpperCase();
      if (!/^Q\d+$/.test(qid)) return [];

      const sparql = `
        SELECT ?work ?workLabel ?ordinal (SAMPLE(?frLbl) AS ?frLabel) (SAMPLE(?foreignCopy) AS ?foreignMatch) (SAMPLE(?frWikiTitle) AS ?frWiki) (SAMPLE(?pubDate) AS ?date) (GROUP_CONCAT(DISTINCT ?authorLabel; separator="|") AS ?authors) (SAMPLE(?img) AS ?image)
        WHERE {
          ?work p:P179 ?stmt .
          ?stmt ps:P179 wd:${qid} .
          OPTIONAL { ?stmt pq:P1545 ?ordinal . }
          OPTIONAL { ?work rdfs:label ?frLbl . FILTER(LANG(?frLbl) = "fr") }
          OPTIONAL {
            ?work rdfs:label ?altLbl .
            FILTER(LANG(?altLbl) IN ("en", "it", "de", "es"))
            FILTER(BOUND(?frLbl) && STR(?altLbl) = STR(?frLbl))
            BIND(?altLbl AS ?foreignCopy)
          }
          OPTIONAL {
            ?frArticle schema:about ?work ;
                       schema:isPartOf <https://fr.wikipedia.org/> ;
                       schema:name ?frWikiTitle .
          }
          OPTIONAL { ?work wdt:P577 ?pubDate . }
          OPTIONAL {
            ?work wdt:P50 ?author .
            ?author rdfs:label ?authorLabel .
            FILTER(LANG(?authorLabel) IN ("fr", "en"))
          }
          OPTIONAL { ?work wdt:P18 ?img . }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
        }
        GROUP BY ?work ?workLabel ?ordinal
        LIMIT 250
      `.trim();

      const url = `${WD_SPARQL}?format=json&query=${encodeURIComponent(sparql)}`;
      const data = await http.fetchJson<SparqlResponse>({
        source: 'wikidata',
        url,
        timeoutMs: 10000,
        minIntervalMs: 400,
        headers: { Accept: 'application/sparql-results+json' },
        cacheKey: `wd:sparql:series:v2:${qid}`,
        cacheTtlSec: 60 * 60 * 24 * 3
      });

      const bindings = data?.results?.bindings ?? [];
      const works: GraphSeriesWork[] = [];
      const seenQids = new Set<string>();

      for (const row of bindings) {
        const workUri = row.work?.value ?? '';
        const workQidMatch = workUri.match(/(Q\d+)$/i);
        const workQid = workQidMatch ? workQidMatch[1].toUpperCase() : null;
        if (workQid && seenQids.has(workQid)) continue;
        if (workQid) seenQids.add(workQid);

        const rawLabel = row.workLabel?.value ?? '';
        const frLabel = row.frLabel?.value?.trim() ?? '';
        const hasForeignCopy = Boolean(row.foreignMatch?.value?.trim());
        const frWikiRaw = row.frWiki?.value?.trim() ?? '';
        const frWiki = frWikiRaw ? stripWikipediaDisambiguator(frWikiRaw) : '';
        const preferredLabel =
          frWiki && (!frLabel || (hasForeignCopy && normalizeTextKey(frWiki) !== normalizeTextKey(frLabel)))
            ? frWiki
            : rawLabel;

        const title = cleanTitle(preferredLabel);
        if (!title || /^Q\d+$/i.test(title)) continue;

        const volStr = normalizeSeriesNumber(row.ordinal?.value);
        const volNum = /^\d+$/.test(volStr) ? parseInt(volStr, 10) : null;
        const authors = (row.authors?.value ?? '')
          .split('|')
          .map((a) => a.trim())
          .filter(Boolean);
        const publishYear = cleanPublishDate(row.date?.value ?? '') || null;
        const rawImg = row.image?.value ?? '';
        const coverUrl = rawImg && !/\.svg(?:[?#]|$)/i.test(rawImg) ? `${rawImg}?width=400` : null;

        works.push({
          title,
          volumeNumber: volNum,
          volumeLabel: volStr || null,
          sortOrder: volNum,
          wikidataQid: workQid,
          inventaireUri: workQid ? `wd:${workQid}` : null,
          authors: Array.from(new Set(authors)),
          isbn13s: [],
          publishYear,
          coverUrl,
          source: 'wikidata'
        });
      }

      return works;
    },

    async searchSeriesQids(
      seriesName: string,
      mediaFamily: 'graphic' | 'prose' | 'neutral' = 'neutral'
    ): Promise<string[]> {
      const q = seriesName.trim();
      if (!q) return [];

      const fetchCandidates = async (queryText: string) => {
        const url = `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(queryText)}&language=fr&uselang=fr&limit=8&format=json`;
        const data = await http.fetchJson<WdSearchResponse>({
          source: 'wikidata',
          url,
          timeoutMs: 7000,
          minIntervalMs: 250,
          cacheKey: `wd:search:series:fr:${queryText.toLowerCase()}`,
          cacheTtlSec: 60 * 60 * 24 * 7
        });
        return (data?.search ?? []).filter((c) => c.id && /^Q\d+$/i.test(c.id));
      };

      let candidates = await fetchCandidates(q);
      // Wikidata indexe "Boule et Bill" (pas "Boule & Bill") : bascule automatique & -> et si vide
      if (candidates.length === 0 && q.includes('&')) {
        const altQuery = q.replace(/\s*&\s*/g, ' et ').replace(/\s+/g, ' ').trim();
        if (altQuery && altQuery.toLowerCase() !== q.toLowerCase()) {
          candidates = await fetchCandidates(altQuery);
        }
      }
      if (candidates.length === 0) return [];

      const nonBookNoiseRe =
        /\b(franchise\s+m[ée]dia(?:tique)?|media\s+franchise|jeu\s+vid[ée]o|video\s*game|arcade\s+game|film|movie|t[ée]l[ée]vis|television|s[ée]rie\s+d['’]animation|animated|personnage|character|bande\s+originale|soundtrack|parc\s+d['’]attractions|theme\s+park)\b/i;
      const graphicSeriesRe =
        /\b(s[ée]ries?\s+(?:[a-zà-ÿ-]+\s+)?de\s+bandes?\s+dessin[ée]es?|bandes?\s+dessin[ée]es?|comic\s*books?\s+series|series\s+of\s+.*comic\s*books?|comic\s*books?|comics?|mangas?|romans?\s+graphiques?)\b/i;
      const proseSeriesRe =
        /\b(s[ée]ries?\s+litt[ée]raires?|s[ée]ries?\s+de\s+romans?|cycles?\s+litt[ée]raires?|book\s+series|novel\s+series)\b/i;
      const genericBookHintRe = /\b(s[ée]ries?|romans?|litt[ée]rature|albums?)\b/i;

      const scoreCandidate = (desc: string): number => {
        if (nonBookNoiseRe.test(desc)) return -50;
        const isGraphic = graphicSeriesRe.test(desc);
        const isProse = proseSeriesRe.test(desc);
        if (mediaFamily === 'prose' && isGraphic) return -30;
        if (mediaFamily === 'graphic' && isProse && !isGraphic) return -20;
        if (isGraphic) return 30;
        if (isProse) return 25;
        if (genericBookHintRe.test(desc)) return 10;
        return 0;
      };

      const ranked = candidates
        .map((c, idx) => ({
          qid: c.id!.toUpperCase(),
          score: scoreCandidate(c.description ?? ''),
          idx
        }))
        .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx));

      // Exclure le bruit évident (jeux vidéo, films, personnages, franchises média) s'il existe au moins un candidat pertinent
      const positive = ranked.filter((r) => r.score >= 0);
      const selected = positive.length > 0 ? positive : ranked;

      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of selected) {
        if (seen.has(item.qid)) continue;
        seen.add(item.qid);
        out.push(item.qid);
        if (out.length >= 4) break;
      }
      return out;
    },

    async searchSeriesQid(seriesName: string): Promise<string | null> {
      const qids = await this.searchSeriesQids!(seriesName, 'neutral');
      return qids[0] ?? null;
    }
  };
}
