// src/server/connectors/inventaire.connector.ts
// Connecteur Inventaire.io : graphe Édition (isbn: -> inv:...) -> Œuvre (P629) -> Série (P179), couvertures (invp:P2) & recherche textuelle.

import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { cleanPublishDate, cleanSeriesName, cleanTitle, normalizeSeriesNumber, normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type { HttpClient } from './http-client';
import type { GraphSeriesWork, InventaireConnector, SourceCandidateRecord } from './types';

const INV_API = 'https://inventaire.io/api/entities';
const INV_SEARCH_API = 'https://inventaire.io/api/search';

interface InvEntity {
  uri?: string;
  type?: string;
  labels?: Record<string, string>;
  claims?: Record<string, Array<string | number>>;
  image?: { url?: string };
}

interface InvByUrisResponse {
  entities?: Record<string, InvEntity>;
  redirects?: Record<string, string>;
}

interface InvReverseClaimsResponse {
  uris?: string[];
}

interface InvSearchResponse {
  results?: Array<{
    uri?: string;
    type?: string;
    label?: string;
    description?: string;
    image?: string;
  }>;
}

function pickLabel(labels?: Record<string, string>): string {
  if (!labels) return '';
  return labels.fr || labels.en || labels.fromclaims || Object.values(labels)[0] || '';
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

function resolveInvImageUrl(entity?: InvEntity): string | undefined {
  const rawUrl = entity?.image?.url;
  if (rawUrl) {
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) return rawUrl;
    if (rawUrl.startsWith('/')) return `https://inventaire.io${rawUrl}`;
  }
  // Inventaire stocke le hash image dans `invp:P2` -> https://inventaire.io/img/entities/<hash>
  const hash = firstClaimString(entity, 'invp:P2');
  if (hash && /^[a-f0-9]{16,64}$/i.test(hash)) {
    return `https://inventaire.io/img/entities/${hash}`;
  }
  return undefined;
}

function entityMatchesIsbn13(entity: InvEntity, isbn13: string): boolean {
  const p212 = claimStrings(entity, 'wdt:P212');
  for (const raw of p212) {
    if (isbnUtil.normalizeToIsbn13(raw) === isbn13) return true;
  }
  return false;
}

export function createInventaireConnector(http: HttpClient): InventaireConnector {
  async function fetchEntitiesRaw(uris: string[]): Promise<{ entities: Record<string, InvEntity>; redirects: Record<string, string> }> {
    const clean = Array.from(new Set(uris.filter(Boolean)));
    if (clean.length === 0) return { entities: {}, redirects: {} };

    const entities: Record<string, InvEntity> = {};
    const redirects: Record<string, string> = {};

    // Lots de 30 URIs max pour respecter l'API Inventaire
    for (let i = 0; i < clean.length; i += 30) {
      const slice = clean.slice(i, i + 30);
      const url = `${INV_API}?action=by-uris&uris=${encodeURIComponent(slice.join('|'))}&relatives=wdt:P629,wdt:P179,wdt:P50,wdt:P123`;
      const data = await http.fetchJson<InvByUrisResponse>({
        source: 'inventaire',
        url,
        timeoutMs: 7500,
        minIntervalMs: 150,
        cacheKey: `inv:uris:v2:${slice.sort().join('|')}`,
        cacheTtlSec: 60 * 60 * 24 * 7
      });
      if (data?.entities) Object.assign(entities, data.entities);
      if (data?.redirects) Object.assign(redirects, data.redirects);
    }
    return { entities, redirects };
  }

  return {
    async lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null> {
      const editionUri = `isbn:${isbn13}`;
      const { entities, redirects } = await fetchEntitiesRaw([editionUri]);
      const redirected = redirects[editionUri];
      const edition =
        entities[editionUri] ??
        (redirected ? entities[redirected] : undefined) ??
        Object.values(entities).find((e) => e.uri === editionUri || entityMatchesIsbn13(e, isbn13)) ??
        Object.values(entities).find((e) => e.type === 'edition');
      if (!edition) return null;

      const workUri = firstClaimString(edition, 'wdt:P629');
      let work = workUri ? entities[workUri] : undefined;

      // Si l'œuvre ou ses relations (P179 série, P50 auteurs) ne sont pas encore dans le lot, les récupérer
      if (workUri && !work) {
        const extra = await fetchEntitiesRaw([workUri]);
        Object.assign(entities, extra.entities);
        work = entities[workUri] ?? (extra.redirects[workUri] ? entities[extra.redirects[workUri]] : undefined);
      }

      const seriesUri = firstClaimString(work, 'wdt:P179');
      const authorUris = claimStrings(work ?? edition, 'wdt:P50');
      const publisherUri = firstClaimString(edition, 'wdt:P123');

      const missingRelatives = [seriesUri, publisherUri, ...authorUris].filter(
        (u): u is string => Boolean(u && !entities[u])
      );
      if (missingRelatives.length > 0) {
        const rel = await fetchEntitiesRaw(missingRelatives);
        Object.assign(entities, rel.entities);
      }

      const series = seriesUri ? entities[seriesUri] : undefined;
      const authors = authorUris.map((u) => pickLabel(entities[u]?.labels)).filter(Boolean);
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
        coverUrl: resolveInvImageUrl(edition) ?? resolveInvImageUrl(work)
      };
    },

    async searchSeriesUri(seriesName: string): Promise<{ seriesUri: string; wikidataQid: string | null } | null> {
      const q = seriesName.trim();
      if (!q) return null;
      const url = `${INV_SEARCH_API}?types=series&lang=fr&limit=5&search=${encodeURIComponent(q)}`;
      const data = await http.fetchJson<InvSearchResponse>({
        source: 'inventaire',
        url,
        timeoutMs: 6500,
        minIntervalMs: 150,
        cacheKey: `inv:search:series:${normalizeTextKey(q)}`,
        cacheTtlSec: 60 * 60 * 24 * 3
      });

      const normTarget = normalizeTextKey(q);
      const results = data?.results ?? [];
      const best =
        results.find((r) => r.uri && normalizeTextKey(r.label ?? '') === normTarget) ??
        results.find((r) => r.uri && normalizeTextKey(r.label ?? '').includes(normTarget));

      if (!best?.uri) return null;
      return {
        seriesUri: best.uri,
        wikidataQid: extractWikidataQid(best.uri) ?? null
      };
    },

    async searchByText(query: string, limit = 12): Promise<SourceCandidateRecord[]> {
      const q = query.trim();
      if (!q) return [];
      const url = `${INV_SEARCH_API}?types=works&lang=fr&limit=${Math.min(20, limit)}&search=${encodeURIComponent(q)}`;
      const data = await http.fetchJson<InvSearchResponse>({
        source: 'inventaire',
        url,
        timeoutMs: 6500,
        minIntervalMs: 150,
        cacheKey: `inv:search:works:${normalizeTextKey(q)}:${limit}`,
        cacheTtlSec: 60 * 60 * 12
      });

      const workUris = (data?.results ?? [])
        .map((r) => r.uri)
        .filter((u): u is string => Boolean(u))
        .slice(0, limit);
      if (workUris.length === 0) return [];

      const { entities } = await fetchEntitiesRaw(workUris);
      const out: SourceCandidateRecord[] = [];

      for (const workUri of workUris.slice(0, 8)) {
        const work = entities[workUri];
        if (!work) continue;
        const title = cleanTitle(pickLabel(work.labels));
        if (!title) continue;

        const edRev = await http.fetchJson<InvReverseClaimsResponse>({
          source: 'inventaire',
          url: `${INV_API}?action=reverse-claims&property=wdt:P629&value=${encodeURIComponent(workUri)}`,
          timeoutMs: 4500,
          minIntervalMs: 100,
          cacheKey: `inv:work-editions:${workUri}`,
          cacheTtlSec: 60 * 60 * 24 * 7
        });

        const firstIsbnUri = (edRev?.uris ?? []).find((u) => u.startsWith('isbn:'));
        const isbn13 = firstIsbnUri ? isbnUtil.normalizeToIsbn13(firstIsbnUri.slice(5)) : null;
        if (!isbn13) continue;

        const seriesUri = firstClaimString(work, 'wdt:P179');
        const seriesName = seriesUri ? cleanSeriesName(pickLabel(entities[seriesUri]?.labels)) : undefined;
        const authors = claimStrings(work, 'wdt:P50')
          .map((u) => pickLabel(entities[u]?.labels))
          .filter(Boolean);

        out.push({
          source: 'inventaire',
          isbn13,
          title,
          seriesName: seriesName || undefined,
          volumeNumber: normalizeSeriesNumber(firstClaimString(work, 'wdt:P1545')) || undefined,
          authors,
          scriptwriters: [],
          illustrators: [],
          publishYear: cleanPublishDate(firstClaimString(work, 'wdt:P577') || '') || undefined,
          rawSubjects: [],
          wikidataWorkQid: extractWikidataQid(workUri),
          inventaireWorkUri: workUri,
          coverUrl: resolveInvImageUrl(work)
        });
      }

      return out;
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

      const { entities } = await fetchEntitiesRaw(workUris);
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

        // Récupère les ISBN FR éventuels via reverse-claims wdt:P629
        const edRev = await http.fetchJson<InvReverseClaimsResponse>({
          source: 'inventaire',
          url: `${INV_API}?action=reverse-claims&property=wdt:P629&value=${encodeURIComponent(workUri)}`,
          timeoutMs: 5000,
          minIntervalMs: 100,
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
          coverUrl: resolveInvImageUrl(work) ?? null,
          source: 'inventaire'
        });
      }

      return works;
    }
  };
}
