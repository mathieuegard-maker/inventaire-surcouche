// src/server/connectors/sudoc.connector.ts
// Connecteur SUDOC (ABES) : isbn2ppn + notice XML UNIMARC (en-tête 100$a automatiquement rejeté par parseMarcRecord).

import { parseMarcRecord } from '../../shared/bibliographic/intermarc-parser';
import type { HttpClient } from './http-client';
import type { SourceCandidateRecord, SudocConnector } from './types';

interface Isbn2PpnResponse {
  sudoc?: {
    query?: {
      result?:
        | { ppn?: string }
        | Array<{ ppn?: string }>;
    };
  };
}

function extractFirstPpn(data: Isbn2PpnResponse | null): string | null {
  const result = data?.sudoc?.query?.result;
  if (!result) return null;
  if (Array.isArray(result)) {
    return result.find((r) => r.ppn)?.ppn ?? null;
  }
  return result.ppn ?? null;
}

export function createSudocConnector(http: HttpClient): SudocConnector {
  return {
    async lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null> {
      const ppnJson = await http.fetchJson<Isbn2PpnResponse>({
        source: 'sudoc',
        url: `https://www.sudoc.fr/services/isbn2ppn/${encodeURIComponent(isbn13)}&format=text/json`,
        timeoutMs: 6500,
        cacheKey: `sudoc:isbn2ppn:${isbn13}`,
        cacheTtlSec: 60 * 60 * 24 * 14
      });

      const ppn = extractFirstPpn(ppnJson);
      if (!ppn) return null;

      const xml = await http.fetchText({
        source: 'sudoc',
        url: `https://www.sudoc.fr/${encodeURIComponent(ppn)}.xml`,
        timeoutMs: 6500,
        cacheKey: `sudoc:ppn:${ppn}`,
        cacheTtlSec: 60 * 60 * 24 * 14
      });
      if (!xml) return null;

      const parsed = parseMarcRecord(xml, isbn13);
      if (!parsed || parsed.isNonBook) return null;

      const hasEnsemble = Boolean(parsed.ensembleSeriesName);
      return {
        source: 'sudoc',
        isbn13: parsed.isbn13 || isbn13,
        title: parsed.title,
        subtitle: parsed.subtitle,
        seriesName: parsed.ensembleSeriesName ?? parsed.collectionName,
        seriesLinkKind: hasEnsemble
          ? 'marc_ensemble_460'
          : parsed.collectionName
            ? 'marc_collection_225'
            : undefined,
        volumeNumber: parsed.ensembleVolumeNumber ?? parsed.collectionNumber,
        hasStructuredEnsembleVolume: parsed.hasStructuredEnsembleVolume,
        collectionName: parsed.collectionName,
        collectionNumber: parsed.collectionNumber,
        authors: parsed.authors,
        scriptwriters: parsed.scriptwriters,
        illustrators: parsed.illustrators,
        colorists: parsed.colorists,
        publisher: parsed.publisher,
        publishYear: parsed.publishYear,
        pageCount: parsed.pageCount,
        description: parsed.description,
        language: parsed.language,
        originalLanguage: parsed.originalLanguage,
        deweyCode: parsed.deweyCode,
        rawSubjects: parsed.rawSubjects,
        sudocPpn: ppn,
        isNonBook: parsed.isNonBook,
        isIntegralHint: parsed.isIntegralHint,
        integralNotes: parsed.integralNotes,
        contentKind: parsed.contentKind
      };
    }
  };
}
