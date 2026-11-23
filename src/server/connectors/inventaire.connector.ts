// src/server/connectors/inventaire.connector.ts
// Connecteur Inventaire.io : graphe Édition (isbn:) -> Œuvre (P629) -> Série (P179) et reverse-claims.

import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { cleanPublishDate, cleanSeriesName, cleanTitle, normalizeSeriesNumber } from '../../shared/bibliographic/text-normalize.util';
import type { HttpClient } from './http-client';
import type { GraphSeriesWork, InventaireConnector, SourceCandidateRecord } from './types';

const INV_API = 'https://inventaire.io/api/entities';

interface InvEntity {
  uri?: string;
  labels?: Record<string, string>;
  claims?: Record<string, Array<string | number>>;
  image?: { url?: string };
}

interface InvByUrisResponse {
  entities?: Record<string, InvEntity>;
}

interface InvReverseClaimsResponse {
  uris?: string[];
}

function pickLabel(labels?: Record<string, string>): string {
  if (!labels) return '';
  return labels.fr || labels.en || Object.values(labels)[0] || '';
}

function firstClaimString(entity: InvEntity | undefined, prop: string): string | undefined {
  const arr = entity?.claims?.[prop];
  if (!arr || arr.length === 0) return undefined;
  return String(arr[0]);
}

function claimStrings(entity: InvEntity | undefined, prop: string): string[] {
  const arr = entity?.claims?.[prop];
  if (!arr) return [];
  return arr.map((v) => String(v)).filter(Boolean);
}

function extractWikidataQid(uri?: string): string | undefined {
  if (!uri) return undefined;
  const match = uri.match(/^wd:(Q\d+)$/i);
  return match ? match[1].toUpperCase() : undefined;
}

function resolveInvImageUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `https://inventaire.io${url}`;
  return undefined;
}

export function createInventaireConnector(http: HttpClient): InventaireConnector {
  async function fetchEntities(uris: string[]): Promise<Record<string, InvEntity>> {
    const clean = Array.from(new Set(uris.filter(Boolean)));
    if (clean.length === 0) return {};

    const out: Record<string, InvEntity> = {};
    // Lots de 30 URIs max pour respecter l'API Inventaire
    for (let i = 0; i < clean.length; i += 30) {
      const slice = clean.slice(i, i + 30);
      const url = `${INV_API}?action=by-uris&uris=${encodeURIComponent(slice.join('|'))}&relatives=wdt:P629,wdt:P179,wdt:P50,wdt:P123`;
      const data = await http.fetchJson<InvByUrisResponse>({
        source: 'inventaire',
        url,
        timeoutMs: 7000,
        minIntervalMs: 150,
        cacheKey: `inv:uris:${slice.sort().join('|')}`,
        cacheTtlSec: 60 * 60 * 24 * 7
      });
      if (data?.entities) {
        Object.assign(out, data.entities);
      }
    }
    return out;
  }

  return {
    async lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null> {
      const editionUri = `isbn:${isbn13}`;
      const entities = await fetchEntities([editionUri]);
      const edition = entities[editionUri] ?? Object.values(entities).find((e) => e.uri === editionUri);
      if (!edition) return null;

      const workUri = firstClaimString(edition, 'wdt:P629');
      const work = workUri ? entities[workUri] : undefined;
      const seriesUri = firstClaimString(work, 'wdt:P179');
      const series = seriesUri ? entities[seriesUri] : undefined;

      const authorUris = claimStrings(work ?? edition, 'wdt:P50');
      const authors = authorUris
        .map((u) => pickLabel(entities[u]?.labels))
        .filter(Boolean);

      const publisherUri = firstClaimString(edition, 'wdt:P123');
      const publisher = publisherUri ? pickLabel(entities[publisherUri]?.labels) || undefined : undefined;

      const title = cleanTitle(
        firstClaimString(edition, 'wdt:P1476') ||
          pickLabel(work?.labels) ||
          pickLabel(edition.labels)
      );
      if (!title) return null;

      const seriesName = series ? cleanSeriesName(pickLabel(series.labels)) : undefined;
      const volumeNumber = normalizeSeriesNumber(firstClaimString(work, 'wdt:P1545'));
      const rawPages = firstClaimString(edition, 'wdt:P1104');
      const pageCount = rawPages && /^\d+$/.test(rawPages) ? parseInt(rawPages, 10) : undefined;
      const publishYear = cleanPublishDate(firstClaimString(edition, 'wdt:P577') || '');

      return {
        source: 'inventaire',
        isbn13,
        title,
        seriesName: seriesName || undefined,
        seriesLinkKind: seriesName ? 'graph_p179' : undefined,
        volumeNumber: volumeNumber || undefined,
        wikidataSeriesQid: extractWikidataQid(seriesUri),
        inventaireSeriesUri: seriesUri,
        authors,
        scriptwriters: [],
        illustrators: [],
        publisher,
        publishYear: publishYear || undefined,
        pageCount,
        rawSubjects: [],
        wikidataWorkQid: extractWikidataQid(workUri),
        inventaireWorkUri: workUri,
        coverUrl: resolveInvImageUrl(edition.image?.url ?? work?.image?.url)
      };
    },

    async fetchSeriesWorks(seriesUri: string): Promise<GraphSeriesWork[]> {
      if (!seriesUri) return [];
      const revUrl = `${INV_API}?action=reverse-claims&property=wdt:P179&value=${encodeURIComponent(seriesUri)}`;
      const rev = await http.fetchJson<InvReverseClaimsResponse>({
        source: 'inventaire',
        url: revUrl,
        timeoutMs: 8000,
        minIntervalMs: 150,
        cacheKey: `inv:series-works:${seriesUri}`,
        cacheTtlSec: 60 * 60 * 24 * 3
      });

      const workUris = (rev?.uris ?? []).slice(0, 120);
      if (workUris.length === 0) return [];

      const entities = await fetchEntities(workUris);
      const works: GraphSeriesWork[] = [];

      for (const workUri of workUris) {
        const work = entities[workUri];
        if (!work) continue;
        const title = cleanTitle(pickLabel(work.labels));
        if (!title) continue;

        const volStr = normalizeSeriesNumber(firstClaimString(work, 'wdt:P1545'));
        const volNum = /^\d+$/.test(volStr) ? parseInt(volStr, 10) : null;
        const authorNames = claimStrings(work, 'wdt:P50')
          .map((u) => pickLabel(entities[u]?.labels))
          .filter(Boolean);

        // Récupère les ISBN FR éventuels via reverse-claims wdt:P629 (limitée aux 1ers résultats)
        const edRev = await http.fetchJson<InvReverseClaimsResponse>({
          source: 'inventaire',
          url: `${INV_API}?action=reverse-claims&property=wdt:P629&value=${encodeURIComponent(workUri)}`,
          timeoutMs: 5000,
          minIntervalMs: 120,
          cacheKey: `inv:work-editions:${workUri}`,
          cacheTtlSec: 60 * 60 * 24 * 7
        });

        const isbn13s: string[] = [];
        for (const u of edRev?.uris ?? []) {
          if (u.startsWith('isbn:')) {
            const norm = isbnUtil.normalizeToIsbn13(u.slice(5));
            if (norm && !isbn13s.includes(norm)) isbn13s.push(norm);
          }
        }

        works.push({
          title,
          volumeNumber: volNum,
          volumeLabel: volStr || null,
          sortOrder: volNum,
          wikidataQid: extractWikidataQid(workUri) ?? null,
          inventaireUri: workUri,
          authors: authorNames,
          isbn13s,
          publishYear: cleanPublishDate(firstClaimString(work, 'wdt:P577') || '') || null,
          coverUrl: resolveInvImageUrl(work.image?.url) ?? null,
          source: 'inventaire'
        });
      }

      return works;
    }
  };
}
