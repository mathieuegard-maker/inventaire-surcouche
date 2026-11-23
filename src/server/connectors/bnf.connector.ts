// src/server/connectors/bnf.connector.ts
// Connecteur BnF SRU en HTTPS (`https://catalogue.bnf.fr/api/SRU`) via node:https IPv4 forcé + User-Agent navigateur.

import { parseMarcRecord, type ParsedMarcRecord } from '../../shared/bibliographic/intermarc-parser';
import { extractAuthorLastNameForQuery, normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type { HttpClient } from './http-client';
import type {
  BnfConnector,
  BnfSeriesDiscoveryResult,
  CollectionSampleItem,
  GraphSeriesWork,
  SourceCandidateRecord
} from './types';

const BNF_SRU_BASE = 'https://catalogue.bnf.fr/api/SRU';

function splitSruRecords(xml: string): string[] {
  const records: string[] = [];
  const regex = /<srw:recordData>([\s\S]*?)<\/srw:recordData>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    records.push(match[1]);
  }
  return records;
}

function toCandidate(parsed: ParsedMarcRecord, fallbackIsbn13: string): SourceCandidateRecord {
  const hasEnsemble = Boolean(parsed.ensembleSeriesName);
  const seriesName = parsed.ensembleSeriesName ?? parsed.collectionName;
  const seriesLinkKind = hasEnsemble
    ? 'marc_ensemble_460'
    : parsed.collectionName
      ? 'marc_collection_225'
      : undefined;

  return {
    source: 'bnf',
    isbn13: parsed.isbn13 || fallbackIsbn13,
    title: parsed.title,
    subtitle: parsed.subtitle,
    seriesName,
    seriesLinkKind,
    volumeNumber: parsed.ensembleVolumeNumber ?? parsed.collectionNumber,
    bnfEnsembleId: parsed.bnfEnsembleId,
    collectionName: parsed.collectionName,
    collectionNumber: parsed.collectionNumber,
    authors: parsed.authors,
    scriptwriters: parsed.scriptwriters,
    illustrators: parsed.illustrators,
    publisher: parsed.publisher,
    publishYear: parsed.publishYear,
    pageCount: parsed.pageCount,
    description: parsed.description,
    language: parsed.language,
    deweyCode: parsed.deweyCode,
    rawSubjects: parsed.rawSubjects,
    coverUrl: parsed.bnfCoverUrl,
    isNonBook: parsed.isNonBook,
    isIntegralHint: parsed.isIntegralHint
  };
}

function toGraphWork(rec: ParsedMarcRecord): GraphSeriesWork {
  const volStr = rec.ensembleVolumeNumber || rec.collectionNumber || '';
  const volNum = /^\d+$/.test(volStr) ? parseInt(volStr, 10) : null;
  return {
    title: rec.title,
    volumeNumber: volNum,
    volumeLabel: volStr || null,
    sortOrder: volNum,
    authors: rec.authors,
    scriptwriters: rec.scriptwriters,
    illustrators: rec.illustrators,
    isbn13s: rec.isbn13 ? [rec.isbn13] : [],
    publisher: rec.publisher ?? null,
    collectionName: rec.collectionName ?? null,
    publishYear: rec.publishYear ?? null,
    pageCount: rec.pageCount ?? null,
    coverUrl: rec.bnfCoverUrl ?? null,
    isIntegral: rec.isIntegralHint,
    source: 'bnf'
  };
}

export function createBnfConnector(http: HttpClient): BnfConnector {
  async function querySru(cqlQuery: string, maxRecords: number, cacheKey?: string): Promise<ParsedMarcRecord[]> {
    const params = new URLSearchParams({
      version: '1.2',
      operation: 'searchRetrieve',
      recordSchema: 'intermarcxchange',
      maximumRecords: String(maxRecords),
      query: cqlQuery
    });
    const url = `${BNF_SRU_BASE}?${params.toString()}`;
    const xml = await http.fetchText({
      source: 'bnf',
      url,
      forceIpv4: true,
      headers: { Accept: 'application/xml, text/xml' },
      timeoutMs: 10000,
      minIntervalMs: 250,
      cacheKey,
      cacheTtlSec: 60 * 60 * 24 * 7
    });
    if (!xml) return [];

    const out: ParsedMarcRecord[] = [];
    for (const recXml of splitSruRecords(xml)) {
      const parsed = parseMarcRecord(recXml);
      if (parsed && !parsed.isNonBook) {
        out.push(parsed);
      }
    }
    return out;
  }

  return {
    async lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null> {
      let records = await querySru(`bib.isbn all "${isbn13}"`, 3, `bnf:isbn:${isbn13}`);
      if (records.length === 0) {
        records = await querySru(`bib.anywhere all "${isbn13}"`, 3, `bnf:any:${isbn13}`);
      }
      if (records.length === 0) return null;
      const best = records.find((r) => r.isbn13 === isbn13) ?? records[0];
      return toCandidate(best, isbn13);
    },

    async searchByEnsembleId(bnfEnsembleId: string, maxRecords = 50): Promise<GraphSeriesWork[]> {
      const cleanId = bnfEnsembleId.replace(/\D/g, '');
      if (!cleanId) return [];
      const records = await querySru(`bib.ens2bib all "${cleanId}"`, maxRecords, `bnf:ens:${cleanId}:${maxRecords}`);
      return records.map(toGraphWork);
    },

    async searchBySeriesName(
      seriesName: string,
      author?: string,
      maxRecords = 50
    ): Promise<BnfSeriesDiscoveryResult> {
      const safeSeries = seriesName.replace(/"/g, ' ').trim();
      if (!safeSeries) return { works: [], discoveredEnsembleIds: [] };

      const normSeries = normalizeTextKey(safeSeries);
      const lastName = extractAuthorLastNameForQuery(author);
      const cql = lastName
        ? `bib.title all "${safeSeries}" and bib.author all "${lastName}"`
        : `bib.title all "${safeSeries}"`;

      const records = await querySru(cql, maxRecords, `bnf:sername:${cql.toLowerCase()}:${maxRecords}`);
      const discoveredEnsembleIds = new Set<string>();
      const works: GraphSeriesWork[] = [];

      for (const rec of records) {
        const recSeriesNorm = normalizeTextKey(rec.ensembleSeriesName || '');
        const recTitleNorm = normalizeTextKey(rec.title || '');
        const matchesSeries =
          (recSeriesNorm && (recSeriesNorm === normSeries || recSeriesNorm.includes(normSeries) || normSeries.includes(recSeriesNorm))) ||
          (recTitleNorm && recTitleNorm.includes(normSeries));

        if (!matchesSeries) continue;

        if (rec.bnfEnsembleId && recSeriesNorm && (recSeriesNorm === normSeries || recSeriesNorm.includes(normSeries))) {
          discoveredEnsembleIds.add(rec.bnfEnsembleId);
        }
        if (rec.ensembleSeriesName || rec.ensembleVolumeNumber) {
          works.push(toGraphWork(rec));
        }
      }

      return {
        works,
        discoveredEnsembleIds: Array.from(discoveredEnsembleIds)
      };
    },

    async sampleByCollectionName(collectionName: string, maxRecords = 10): Promise<CollectionSampleItem[]> {
      const safe = collectionName.replace(/"/g, ' ').trim();
      if (!safe) return [];
      const records = await querySru(
        `bib.title all "${safe}"`,
        maxRecords,
        `bnf:colsample:${safe.toLowerCase()}:${maxRecords}`
      );
      return records.map((rec) => ({
        title: rec.title,
        authors: rec.authors,
        volumeNumber: rec.collectionNumber ?? rec.ensembleVolumeNumber
      }));
    },

    async searchByTitleAndAuthor(title: string, author?: string, maxRecords = 10): Promise<SourceCandidateRecord[]> {
      const safeTitle = title.replace(/"/g, ' ').trim();
      if (!safeTitle) return [];
      const lastName = extractAuthorLastNameForQuery(author);
      const cql = lastName
        ? `bib.title all "${safeTitle}" and bib.author all "${lastName}"`
        : `bib.title all "${safeTitle}"`;
      const records = await querySru(cql, maxRecords, `bnf:search:${cql.toLowerCase()}:${maxRecords}`);
      return records.map((r) => toCandidate(r, r.isbn13));
    }
  };
}
