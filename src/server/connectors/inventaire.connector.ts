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

function isFrenchEdition(entity: InvEntity, isbn13s: string[]): boolean {
  const langs = claimStrings(entity, 'wdt:P407');
  if (langs.some((l) => l.toLowerCase() === 'wd:q150')) return true;
  if (isbn13s.some((isbn) => isbn.startsWith('9782') || isbn.startsWith('97910'))) return true;
  return false;
}

function extractEditionIsbn13s(entity: InvEntity): string[] {
  const out: string[] = [];
  for (const raw of [...claimStrings(entity, 'wdt:P212'), ...claimStrings(entity, 'wdt:P957')]) {
    const norm = isbnUtil.normalizeToIsbn13(raw);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

export function createInventaireConnector(http: HttpClient): InventaireConnector {
  async function fetchEntitiesRaw(
    uris: string[],
    includeRelatives = true
  ): Promise<{ entities: Record<string, InvEntity>; redirects: Record<string, string> }> {
    const clean = Array.from(new Set(uris.filter(Boolean)));
    if (clean.length === 0) return { entities: {}, redirects: {} };

    const entities: Record<string, InvEntity> = {};
    const redirects: Record<string, string> = {};
    const relParam = includeRelatives ? `&relatives=${encodeURIComponent('wdt:P629|wdt:P179|wdt:P50|wdt:P123')}` : '';
    const cachePrefix = includeRelatives ? 'inv:uris:v2' : 'inv:ed:v1';

    // Lots de 30 URIs max pour respecter l'API Inventaire
    for (let i = 0; i < clean.length; i += 30) {
      const slice = clean.slice(i, i + 30);
      const url = `${INV_API}?action=by-uris&uris=${encodeURIComponent(slice.join('|'))}${relParam}`;
      const data = await http.fetchJson<InvByUrisResponse>({
        source: 'inventaire',
        url,
        timeoutMs: 7500,
        minIntervalMs: 150,
        cacheKey: `${cachePrefix}:${slice.sort().join('|')}`,
        cacheTtlSec: 60 * 60 * 24 * 7
      });
      if (data?.entities) Object.assign(entities, data.entities);
      if (data?.redirects) Object.assign(redirects, data.redirects);
    }
    return { entities, redirects };
  }

  /**
   * Résout en lot les éditions FR (ISBN-13 `wdt:P212` + couverture éditeur `invp:P2`) pour une liste d'œuvres
   * via `reverse-claims wdt:P629` -> `by-uris` (Inventaire renvoie des URIs canoniques `inv:` / `wd:`, pas `isbn:`).
   */
  async function resolveEditionsForWorks(
    workUris: string[],
    maxEditionsPerWork = 10
  ): Promise<Map<string, { isbn13s: string[]; coverUrl: string | null; coverUrls: string[]; frTitle: string | null }>> {
    const rawEdUrisByWork = new Map<string, string[]>();
    const editionUrisToFetch: string[] = [];

    // Récupération des reverse-claims par petits lots de 3 en parallèle (moins de pression burst sur Inventaire.io)
    for (let i = 0; i < workUris.length; i += 3) {
      const batch = workUris.slice(i, i + 3);
      await Promise.all(
        batch.map(async (workUri) => {
          const edRev = await http.fetchJson<InvReverseClaimsResponse>({
            source: 'inventaire',
            url: `${INV_API}?action=reverse-claims&property=wdt:P629&value=${encodeURIComponent(workUri)}`,
            timeoutMs: 8000,
            minIntervalMs: 80,
            cacheKey: `inv:work-editions:${workUri}`,
            cacheTtlSec: 60 * 60 * 24 * 7
          });
          const uris = (edRev?.uris ?? []).slice(0, maxEditionsPerWork);
          rawEdUrisByWork.set(workUri, uris);
          for (const u of uris) {
            if (!u.startsWith('isbn:')) editionUrisToFetch.push(u);
          }
        })
      );
    }

    const { entities: edEntities, redirects: edRedirects } =
      editionUrisToFetch.length > 0 ? await fetchEntitiesRaw(editionUrisToFetch, false) : { entities: {}, redirects: {} };

    const result = new Map<
      string,
      { isbn13s: string[]; coverUrl: string | null; coverUrls: string[]; frTitle: string | null }
    >();

    for (const workUri of workUris) {
      const uris = rawEdUrisByWork.get(workUri) ?? [];
      const frEntries: Array<{ isbns: string[]; cover: string | null; title: string | null }> = [];
      const otherEntries: Array<{ isbns: string[]; cover: string | null; title: string | null }> = [];

      for (const u of uris) {
        if (u.startsWith('isbn:')) {
          const norm = isbnUtil.normalizeToIsbn13(u.slice(5));
          if (norm) {
            const bucket = norm.startsWith('9782') || norm.startsWith('97910') ? frEntries : otherEntries;
            bucket.push({ isbns: [norm], cover: null, title: null });
          }
          continue;
        }
        const resolvedUri = edRedirects[u] ?? u;
        const ed = edEntities[u] ?? edEntities[resolvedUri];
        if (!ed) continue;

        // Ignorer les éditions omnibus / intégrales couvrant plusieurs œuvres (ex. "Astérix le Gaulois - La Serpe d'or")
        if (claimStrings(ed, 'wdt:P629').length > 1) continue;

        const isbns = extractEditionIsbn13s(ed);
        const rawCov = resolveInvImageUrl(ed) ?? null;
        const cover = rawCov && !/\.svg(?:[?#]|$)/i.test(rawCov) && !/wikimedia\.org/i.test(rawCov) ? rawCov : null;
        const title = cleanTitle(firstClaimString(ed, 'wdt:P1476') || '') || null;

        if (isFrenchEdition(ed, isbns)) {
          frEntries.push({ isbns, cover, title });
        } else {
          otherEntries.push({ isbns, cover, title });
        }
      }

      const preferred = frEntries.length > 0 ? frEntries : otherEntries;
      // Placer d'abord les éditions ayant une couverture éditeur
      preferred.sort((a, b) => (b.cover ? 1 : 0) - (a.cover ? 1 : 0));

      const isbn13s: string[] = [];
      const coverUrls: string[] = [];
      let frTitle: string | null = null;

      for (const entry of preferred) {
        for (const isbn of entry.isbns) {
          if (!isbn13s.includes(isbn)) isbn13s.push(isbn);
        }
        if (entry.cover && !coverUrls.includes(entry.cover)) coverUrls.push(entry.cover);
        if (!frTitle && frEntries.length > 0 && entry.title) frTitle = entry.title;
      }
      // Ajouter aussi les couvertures d'autres éditions si besoin (pour la galerie "Rechercher d'autres couvertures")
      if (frEntries.length > 0) {
        for (const entry of otherEntries) {
          if (entry.cover && !coverUrls.includes(entry.cover)) coverUrls.push(entry.cover);
        }
      }

      result.set(workUri, { isbn13s, coverUrl: coverUrls[0] ?? null, coverUrls, frTitle });
    }

    return result;
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

      const targetWorkUris = workUris.slice(0, Math.min(limit, 5));
      const [{ entities }, editionsByWork] = await Promise.all([
        fetchEntitiesRaw(targetWorkUris),
        resolveEditionsForWorks(targetWorkUris, 4)
      ]);
      const out: SourceCandidateRecord[] = [];

      for (const workUri of targetWorkUris) {
        const work = entities[workUri];
        if (!work) continue;
        const resolvedEd = editionsByWork.get(workUri);
        const isbn13 = resolvedEd?.isbn13s[0] ?? null;
        if (!isbn13) continue;

        const title = cleanTitle(work.labels?.fr || resolvedEd?.frTitle || pickLabel(work.labels));
        if (!title) continue;

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
          coverUrl: resolvedEd?.coverUrl ?? resolveInvImageUrl(work)
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

      const [{ entities }, editionsByWork] = await Promise.all([
        fetchEntitiesRaw(workUris),
        resolveEditionsForWorks(workUris, 10)
      ]);
      const works: GraphSeriesWork[] = [];

      for (const workUri of workUris) {
        const work = entities[workUri];
        if (!work) continue;
        const resolvedEd = editionsByWork.get(workUri);
        const wikidataQid = extractWikidataQid(workUri) ?? null;
        const volStr = normalizeSeriesNumber(firstClaimString(work, 'wdt:P1545'));
        const volNum = /^\d+$/.test(volStr) ? parseInt(volStr, 10) : null;
        const hasFrenchIsbn = (resolvedEd?.isbn13s ?? []).some(
          (isbn) => isbn.startsWith('9782') || isbn.startsWith('97910')
        );
        const hasFrenchMetadata = Boolean(work.labels?.fr || resolvedEd?.frTitle || hasFrenchIsbn);

        // Filtrer les fiches locales Inventaire (`inv:...`, sans Q-ID Wikidata) non numérotées et dépourvues
        // de toute donnée francophone (évite "Asterix in French", "Asterix und der Kampf um's Kanzleramt" en hors-série)
        if (!wikidataQid && volNum === null && !hasFrenchMetadata) {
          continue;
        }

        const title = cleanTitle(work.labels?.fr || resolvedEd?.frTitle || pickLabel(work.labels));
        if (!title) continue;

        const authorNames = claimStrings(work, 'wdt:P50')
          .map((u) => pickLabel(entities[u]?.labels))
          .filter(Boolean);

        const rawWorkCover = resolveInvImageUrl(work) ?? null;
        const safeWorkCover =
          rawWorkCover && !/\.svg(?:[?#]|$)/i.test(rawWorkCover) && !/wikimedia\.org/i.test(rawWorkCover)
            ? rawWorkCover
            : null;

        works.push({
          title,
          volumeNumber: volNum,
          volumeLabel: volStr || null,
          sortOrder: volNum,
          wikidataQid,
          inventaireUri: workUri,
          authors: authorNames,
          isbn13s: resolvedEd?.isbn13s ?? [],
          publishYear: cleanPublishDate(firstClaimString(work, 'wdt:P577') || '') || null,
          coverUrl: resolvedEd?.coverUrl ?? safeWorkCover,
          source: 'inventaire'
        });
      }

      return works;
    },

    async fetchWorkEditions(workUri: string): Promise<{ isbn13s: string[]; coverUrls: string[] }> {
      if (!workUri) return { isbn13s: [], coverUrls: [] };
      const map = await resolveEditionsForWorks([workUri], 15);
      const entry = map.get(workUri);
      return {
        isbn13s: entry?.isbn13s ?? [],
        coverUrls: entry?.coverUrls ?? []
      };
    }
  };
}
