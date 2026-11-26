// src/server/connectors/bnf.connector.ts
// Connecteur BnF SRU en HTTPS (`https://catalogue.bnf.fr/api/SRU`) via node:https IPv4 forcé + User-Agent navigateur.

import { parseMarcRecord, type ParsedMarcRecord } from '../../shared/bibliographic/intermarc-parser';
import {
  extractIncludedVolumesFromEditorialText,
  parseIncludedVolumeNumbers
} from '../../shared/bibliographic/integral.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import {
  extractAuthorLastNameForQuery,
  extractFranchiseBaseName,
  isCompatibleSeriesName,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../shared/bibliographic/text-normalize.util';
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
    hasStructuredEnsembleVolume: parsed.hasStructuredEnsembleVolume,
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
    originalLanguage: parsed.originalLanguage,
    deweyCode: parsed.deweyCode,
    rawSubjects: parsed.rawSubjects,
    coverUrl: parsed.bnfCoverUrl,
    isNonBook: parsed.isNonBook,
    isIntegralHint: parsed.isIntegralHint,
    integralNotes: parsed.integralNotes,
    contentKind: parsed.contentKind
  };
}

function isPressOrKioskOnlyRecord(rec: ParsedMarcRecord): boolean {
  return Boolean(rec.isbn13 && !isbnUtil.isValidBookBarcode(rec.isbn13));
}

function toGraphWork(rec: ParsedMarcRecord): GraphSeriesWork {
  const volStr = rec.ensembleVolumeNumber || rec.collectionNumber || '';
  const volNum = /^\d+$/.test(volStr) ? parseInt(volStr, 10) : null;
  return {
    title: rec.title,
    volumeNumber: volNum,
    volumeLabel: volStr || null,
    hasStructuredEnsembleVolume: rec.hasStructuredEnsembleVolume,
    sortOrder: volNum,
    bnfEnsembleId: rec.bnfEnsembleId ?? null,
    authors: rec.authors,
    scriptwriters: rec.scriptwriters,
    illustrators: rec.illustrators,
    isbn13s: rec.isbn13 ? [rec.isbn13] : [],
    editionRecords: rec.isbn13
      ? [
          {
            isbn13: rec.isbn13,
            publisher: rec.publisher ?? null,
            collectionName: rec.collectionName ?? null,
            publishYear: rec.publishYear ?? null,
            pageCount: rec.pageCount ?? null,
            coverUrl: rec.bnfCoverUrl ?? null,
            source: 'bnf'
          }
        ]
      : [],
    publisher: rec.publisher ?? null,
    collectionName: rec.collectionName ?? null,
    publishYear: rec.publishYear ?? null,
    pageCount: rec.pageCount ?? null,
    language: rec.language ?? null,
    originalLanguage: rec.originalLanguage ?? null,
    deweyCode: rec.deweyCode ?? null,
    rawSubjects: rec.rawSubjects,
    coverUrl: rec.bnfCoverUrl ?? null,
    isIntegral: rec.isIntegralHint,
    contentKind: rec.contentKind,
    source: 'bnf'
  };
}

export function createBnfConnector(http: HttpClient): BnfConnector {
  async function querySru(cqlQuery: string, maxRecords: number, cacheKey?: string): Promise<ParsedMarcRecord[]> {
    const url =
      `${BNF_SRU_BASE}?version=1.2&operation=searchRetrieve&recordSchema=intermarcxchange` +
      `&maximumRecords=${maxRecords}&startRecord=1&query=${encodeURIComponent(cqlQuery)}`;
    const xml = await http.fetchText({
      source: 'bnf',
      url,
      forceIpv4: true,
      headers: { Accept: 'application/xml, text/xml' },
      timeoutMs: 15000,
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
        // Les notices BnF antérieures à 2007 (ex. Blacksad T1, UW1 T1, Tardi) ne sont souvent indexées qu'en ISBN-10
        const isbn10 = isbnUtil.toIsbn10(isbn13);
        if (isbn10) {
          records = await querySru(`bib.isbn all "${isbn10}"`, 3, `bnf:isbn10:${isbn10}`);
        }
      }
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
      return records.filter((rec) => !isPressOrKioskOnlyRecord(rec)).map(toGraphWork);
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
        ? `bib.title all "${safeSeries}" and bib.author all "${lastName}" and bib.doctype any "a"`
        : `bib.title all "${safeSeries}" and bib.doctype any "a"`;

      const records = await querySru(cql, maxRecords, `bnf:sername:${cql.toLowerCase()}:${maxRecords}`);
      const discoveredEnsembleIds = new Set<string>();
      const works: GraphSeriesWork[] = [];

      for (const rec of records) {
        if (isPressOrKioskOnlyRecord(rec)) continue;
        const ensembleCompatible = Boolean(
          rec.ensembleSeriesName && isCompatibleSeriesName(rec.ensembleSeriesName, seriesName)
        );
        const recTitleNorm = normalizeTextKey(rec.title || '');
        const titleMatchesExactly =
          !rec.ensembleSeriesName &&
          Boolean(recTitleNorm && (recTitleNorm === normSeries || recTitleNorm.startsWith(`${normSeries} `)));

        if (!ensembleCompatible && !titleMatchesExactly) continue;

        if (rec.bnfEnsembleId && ensembleCompatible) {
          discoveredEnsembleIds.add(rec.bnfEnsembleId);
        }
        if (ensembleCompatible || (titleMatchesExactly && rec.ensembleVolumeNumber)) {
          works.push(toGraphWork(rec));
        }
      }

      return {
        works,
        discoveredEnsembleIds: Array.from(discoveredEnsembleIds)
      };
    },

    async searchSeriesVolume(
      seriesName: string,
      volumeNumber: number,
      author?: string
    ): Promise<GraphSeriesWork[]> {
      const safeSeries = seriesName.replace(/"/g, ' ').trim();
      if (!safeSeries || !Number.isInteger(volumeNumber) || volumeNumber <= 0) return [];

      const lastName = extractAuthorLastNameForQuery(author);
      const cql = lastName
        ? `bib.title all "${safeSeries} ${volumeNumber}" and bib.author all "${lastName}" and bib.doctype any "a"`
        : `bib.title all "${safeSeries} ${volumeNumber}" and bib.doctype any "a"`;

      const records = await querySru(cql, 10, `bnf:servol:${cql.toLowerCase()}`);
      const targetVol = String(volumeNumber);
      const works: GraphSeriesWork[] = [];

      for (const rec of records) {
        if (isPressOrKioskOnlyRecord(rec)) continue;
        if (rec.ensembleVolumeNumber !== targetVol) continue;
        const ensembleCompatible = Boolean(
          rec.ensembleSeriesName && isCompatibleSeriesName(rec.ensembleSeriesName, seriesName)
        );
        const normSeries = normalizeTextKey(safeSeries);
        const recTitleNorm = normalizeTextKey(rec.title || '');
        const titleMatches =
          !rec.ensembleSeriesName &&
          Boolean(recTitleNorm && (recTitleNorm === normSeries || recTitleNorm.startsWith(`${normSeries} `)));
        if (!ensembleCompatible && !titleMatches) continue;
        works.push(toGraphWork(rec));
      }

      return works;
    },

    async searchSeriesIntegrals(seriesName: string, maxRecords = 20): Promise<GraphSeriesWork[]> {
      const safeSeries = seriesName.replace(/"/g, ' ').trim();
      if (!safeSeries) return [];

      const baseKey = extractFranchiseBaseName(safeSeries).normalizedKey;
      const cql = `bib.title all "${safeSeries} intégrale" and bib.doctype any "a"`;
      const records = await querySru(cql, maxRecords, `bnf:serint:${baseKey}:${maxRecords}`);

      // Regrouper les rééditions d'une même intégrale (même n° d'intégrale ou même plage de tomes inclus) en 1 Œuvre abstraite
      const grouped = new Map<string, GraphSeriesWork>();

      for (const rec of records) {
        if (isPressOrKioskOnlyRecord(rec)) continue;
        // Exclut les éditions étrangères explicites (ex. "Marco Polo il Milione. Prima edizione integrale..." en italien)
        const recLang = (rec.language ?? '').trim().toLowerCase();
        if (recLang && recLang !== 'fr' && recLang !== 'fre') continue;

        const fullText = [rec.ensembleSeriesName ?? '', rec.title, rec.subtitle ?? '', rec.description ?? ''].join(' ');
        const hasIntegralWord = rec.isIntegralHint || /\bint[ée]grale\b/i.test(fullText);
        if (!hasIntegralWord) continue;

        const ensBase = rec.ensembleSeriesName ? extractFranchiseBaseName(rec.ensembleSeriesName).normalizedKey : '';
        const isUltraShortSeries = baseKey.length <= 2;
        const isShortSingleWordSeries = baseKey.split(' ').length === 1 && baseKey.length <= 5;
        let belongsToSeries: boolean;
        if (Boolean(ensBase) && ensBase === baseKey) {
          belongsToSeries = true;
        } else if (isUltraShortSeries) {
          // Séries à 1-2 lettres (ex. "X" de CLAMP) : exiger égalité stricte du nom de série ou du titre
          // afin d'éviter toute contamination par des préfixes à tiret ("X-O Manowar", "X-Factor").
          const normTitle = normalizeTextKey(rec.title);
          const normSeries = normalizeTextKey(rec.ensembleSeriesName ?? '');
          const rawTitleHyphenPrefix = new RegExp(`^${baseKey}[-‐–—]`, 'i').test(rec.title.trim());
          belongsToSeries = !rawTitleHyphenPrefix && (normSeries === baseKey || normTitle === baseKey);
        } else if (isShortSingleWordSeries) {
          // Pour les séries d'un seul mot court (ex. "Polo"), exiger que la série ou le titre DÉMARRE par ce mot
          // afin d'éviter les faux positifs partiels ("Marco Polo il Milione").
          const normTitle = normalizeTextKey(rec.title);
          const normSeries = normalizeTextKey(rec.ensembleSeriesName ?? '');
          belongsToSeries =
            normSeries === baseKey ||
            normSeries.startsWith(`${baseKey} `) ||
            normTitle === baseKey ||
            normTitle.startsWith(`${baseKey} `);
        } else {
          belongsToSeries =
            tokenOverlapRatio(safeSeries, `${rec.ensembleSeriesName ?? ''} ${rec.title} ${rec.subtitle ?? ''}`) >= 0.7;
        }
        if (!belongsToSeries) continue;

        const titleVols = parseIncludedVolumeNumbers([rec.title, rec.subtitle ?? ''].join(' '));
        const notesVols = extractIncludedVolumesFromEditorialText(
          [rec.integralNotes ?? '', rec.description ?? ''].filter(Boolean).join(' ; ')
        );
        const parsedVols = notesVols.length > titleVols.length ? notesVols : titleVols;
        // Numéro d'intégrale (ex. "Intégrale 1", "Tome 2")
        const rawVol = rec.ensembleVolumeNumber;
        const volFromTitle = fullText.match(/\bint[ée]grale\s*(?:t\.?|tome|vol\.?|volume|n°|#)?\s*(\d{1,2})\b/i)?.[1];
        const volStr = rawVol && /^\d+$/.test(rawVol) ? rawVol : volFromTitle ?? null;
        const volNum = volStr ? parseInt(volStr, 10) : null;

        const dedupKey =
          parsedVols.length >= 2
            ? `range:${parsedVols.join(',')}`
            : volNum !== null
              ? `num:${volNum}`
              : `title:${normalizeTextKey(rec.title)}`;

        const existing = grouped.get(dedupKey);
        if (!existing) {
          grouped.set(dedupKey, {
            title: rec.title,
            volumeNumber: volNum,
            volumeLabel: volNum ? `Int. ${volNum}` : 'Intégrale',
            sortOrder: volNum ? 10000 + volNum : 10999,
            bnfEnsembleId: rec.bnfEnsembleId ?? null,
            authors: rec.authors,
            scriptwriters: rec.scriptwriters,
            illustrators: rec.illustrators,
            isbn13s: rec.isbn13 ? [rec.isbn13] : [],
            editionRecords: rec.isbn13
              ? [
                  {
                    isbn13: rec.isbn13,
                    publisher: rec.publisher ?? null,
                    collectionName: rec.collectionName ?? null,
                    publishYear: rec.publishYear ?? null,
                    pageCount: rec.pageCount ?? null,
                    coverUrl: rec.bnfCoverUrl ?? null,
                    source: 'bnf'
                  }
                ]
              : [],
            publisher: rec.publisher ?? null,
            collectionName: rec.collectionName ?? null,
            publishYear: rec.publishYear ?? null,
            pageCount: rec.pageCount ?? null,
            language: rec.language ?? null,
            originalLanguage: rec.originalLanguage ?? null,
            deweyCode: rec.deweyCode ?? null,
            rawSubjects: rec.rawSubjects,
            coverUrl: rec.bnfCoverUrl ?? null,
            isHorsSerie: false,
            isIntegral: true,
            includedVolumes: parsedVols.length >= 2 ? parsedVols : [],
            contentKind: rec.contentKind,
            source: 'bnf'
          });
        } else {
          if (rec.isbn13 && !existing.isbn13s.includes(rec.isbn13)) existing.isbn13s.push(rec.isbn13);
          if (rec.isbn13) {
            existing.editionRecords ??= [];
            if (!existing.editionRecords.some((er) => er.isbn13 === rec.isbn13)) {
              existing.editionRecords.push({
                isbn13: rec.isbn13,
                publisher: rec.publisher ?? null,
                collectionName: rec.collectionName ?? null,
                publishYear: rec.publishYear ?? null,
                pageCount: rec.pageCount ?? null,
                coverUrl: rec.bnfCoverUrl ?? null,
                source: 'bnf'
              });
            }
          }
          if (!existing.coverUrl && rec.bnfCoverUrl) existing.coverUrl = rec.bnfCoverUrl;
          if ((!existing.includedVolumes || existing.includedVolumes.length === 0) && parsedVols.length >= 2) {
            existing.includedVolumes = parsedVols;
          }
        }
      }

      return Array.from(grouped.values()).slice(0, 15);
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
      const lastName = extractAuthorLastNameForQuery(author);
      if (!safeTitle && !lastName) return [];

      let cql: string;
      if (safeTitle && lastName) {
        cql = `bib.title all "${safeTitle}" and bib.author all "${lastName}" and bib.doctype any "a"`;
      } else if (safeTitle) {
        cql = `bib.title all "${safeTitle}" and bib.doctype any "a"`;
      } else {
        cql = `bib.author all "${lastName}" and bib.doctype any "a"`;
      }
      const records = await querySru(cql, maxRecords, `bnf:search:${cql.toLowerCase()}:${maxRecords}`);
      return records.filter((r) => !isPressOrKioskOnlyRecord(r)).map((r) => toCandidate(r, r.isbn13));
    },

    async searchAnywhere(query: string, maxRecords = 12): Promise<SourceCandidateRecord[]> {
      const safeQuery = query.replace(/"/g, ' ').trim();
      if (!safeQuery) return [];
      const cql = `bib.anywhere all "${safeQuery}" and bib.doctype any "a"`;
      const records = await querySru(cql, maxRecords, `bnf:anywhere:${safeQuery.toLowerCase()}:${maxRecords}`);
      return records.filter((r) => !isPressOrKioskOnlyRecord(r)).map((r) => toCandidate(r, r.isbn13));
    }
  };
}
