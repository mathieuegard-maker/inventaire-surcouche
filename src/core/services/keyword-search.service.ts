// src/core/services/keyword-search.service.ts
// Recherche par mots-clés multi-sources (BnF, Google Books, Open Library, D1/Inventaire & cache local)
// avec fusion par ISBN-13, classification multi-genres et tri structuré par sous-catégorie, série, tome, œuvre unique et auteur.

import { databaseService } from '../database/database.service';
import { inventaireSearchProvider, type SearchResultItem } from '../providers/inventaire-search.provider';
import { bnfResolver, cleanSeriesName, normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';
import { buildCombinedGenres, classifyBookMetadata } from '../utils/category-classifier.util';
import { imageUtil } from '../utils/image.util';
import { isbnUtil } from '../utils/isbn.util';
import type { ExternalBookMetadata } from '../types';

export interface KeywordBookEntry {
  id: string;
  uri?: string;
  isbn13?: string;
  title: string;
  authors: string[];
  series?: string;
  seriesNumber?: string;
  publisher?: string;
  publishDate?: string;
  coverUrl?: string;
  coverFallbackUrls?: string[];
  category: string;
  genres: string[];
  sources: string[];
}

export interface KeywordSeriesGroup {
  key: string;
  name: string;
  uri?: string;
  category: string;
  genres: string[];
  authors: string[];
  volumes: KeywordBookEntry[];
}

export interface KeywordAuthorEntry {
  key: string;
  name: string;
  uri?: string;
  description?: string;
  matchCount: number;
}

export interface KeywordCategorySummary {
  label: string;
  count: number;
}

export interface GroupedKeywordSearchResult {
  categories: KeywordCategorySummary[];
  series: KeywordSeriesGroup[];
  volumes: KeywordBookEntry[];
  standaloneWorks: KeywordBookEntry[];
  authors: KeywordAuthorEntry[];
}

function normalizeIsbn13(raw?: string): string | undefined {
  if (!raw || !isbnUtil.isValidFormat(raw)) return undefined;
  const norm = isbnUtil.normalize(raw);
  if (!norm) return undefined;
  return norm.length === 10 ? isbnUtil.toIsbn13(norm) : norm;
}

function compareVolumeNumbers(a?: string, b?: string): number {
  const numA = a ? parseFloat(a) : NaN;
  const numB = b ? parseFloat(b) : NaN;
  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
  if (!isNaN(numA)) return -1;
  if (!isNaN(numB)) return 1;
  return (a || '').localeCompare(b || '');
}

function classifyEntry(meta: {
  title: string;
  series?: string;
  publisher?: string;
  collection?: string;
  deweyCode?: string;
  rawSubjects?: string[];
  existingGenres?: string[];
}): { category: string; genres: string[] } {
  const res = classifyBookMetadata({
    title: meta.title,
    series: meta.series,
    publisher: meta.publisher,
    collection: meta.collection,
    deweyCode: meta.deweyCode,
    rawSubjects: [...(meta.rawSubjects || []), ...(meta.existingGenres || [])]
  });
  const genres = buildCombinedGenres(res);
  return {
    category: res.mainCategory,
    genres: genres.length > 0 ? genres : [res.mainCategory]
  };
}

function seriesCanonicalKey(rawSeries: string): string {
  const clean = normalizeTextKey(cleanSeriesName(rawSeries))
    .replace(/^(les aventures de |les nouvelles aventures de |aventures de |les exploits de |les enquetes de |the adventures of )/i, '')
    .trim();
  return clean || normalizeTextKey(rawSeries);
}

function mergeEditionEntries(a: KeywordBookEntry, b: KeywordBookEntry): KeywordBookEntry {
  // Préfère l'édition la plus complète / la plus récente avec couverture
  const score = (e: KeywordBookEntry) => {
    let s = 0;
    if (e.isbn13?.startsWith('9782') || e.isbn13?.startsWith('97910')) s += 20;
    if (e.coverUrl) s += 15;
    if (e.sources.includes('Ma Biblio')) s += 30;
    if (e.sources.includes('BnF')) s += 10;
    if (e.seriesNumber) s += 8;
    const yr = e.publishDate ? parseInt(e.publishDate, 10) : 0;
    if (yr >= 1900 && yr <= 2035) s += (yr - 1900) * 0.2;
    return s;
  };
  const primary = score(a) >= score(b) ? a : b;
  const secondary = primary === a ? b : a;

  const sources = Array.from(new Set([...primary.sources, ...secondary.sources]));
  const genres = Array.from(new Set([...primary.genres, ...secondary.genres]));
  const coverFallbackUrls = imageUtil.buildCoverCandidates(primary.isbn13 || secondary.isbn13, [
    primary.coverUrl,
    ...(primary.coverFallbackUrls || []),
    secondary.coverUrl,
    ...(secondary.coverFallbackUrls || [])
  ]);

  return {
    ...primary,
    uri: primary.uri || secondary.uri,
    authors: primary.authors.length > 0 ? primary.authors : secondary.authors,
    publisher: primary.publisher || secondary.publisher,
    publishDate: primary.publishDate || secondary.publishDate,
    series: primary.series || secondary.series,
    seriesNumber: primary.seriesNumber || secondary.seriesNumber,
    coverUrl: primary.coverUrl || secondary.coverUrl || coverFallbackUrls[0],
    coverFallbackUrls,
    genres,
    sources
  };
}

export const keywordSearchService = {
  /**
   * Lance une recherche croisée complète en 2 passes (BnF + Google Books + Open Library + D1/Inventaire + cache local) :
   * Passe 1 : recherche large par mot-clé/titre/auteur ;
   * Passe 2 : expansion complète de toutes les séries détectées sur toute la triade (notices d'ensemble BnF, Google Books, Open Library)
   * puis structuration ordonnée : sous-catégories, séries, tomes dédoublonnés par numéro, œuvres uniques, auteurs.
   */
  async searchGrouped(query: string, isOffline = false): Promise<GroupedKeywordSearchResult> {
    const cleanQ = query.trim();
    if (!cleanQ) {
      return { categories: [], series: [], volumes: [], standaloneWorks: [], authors: [] };
    }

    const localBooks = await databaseService.searchBooksLocally(cleanQ).catch(() => []);

    // Passe 1B (V4) : Vérifier d'abord le catalogue D1 serveur (/api/v2/books/search-local) avant d'interroger les APIs externes
    let serverLocalHits: Array<{
      bookId: string;
      isbn13: string;
      title: string;
      seriesName?: string;
      volumeNumber?: number | null;
      authors: string[];
      coverUrl?: string;
      score: number;
    }> = [];
    if (!isOffline && typeof fetch === 'function') {
      try {
        const sRes = await fetch(`/api/v2/books/search-local?q=${encodeURIComponent(cleanQ)}&limit=20`).catch(() => null);
        if (sRes?.ok) {
          const sJson = (await sRes.json().catch(() => null)) as { hits?: typeof serverLocalHits } | null;
          if (Array.isArray(sJson?.hits)) serverLocalHits = sJson.hits;
        }
      } catch {
        // Non-bloquant : repli immédiat sur la triade externe
      }
    }

    const strongLocalCoverage =
      localBooks.length + serverLocalHits.length >= 6 &&
      serverLocalHits.filter((h) => h.score >= 60).length >= 5;

    let d1Items: SearchResultItem[] = [];
    let bnfCandidates: Array<ExternalBookMetadata & { _bnfEnsembleId?: string }> = [];
    let gbCandidates: ExternalBookMetadata[] = [];
    let olCandidates: ExternalBookMetadata[] = [];

    if (!isOffline && !strongLocalCoverage) {
      const [d1Res, bnfRes, gbRes, olRes] = await Promise.allSettled([
        inventaireSearchProvider.searchByKeywords(cleanQ),
        bnfResolver.searchKeywordVolumes(cleanQ, 50),
        googleBooksResolver.searchKeywordOrSeriesVolumes(cleanQ, undefined, 60),
        openLibraryResolver.searchCandidatesByHints({ title: cleanQ }, 30)
      ]);

      if (d1Res.status === 'fulfilled') d1Items = d1Res.value;
      if (bnfRes.status === 'fulfilled') bnfCandidates = bnfRes.value;
      if (gbRes.status === 'fulfilled') gbCandidates = gbRes.value;
      if (olRes.status === 'fulfilled') olCandidates = olRes.value;
    }

    // Collecter les séries candidates & IDs d'ensemble BnF pour la Passe 2 (expansion complète sur toute la triade)
    const seriesSeedMap = new Map<
      string,
      { name: string; author?: string; ensIds: Set<string>; weight: number }
    >();
    const registerSeriesSeed = (rawSeries: string | undefined, weight: number, author?: string, ensId?: string) => {
      if (!rawSeries?.trim()) return;
      const cleanName = cleanSeriesName(rawSeries.trim());
      const canon = seriesCanonicalKey(cleanName);
      if (!canon || canon.length < 2) return;
      const existing = seriesSeedMap.get(canon);
      if (!existing) {
        seriesSeedMap.set(canon, {
          name: cleanName,
          author,
          ensIds: new Set(ensId ? [ensId] : []),
          weight
        });
      } else {
        existing.weight += weight;
        if (!existing.author && author) existing.author = author;
        if (ensId) existing.ensIds.add(ensId);
        // Préférer le nom canonique complet s'il contient déjà le mot clé
        if (cleanName.length > existing.name.length && normalizeTextKey(cleanName).includes(normalizeTextKey(cleanQ))) {
          existing.name = cleanName;
        }
      }
    };

    for (const item of d1Items) {
      if (item.type === 'series') registerSeriesSeed(item.label, 12);
    }
    for (const b of bnfCandidates) {
      if (b.series) registerSeriesSeed(b.series, 5, b.authors[0], b._bnfEnsembleId);
    }
    for (const g of gbCandidates) {
      if (g.series) registerSeriesSeed(g.series, 4, g.authors[0]);
    }
    for (const ol of olCandidates) {
      if (ol.series) registerSeriesSeed(ol.series, 3, ol.authors[0]);
    }

    for (const lb of localBooks) {
      if (lb.series) registerSeriesSeed(lb.series, 6, lb.authors[0]);
    }
    for (const sh of serverLocalHits) {
      if (sh.seriesName) registerSeriesSeed(sh.seriesName, 7, sh.authors?.[0]);
    }

    const normQ = normalizeTextKey(cleanQ);
    // Si aucune graine explicite ne porte le mot-clé recherché (ex: recherche "Tintin"), forcer l'exploration de série sur cleanQ
    const hasSeedMatchingQuery = Array.from(seriesSeedMap.keys()).some(
      (k) => k === normQ || k.includes(normQ) || normQ.includes(k)
    );
    if (!isOffline && !hasSeedMatchingQuery && cleanQ.length >= 3) {
      registerSeriesSeed(cleanQ, 8);
    }

    // Passe 2 : Expansion complète de toutes les séries pertinentes (max 4) sur TOUTE la triade (BnF + Google Books + Open Library)
    if (!isOffline && !strongLocalCoverage && seriesSeedMap.size > 0) {
      const topSeriesSeeds = Array.from(seriesSeedMap.entries())
        .map(([canon, seed]) => {
          const relevance =
            canon === normQ ? 100 : canon.includes(normQ) || normQ.includes(canon) ? 50 : 0;
          return { canon, seed, score: relevance + seed.weight };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);

      const expansionResults = await Promise.all(
        topSeriesSeeds.map(async ({ seed }) => {
          const ensIdList = Array.from(seed.ensIds);
          const [bnfVols, gbVols, olVols] = await Promise.all([
            bnfResolver.searchSeriesVolumes(seed.name, seed.author, ensIdList).catch(() => [] as ExternalBookMetadata[]),
            googleBooksResolver.searchKeywordOrSeriesVolumes(seed.name, seed.author, 60).catch(() => [] as ExternalBookMetadata[]),
            openLibraryResolver.searchCandidatesByHints({ series: seed.name, author: seed.author }, 30).catch(() => [] as ExternalBookMetadata[])
          ]);
          return { seed, bnfVols, gbVols, olVols };
        })
      );

      for (const { seed, bnfVols, gbVols, olVols } of expansionResults) {
        const seedCanon = seriesCanonicalKey(seed.name);
        for (const v of bnfVols) {
          bnfCandidates.push({ ...v, series: v.series || seed.name });
        }
        for (const g of gbVols) {
          const gSeriesCanon = g.series ? seriesCanonicalKey(g.series) : '';
          const titleHasSeries = normalizeTextKey(g.title).includes(seedCanon);
          if (gSeriesCanon === seedCanon || (!g.series && titleHasSeries && g.seriesNumber)) {
            gbCandidates.push({ ...g, series: g.series || seed.name });
          } else {
            gbCandidates.push(g);
          }
        }
        for (const ol of olVols) {
          const olSeriesCanon = ol.series ? seriesCanonicalKey(ol.series) : '';
          if (olSeriesCanon === seedCanon || !ol.series) {
            olCandidates.push({ ...ol, series: ol.series || seed.name });
          }
        }
      }
    }

    // 1. Fusion & dédoublonnage des livres/tomes par ISBN-13 (ou titre+auteur normalisé si sans ISBN)
    const bookMap = new Map<
      string,
      KeywordBookEntry & { _rawSubjects: string[]; _dewey?: string; _collection?: string; _explicitCovers: string[] }
    >();

    const upsertBook = (
      source: string,
      input: {
        uri?: string;
        isbn?: string;
        title: string;
        authors?: string[];
        series?: string;
        seriesNumber?: string;
        publisher?: string;
        publishDate?: string;
        coverUrl?: string;
        collection?: string;
        deweyCode?: string;
        rawSubjects?: string[];
        existingGenres?: string[];
      }
    ) => {
      const isbn13 = normalizeIsbn13(input.isbn);
      const normTitle = normalizeTextKey(input.title);
      const normFirstAuthor = normalizeTextKey(input.authors?.[0] || '');
      const key = isbn13 ? `isbn:${isbn13}` : input.uri ? `uri:${input.uri}` : `work:${normTitle}|${normFirstAuthor}`;
      if (!input.title.trim()) return;

      const existing = bookMap.get(key);
      if (!existing) {
        const cls = classifyEntry({
          title: input.title,
          series: input.series,
          publisher: input.publisher,
          collection: input.collection,
          deweyCode: input.deweyCode,
          rawSubjects: input.rawSubjects,
          existingGenres: input.existingGenres
        });
        const explicitCovers = input.coverUrl ? [input.coverUrl] : [];
        bookMap.set(key, {
          id: key,
          uri: input.uri || (isbn13 ? `isbn:${isbn13}` : undefined),
          isbn13,
          title: input.title.trim(),
          authors: (input.authors || []).filter(Boolean),
          series: input.series?.trim() || undefined,
          seriesNumber: input.seriesNumber ? normalizeSeriesNumber(input.seriesNumber) : undefined,
          publisher: input.publisher?.trim() || undefined,
          publishDate: input.publishDate,
          coverUrl: input.coverUrl,
          category: cls.category,
          genres: cls.genres,
          sources: [source],
          _rawSubjects: [...(input.rawSubjects || []), ...(input.existingGenres || [])],
          _dewey: input.deweyCode,
          _collection: input.collection,
          _explicitCovers: explicitCovers
        });
        return;
      }

      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (!existing.uri && input.uri) existing.uri = input.uri;
      if (input.coverUrl && !existing._explicitCovers.includes(input.coverUrl)) {
        existing._explicitCovers.push(input.coverUrl);
      }
      if (!existing.series && input.series) existing.series = input.series.trim();
      if (!existing.seriesNumber && input.seriesNumber) {
        existing.seriesNumber = normalizeSeriesNumber(input.seriesNumber);
      }
      if (!existing.publisher && input.publisher) existing.publisher = input.publisher.trim();
      if (!existing.publishDate && input.publishDate) existing.publishDate = input.publishDate;
      if (existing.authors.length === 0 && input.authors?.length) {
        existing.authors = input.authors.filter(Boolean);
      }
      if (input.rawSubjects?.length || input.existingGenres?.length) {
        existing._rawSubjects.push(...(input.rawSubjects || []), ...(input.existingGenres || []));
      }
      if (!existing._dewey && input.deweyCode) existing._dewey = input.deweyCode;
      if (!existing._collection && input.collection) existing._collection = input.collection;

      const reCls = classifyEntry({
        title: existing.title,
        series: existing.series,
        publisher: existing.publisher,
        collection: existing._collection,
        deweyCode: existing._dewey,
        rawSubjects: existing._rawSubjects
      });
      existing.category = reCls.category;
      existing.genres = reCls.genres;
    };

    for (const sh of serverLocalHits) {
      upsertBook('Catalogue D1 V4', {
        uri: sh.isbn13 ? `isbn:${sh.isbn13}` : undefined,
        isbn: sh.isbn13,
        title: sh.title,
        authors: sh.authors,
        series: sh.seriesName,
        seriesNumber: sh.volumeNumber !== null && sh.volumeNumber !== undefined ? String(sh.volumeNumber) : undefined,
        coverUrl: sh.coverUrl
      });
    }

    for (const lb of localBooks) {
      upsertBook('Ma Biblio', {
        uri: lb.uri,
        isbn: lb.isbn13 || lb.isbn10,
        title: lb.title,
        authors: lb.authors,
        series: lb.series,
        seriesNumber: lb.seriesNumber,
        publisher: lb.publisher,
        publishDate: lb.publishDate,
        coverUrl: lb.localCover || lb.coverUrl,
        existingGenres: lb.genres
      });
    }

    for (const c of bnfCandidates) {
      upsertBook('BnF', {
        isbn: c.isbn,
        title: c.title,
        authors: c.authors,
        series: c.series,
        seriesNumber: c.seriesNumber,
        publisher: c.publisher,
        publishDate: c.publishDate,
        coverUrl: c.coverUrl,
        collection: c.collection,
        deweyCode: c.deweyCode,
        rawSubjects: c.rawSubjects
      });
    }

    for (const g of gbCandidates) {
      upsertBook('Google Books', {
        isbn: g.isbn,
        title: g.title,
        authors: g.authors,
        series: g.series,
        seriesNumber: g.seriesNumber,
        publisher: g.publisher,
        publishDate: g.publishDate,
        coverUrl: g.coverUrl,
        rawSubjects: g.rawSubjects
      });
    }

    for (const ol of olCandidates) {
      upsertBook('Open Library', {
        isbn: ol.isbn,
        title: ol.title,
        authors: ol.authors,
        series: ol.series,
        seriesNumber: ol.seriesNumber,
        publisher: ol.publisher,
        publishDate: ol.publishDate,
        coverUrl: ol.coverUrl,
        rawSubjects: ol.rawSubjects
      });
    }

    // Ajouter les œuvres retournées uniquement par D1 / Inventaire (sans doublon d'URI ou titre exact)
    for (const item of d1Items) {
      if (item.type === 'work' || item.type === 'unknown') {
        const uriIsbn = item.uri?.startsWith('isbn:') ? item.uri.slice(5) : undefined;
        upsertBook('Catalogue D1', {
          uri: item.uri,
          isbn: uriIsbn,
          title: item.label,
          coverUrl: item.coverUrl
        });
      }
    }

    const allBooks = Array.from(bookMap.values()).map(({ _rawSubjects, _dewey, _collection, _explicitCovers, ...clean }) => {
      const coverFallbackUrls = imageUtil.buildCoverCandidates(clean.isbn13, _explicitCovers);
      return {
        ...clean,
        coverUrl: _explicitCovers[0] || coverFallbackUrls[0],
        coverFallbackUrls
      };
    });

    // 2. Séparer Tomes de série vs Œuvres uniques & regrouper les variantes du même nom de série
    const seriesGroupMap = new Map<string, KeywordSeriesGroup>();

    for (const item of d1Items) {
      if (item.type !== 'series') continue;
      const sk = seriesCanonicalKey(item.label);
      if (!sk) continue;
      if (!seriesGroupMap.has(sk)) {
        const cls = classifyEntry({ title: item.label, series: item.label });
        seriesGroupMap.set(sk, {
          key: sk,
          name: cleanSeriesName(item.label) || item.label,
          uri: item.uri,
          category: cls.category,
          genres: cls.genres,
          authors: [],
          volumes: []
        });
      }
    }

    const rawVolumes: KeywordBookEntry[] = [];
    const standaloneWorks: KeywordBookEntry[] = [];

    for (const book of allBooks) {
      if (book.series) {
        rawVolumes.push(book);
        const sk = seriesCanonicalKey(book.series);
        if (sk) {
          const existingGroup = seriesGroupMap.get(sk);
          if (!existingGroup) {
            seriesGroupMap.set(sk, {
              key: sk,
              name: cleanSeriesName(book.series) || book.series,
              category: book.category,
              genres: [...book.genres],
              authors: [...book.authors],
              volumes: [book]
            });
          } else {
            existingGroup.volumes.push(book);
            // Préférer le nom le plus explicite (ex: "Les Aventures de Tintin" plutôt que "Tintin")
            if (book.series.length > existingGroup.name.length && normalizeTextKey(book.series).includes(sk)) {
              existingGroup.name = cleanSeriesName(book.series) || existingGroup.name;
            }
            for (const a of book.authors) {
              if (!existingGroup.authors.includes(a)) existingGroup.authors.push(a);
            }
            for (const g of book.genres) {
              if (!existingGroup.genres.includes(g)) existingGroup.genres.push(g);
            }
            existingGroup.category = existingGroup.genres[0] || existingGroup.category;
          }
        }
      } else {
        standaloneWorks.push(book);
      }
    }

    // Dédoublonner les rééditions d'un même tome à l'intérieur de chaque série et trier T.1 -> T.N
    const deduplicateSeriesVolumes = (vols: KeywordBookEntry[]): KeywordBookEntry[] => {
      const byVolKey = new Map<string, KeywordBookEntry>();
      for (const vol of vols) {
        const volKey = vol.seriesNumber
          ? `num:${normalizeSeriesNumber(vol.seriesNumber)}`
          : `title:${normalizeTextKey(vol.title)}`;
        const prev = byVolKey.get(volKey);
        byVolKey.set(volKey, prev ? mergeEditionEntries(prev, vol) : vol);
      }
      return Array.from(byVolKey.values()).sort((a, b) => compareVolumeNumbers(a.seriesNumber, b.seriesNumber));
    };

    const series = Array.from(seriesGroupMap.values())
      .map((s) => ({
        ...s,
        volumes: deduplicateSeriesVolumes(s.volumes)
      }))
      .sort((a, b) => {
        const aDirect = a.key === normQ || a.key.includes(normQ) ? 1 : 0;
        const bDirect = b.key === normQ || b.key.includes(normQ) ? 1 : 0;
        if (aDirect !== bDirect) return bDirect - aDirect;
        if (b.volumes.length !== a.volumes.length) return b.volumes.length - a.volumes.length;
        return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
      });

    // Dédoublonner également la liste plate des tomes via les éditions fusionnées de chaque série + éventuels tomes restants
    const flatBySeriesAndVol = new Map<string, KeywordBookEntry>();
    for (const s of series) {
      for (const vol of s.volumes) {
        const k = `${s.key}|${vol.seriesNumber || normalizeTextKey(vol.title)}`;
        flatBySeriesAndVol.set(k, vol);
      }
    }
    const volumes = Array.from(flatBySeriesAndVol.values()).sort(
      (a, b) =>
        a.category.localeCompare(b.category) ||
        (a.series || '').localeCompare(b.series || '') ||
        compareVolumeNumbers(a.seriesNumber, b.seriesNumber) ||
        a.title.localeCompare(b.title)
    );

    standaloneWorks.sort(
      (a, b) => a.category.localeCompare(b.category) || b.sources.length - a.sources.length || a.title.localeCompare(b.title)
    );

    // 3. Construire la liste ordonnée des Auteurs (D1/Inventaire + auteurs des notices trouvées)
    const authorMap = new Map<string, KeywordAuthorEntry>();
    for (const item of d1Items) {
      if (item.type !== 'author') continue;
      const ak = normalizeTextKey(item.label);
      if (!ak) continue;
      authorMap.set(ak, {
        key: ak,
        name: item.label,
        uri: item.uri,
        description: item.description,
        matchCount: 1
      });
    }
    for (const book of allBooks) {
      for (const aName of book.authors) {
        const ak = normalizeTextKey(aName);
        if (!ak) continue;
        const existing = authorMap.get(ak);
        if (existing) {
          existing.matchCount++;
        } else {
          authorMap.set(ak, {
            key: ak,
            name: aName,
            matchCount: 1
          });
        }
      }
    }
    const authors = Array.from(authorMap.values()).sort((a, b) => {
      const aDirect = a.key.includes(normQ) || normQ.includes(a.key) ? 1 : 0;
      const bDirect = b.key.includes(normQ) || normQ.includes(b.key) ? 1 : 0;
      if (aDirect !== bDirect) return bDirect - aDirect;
      if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
      return a.name.localeCompare(b.name);
    });

    // 4. Comptage ordonné des sous-catégories / genres
    const catCount = new Map<string, number>();
    for (const book of allBooks) {
      for (const g of book.genres) {
        catCount.set(g, (catCount.get(g) || 0) + 1);
      }
    }
    const categories: KeywordCategorySummary[] = Array.from(catCount.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    return {
      categories,
      series,
      volumes,
      standaloneWorks,
      authors
    };
  }
};
