// src/server/connectors/wikidata.connector.ts
// Connecteur Wikidata : wbgetentities (P179/P1545/P50/P18) + SPARQL d'expansion de série par le graphe.

import { cleanPublishDate, cleanSeriesName, cleanTitle, normalizeSeriesNumber } from '../../shared/bibliographic/text-normalize.util';
import type { HttpClient } from './http-client';
import type { GraphSeriesWork, SourceCandidateRecord, WikidataConnector } from './types';

const WD_API = 'https://www.wikidata.org/w/api.php';
const WD_SPARQL = 'https://query.wikidata.org/sparql';

interface WdEntity {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
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

function getWdLabel(entity: WdEntity | undefined): string {
  if (!entity?.labels) return '';
  return entity.labels.fr?.value || entity.labels.en?.value || Object.values(entity.labels)[0]?.value || '';
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

    const url = `${WD_API}?action=wbgetentities&ids=${encodeURIComponent(clean.join('|'))}&languages=fr|en&props=labels|descriptions|claims&format=json`;
    const data = await http.fetchJson<WdEntitiesResponse>({
      source: 'wikidata',
      url,
      timeoutMs: 8000,
      minIntervalMs: 250,
      cacheKey: `wd:entities:${clean.sort().join('|')}`,
      cacheTtlSec: 60 * 60 * 24 * 7
    });
    return data?.entities ?? {};
  }

  return {
    async lookupWorkByQid(workQid: string, fallbackIsbn13 = ''): Promise<SourceCandidateRecord | null> {
      const qid = workQid.toUpperCase();
      if (!/^Q\d+$/.test(qid)) return null;

      const entities = await getEntities([qid]);
      const work = entities[qid];
      if (!work) return null;

      const title = cleanTitle(getWdLabel(work));
      if (!title) return null;

      const seriesQids = getWdClaimQids(work, 'P179');
      const authorQids = getWdClaimQids(work, 'P50');
      const relatedIds = [...seriesQids.slice(0, 1), ...authorQids.slice(0, 5)];
      const related = relatedIds.length > 0 ? await getEntities(relatedIds) : {};

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
    },

    async fetchSeriesWorksByQid(seriesQid: string): Promise<GraphSeriesWork[]> {
      const qid = seriesQid.toUpperCase();
      if (!/^Q\d+$/.test(qid)) return [];

      const sparql = `
        SELECT ?work ?workLabel ?ordinal (SAMPLE(?pubDate) AS ?date) (GROUP_CONCAT(DISTINCT ?authorLabel; separator="|") AS ?authors) (SAMPLE(?img) AS ?image)
        WHERE {
          ?work p:P179 ?stmt .
          ?stmt ps:P179 wd:${qid} .
          OPTIONAL { ?stmt pq:P1545 ?ordinal . }
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
        cacheKey: `wd:sparql:series:${qid}`,
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

        const title = cleanTitle(row.workLabel?.value ?? '');
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

    async searchSeriesQid(seriesName: string): Promise<string | null> {
      const q = seriesName.trim();
      if (!q) return null;
      const url = `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(q)}&language=fr&limit=6&format=json`;
      const data = await http.fetchJson<WdSearchResponse>({
        source: 'wikidata',
        url,
        timeoutMs: 7000,
        minIntervalMs: 250,
        cacheKey: `wd:search:series:${q.toLowerCase()}`,
        cacheTtlSec: 60 * 60 * 24 * 7
      });

      const candidates = (data?.search ?? []).filter((c) => c.id && /^Q\d+$/i.test(c.id));
      if (candidates.length === 0) return null;

      // Priorité aux entités décrites comme série BD / livre / manga / roman
      const seriesHintRe = /\b(s[ée]rie|bande dessin[ée]e|bd|manga|comics|roman|litt[ée]rature|albums?)\b/i;
      const prioritized = [
        ...candidates.filter((c) => seriesHintRe.test(c.description ?? '')),
        ...candidates.filter((c) => !seriesHintRe.test(c.description ?? ''))
      ];

      return prioritized[0]?.id?.toUpperCase() ?? null;
    }
  };
}
