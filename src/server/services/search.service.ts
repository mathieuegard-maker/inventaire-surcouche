// src/server/services/search.service.ts
// Recherche catalogue centrée "Œuvre abstraite" (Lot 3) :
// 1. Court-circuit Catalogue Central SQLite d'abord (0 appel réseau si la série/l'œuvre est déjà en base),
// 2. Sinon résolution légère Série canonique (Wikidata/BnF) -> bon Tome N + Intégrale couvrante (sans pollution DB avant validation),
// 3. Agrégation des résultats externes par Œuvre abstraite (regroupement des rééditions/ISBNs d'un même album).

import { annotateIntegralCoverage, parseIncludedVolumeNumbers } from '../../shared/bibliographic/integral.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import {
  cleanTitle,
  extractFranchiseBaseName,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../shared/bibliographic/text-normalize.util';
import type { BookView, SeriesView } from '../../shared/types/domain.types';
import type { BibliographicConnectors, SourceCandidateRecord } from '../connectors/types';
import type { CatalogRepository } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import { BookIdentifierService } from './acquisition/book-identifier.service';
import type { IngestionService } from './acquisition/ingestion.service';

export interface ExternalSearchHit {
  isbn13: string;
  title: string;
  seriesName: string | null;
  volumeNumber: string | null;
  authors: string[];
  publisher: string | null;
  collectionName: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  source: string;
  isIntegral?: boolean;
  includedVolumes?: string[];
  editionCount?: number;
}

export interface CatalogSearchResponse {
  series: SeriesView[];
  books: BookView[];
  externalBooks: ExternalSearchHit[];
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export class SearchService {
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly connectors: BibliographicConnectors;
  private readonly ingestionService: IngestionService;
  private readonly bookIdentifier: BookIdentifierService;

  constructor(deps: {
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    connectors: BibliographicConnectors;
    ingestionService: IngestionService;
    bookIdentifier?: BookIdentifierService;
  }) {
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.connectors = deps.connectors;
    this.ingestionService = deps.ingestionService;
    this.bookIdentifier = deps.bookIdentifier ?? new BookIdentifierService({ connectors: deps.connectors });
  }

  async searchCatalog(input: {
    libraryId: string;
    userId: string;
    title?: string;
    series?: string;
    volumeNumber?: string;
    author?: string;
    collection?: string;
    publisher?: string;
    isbn?: string;
  }): Promise<CatalogSearchResponse> {
    // 1. Cas ISBN direct -> résolution complète par le pipeline 3 étages (mode preview)
    if (input.isbn?.trim()) {
      const cleanIsbn = isbnUtil.normalizeToIsbn13(input.isbn.trim());
      if (cleanIsbn) {
        const res = await this.ingestionService.resolveIsbns({
          rawIsbns: [cleanIsbn],
          channel: 'text_search',
          action: 'preview',
          userId: input.userId,
          libraryId: input.libraryId
        });
        const book = res.results[0]?.book;
        return {
          series: [],
          books: book ? [book] : [],
          externalBooks: []
        };
      }
    }

    const volStr = normalizeSeriesNumber(input.volumeNumber);
    const volNum = /^\d+$/.test(volStr) ? parseInt(volStr, 10) : null;
    const cleanTitleIn = input.title?.trim() || '';
    const cleanSeriesIn = input.series?.trim() || '';
    const cleanAuthorIn = input.author?.trim() || '';

    // 2. Recherche locale SQLite exhaustive (Catalogue Central + Foyer — Œuvres abstraites & Séries)
    const local = this.catalogRepo.searchLocalCatalog({
      titleNorm: cleanTitleIn ? normalizeTextKey(cleanTitleIn) : undefined,
      seriesNorm: cleanSeriesIn ? normalizeTextKey(cleanSeriesIn) : undefined,
      volumeNumber: volNum,
      authorNorm: cleanAuthorIn ? normalizeTextKey(cleanAuthorIn) : undefined,
      collectionNorm: input.collection?.trim() ? normalizeTextKey(input.collection) : undefined,
      publisherNorm: input.publisher?.trim() ? normalizeTextKey(input.publisher) : undefined,
      limit: 40
    });

    const rawLocalBooks: BookView[] = local.books.map((bookRow) => {
      const libRow = this.libraryRepo.findLibraryBook(input.libraryId, bookRow.id);
      return this.ingestionService.buildMergedBookView(bookRow, libRow);
    });

    // Trier : tomes unitaires en première intention, intégrales couvrantes juste après
    const localBooks = annotateIntegralCoverage(rawLocalBooks, rawLocalBooks).sort((a, b) => {
      if (a.isIntegral !== b.isIntegral) return a.isIntegral ? 1 : -1;
      const sa = a.sortOrder ?? a.volumeNumber ?? 999999;
      const sb = b.sortOrder ?? b.volumeNumber ?? 999999;
      if (sa !== sb) return sa - sb;
      return a.title.localeCompare(b.title, 'fr');
    });

    const localSeries: SeriesView[] = local.series.map((sRow) => {
      const seriesBooks = this.catalogRepo.listBooksBySeriesId(sRow.id);
      const mergedSeriesViews = seriesBooks.map((sb) =>
        this.ingestionService.buildMergedBookView(sb, this.libraryRepo.findLibraryBook(input.libraryId, sb.id))
      );
      const annotatedSeriesViews = annotateIntegralCoverage(mergedSeriesViews, mergedSeriesViews);
      const unitary = annotatedSeriesViews.filter((b) => !b.isIntegral);
      const progressPool = unitary.length > 0 ? unitary : annotatedSeriesViews;
      const ownedCount = progressPool.filter((b) => b.ownershipStatus === 'owned' || Boolean(b.ownedViaIntegral)).length;
      const coverBook =
        annotatedSeriesViews.find((b) => !b.isIntegral && b.ownershipStatus === 'owned' && b.coverUrl) ??
        annotatedSeriesViews.find((b) => !b.isIntegral && b.coverUrl) ??
        annotatedSeriesViews.find((b) => b.coverUrl);

      return {
        id: sRow.id,
        franchiseId: sRow.franchise_id,
        canonicalName: sRow.canonical_name,
        editionSignature: sRow.edition_signature || null,
        aliases: parseJsonArray(sRow.aliases_json),
        primaryAuthors: parseJsonArray(sRow.primary_authors_json),
        wikidataQid: sRow.wikidata_qid,
        isCompleteExpanded: sRow.is_complete_expanded === 1,
        knownVolumesCount: unitary.length > 0 ? unitary.length : Math.max(sRow.known_volumes_count, seriesBooks.length),
        ownedCount,
        coverUrl: coverBook?.coverUrl ?? null,
        updatedAt: sRow.updated_at
      };
    });

    // Court-circuit Catalogue Central local :
    // Si la série ciblée est déjà étendue en base ET que le tome unitaire (ou l'œuvre exacte) est déjà présent localement,
    // inutile de réinterroger internet !
    const hasExpandedLocalSeries = localSeries.some((s) => s.isCompleteExpanded);
    const hasLocalExactVolume =
      volNum !== null && localBooks.some((b) => !b.isIntegral && b.volumeNumber === volNum);
    const hasLocalSeriesOnlyMatch =
      !volNum &&
      Boolean(cleanSeriesIn || cleanTitleIn) &&
      hasExpandedLocalSeries &&
      localSeries.some(
        (s) =>
          extractFranchiseBaseName(s.canonicalName).normalizedKey ===
          extractFranchiseBaseName(cleanSeriesIn || cleanTitleIn).normalizedKey
      );
    const hasLocalExactTitleMatch =
      Boolean(cleanTitleIn) &&
      !cleanSeriesIn &&
      !volNum &&
      localBooks.some((b) => normalizeTextKey(b.title) === normalizeTextKey(cleanTitleIn));

    if (
      (hasExpandedLocalSeries && hasLocalExactVolume) ||
      hasLocalSeriesOnlyMatch ||
      hasLocalExactTitleMatch
    ) {
      return {
        series: localSeries,
        books: localBooks,
        externalBooks: []
      };
    }

    // 3. Résolution externe légère centrée "Série canonique -> Œuvre abstraite (+ Intégrale couvrante)"
    //    Zéro écriture en base avant validation utilisateur ; le cache SQLite `external_cache` évite tout double travail ensuite.
    const knownIsbns = new Set<string>();
    for (const b of localBooks) {
      for (const isbn of b.knownIsbns) knownIsbns.add(isbn);
    }

    const externalBooks: ExternalSearchHit[] = [];
    const seenWorkKeys = new Set<string>();
    const seriesHint = cleanSeriesIn || (volNum !== null ? cleanTitleIn : '');
    const normPub = input.publisher?.trim() ? normalizeTextKey(input.publisher) : '';
    const normCol = input.collection?.trim() ? normalizeTextKey(input.collection) : '';

    const pushAbstractExternalHit = (hit: ExternalSearchHit, priorityFront = false) => {
      if (!hit.isbn13 || !hit.title || knownIsbns.has(hit.isbn13)) return;
      const workKey = [
        hit.isIntegral ? 'int' : 'vol',
        extractFranchiseBaseName(hit.seriesName || '').normalizedKey,
        hit.volumeNumber || '',
        normalizeTextKey(cleanTitle(hit.title))
      ].join('|');
      if (seenWorkKeys.has(workKey)) {
        const existing = externalBooks.find((e) => {
          const k = [
            e.isIntegral ? 'int' : 'vol',
            extractFranchiseBaseName(e.seriesName || '').normalizedKey,
            e.volumeNumber || '',
            normalizeTextKey(cleanTitle(e.title))
          ].join('|');
          return k === workKey;
        });
        if (existing) {
          existing.editionCount = (existing.editionCount ?? 1) + 1;
          if (!existing.coverUrl && hit.coverUrl) existing.coverUrl = hit.coverUrl;
        }
        return;
      }
      seenWorkKeys.add(workKey);
      knownIsbns.add(hit.isbn13);
      if (priorityFront) externalBooks.unshift(hit);
      else externalBooks.push(hit);
    };

    // 3A. Si l'utilisateur cherche une Série + un N° de tome (ex. "Lucky Luke 32" ou "Boule et Bill 12") :
    //     consulter d'abord le graphe canonique (Wikidata + BnF Intégrales) pour proposer le VRAI tome N (et son intégrale couvrante) !
    if (seriesHint && volNum !== null) {
      const canonicalWork = await this.resolveCanonicalSeriesVolumePreview(
        seriesHint,
        volNum,
        cleanAuthorIn || undefined
      );
      if (canonicalWork) {
        pushAbstractExternalHit(canonicalWork, true);
      }

      if (this.connectors.bnf.searchSeriesIntegrals) {
        const integrals = await this.connectors.bnf.searchSeriesIntegrals(seriesHint, 15).catch(() => []);
        const covering = integrals.filter((it) => (it.includedVolumes ?? []).includes(String(volNum)));
        for (const it of covering.slice(0, 2)) {
          const isbn = it.isbn13s[0];
          if (!isbn) continue;
          pushAbstractExternalHit({
            isbn13: isbn,
            title: it.title,
            seriesName: extractFranchiseBaseName(seriesHint).baseName,
            volumeNumber: it.volumeLabel ?? 'Intégrale',
            authors: it.authors,
            publisher: it.publisher ?? null,
            collectionName: it.collectionName ?? null,
            publishYear: it.publishYear ?? null,
            coverUrl: it.coverUrl ?? null,
            source: 'bnf',
            isIntegral: true,
            includedVolumes: it.includedVolumes ?? [],
            editionCount: Math.max(1, it.isbn13s.length)
          });
        }
      }
    }

    // 3B. Complément externe BnF SRU + secours Inventaire.io (agrégé par Œuvre abstraite)
    const primaryQuery = [cleanSeriesIn, cleanTitleIn, volStr].filter(Boolean).join(' ').trim();
    if ((primaryQuery || cleanAuthorIn) && externalBooks.length < 12) {
      const authorQuery = cleanAuthorIn || undefined;
      const bnfHits = await this.connectors.bnf
        .searchByTitleAndAuthor(primaryQuery, authorQuery, primaryQuery ? 15 : 25)
        .catch(() => []);

      const invHits =
        bnfHits.length < 3 && this.connectors.inventaire.searchByText
          ? await this.connectors.inventaire.searchByText(primaryQuery || authorQuery!, 5).catch(() => [])
          : [];

      const combinedHits: SourceCandidateRecord[] = [...bnfHits, ...invHits];

      // Si un numéro de tome est demandé, privilégier les notices correspondant à ce tome (ou une intégrale couvrante)
      combinedHits.sort((a, b) => {
        const score = (h: SourceCandidateRecord): number => {
          let s = 0;
          if (volStr && normalizeSeriesNumber(h.volumeNumber) === volStr) s += 50;
          if (volStr && h.isIntegralHint) {
            const inc = parseIncludedVolumeNumbers(`${h.title ?? ''} ${h.subtitle ?? ''}`);
            if (inc.includes(volStr)) s += 35;
          }
          if (seriesHint && h.seriesName && tokenOverlapRatio(seriesHint, h.seriesName) >= 0.7) s += 20;
          if (h.coverUrl) s += 10;
          if (h.isbn13.startsWith('9782') || h.isbn13.startsWith('97910')) s += 8;
          return s;
        };
        return score(b) - score(a);
      });

      for (const hit of combinedHits) {
        if (!hit.isbn13 || !hit.title) continue;
        if (hit.isNonBook) continue;
        if (normPub && hit.publisher && !normalizeTextKey(hit.publisher).includes(normPub)) continue;
        if (normCol && hit.collectionName && !normalizeTextKey(hit.collectionName).includes(normCol)) continue;

        const incVols = hit.isIntegralHint
          ? parseIncludedVolumeNumbers(`${hit.title} ${hit.subtitle ?? ''}`)
          : [];

        pushAbstractExternalHit({
          isbn13: hit.isbn13,
          title: hit.title,
          seriesName: hit.seriesName ?? null,
          volumeNumber: hit.volumeNumber ?? null,
          authors: hit.authors,
          publisher: hit.publisher ?? null,
          collectionName: hit.collectionName ?? null,
          publishYear: hit.publishYear ?? null,
          coverUrl: hit.coverUrl ?? null,
          source: hit.source,
          isIntegral: Boolean(hit.isIntegralHint),
          includedVolumes: incVols,
          editionCount: 1
        });
      }
    }

    // Tri final : tome unitaire exact en premier, intégrale couvrante juste après
    externalBooks.sort((a, b) => {
      const rank = (h: ExternalSearchHit): number => {
        if (volStr && !h.isIntegral && normalizeSeriesNumber(h.volumeNumber) === volStr) return 0;
        if (volStr && h.isIntegral && (h.includedVolumes ?? []).includes(volStr)) return 1;
        if (!h.isIntegral) return 2;
        return 3;
      };
      return rank(a) - rank(b);
    });

    return {
      series: localSeries,
      books: localBooks,
      externalBooks: externalBooks.slice(0, 20)
    };
  }

  /**
   * Résout en lecture seule (sans écrire en base) le VRAI tome N d'une série via le graphe canonique
   * (Wikidata P179/P1545 puis BookIdentifierService Étage 1 -> ISBN FR), évitant les décalages de numérotation BnF bruts.
   */
  private async resolveCanonicalSeriesVolumePreview(
    seriesName: string,
    volumeNumber: number,
    authorHint?: string
  ): Promise<ExternalSearchHit | null> {
    const cleanSeries = extractFranchiseBaseName(seriesName).baseName;

    // 1. Interroger le graphe Wikidata (en cache) pour connaître le titre canonique exact du tome N
    let canonicalTitle: string | null = null;
    let canonicalAuthors: string[] = authorHint ? [authorHint] : [];
    let canonicalCover: string | null = null;

    try {
      const qids = this.connectors.wikidata.searchSeriesQids
        ? await this.connectors.wikidata.searchSeriesQids(cleanSeries, 'neutral')
        : this.connectors.wikidata.searchSeriesQid
          ? [await this.connectors.wikidata.searchSeriesQid(cleanSeries)].filter((x): x is string => Boolean(x))
          : [];

      for (const qid of qids.slice(0, 2)) {
        const works = await this.connectors.wikidata.fetchSeriesWorksByQid(qid);
        const match = works.find((w) => !w.isIntegral && !w.isHorsSerie && w.volumeNumber === volumeNumber);
        if (match) {
          canonicalTitle = cleanTitle(match.title);
          if (match.authors.length > 0) canonicalAuthors = match.authors;
          canonicalCover = match.coverUrl ?? null;
          break;
        }
      }
    } catch {
      // continue vers BnF
    }

    // 2. Si on connaît le titre canonique exact, utiliser BookIdentifierService (Étage 1) pour obtenir son meilleur ISBN FR
    if (canonicalTitle) {
      const isbns = await this.bookIdentifier.findRankedIsbnsForSeriesVolume(
        {
          seriesName: cleanSeries,
          title: canonicalTitle,
          volumeNumber,
          authors: canonicalAuthors,
          mediaFamily: 'neutral',
          isIntegral: false
        },
        4
      );
      if (isbns.length > 0) {
        return {
          isbn13: isbns[0],
          title: canonicalTitle,
          seriesName: cleanSeries,
          volumeNumber: String(volumeNumber),
          authors: canonicalAuthors,
          publisher: null,
          collectionName: null,
          publishYear: null,
          coverUrl: canonicalCover,
          source: 'wikidata',
          isIntegral: false,
          includedVolumes: [],
          editionCount: isbns.length
        };
      }
    }

    // 3. Repli : recherche BnF ciblée Série + Numéro exact (460$v === N)
    if (this.connectors.bnf.searchSeriesVolume) {
      const bnfExact = await this.connectors.bnf
        .searchSeriesVolume(cleanSeries, volumeNumber, authorHint)
        .catch(() => []);
      const valid = bnfExact.find((w) => !w.isIntegral && w.isbn13s.length > 0);
      if (valid) {
        return {
          isbn13: valid.isbn13s[0],
          title: valid.title,
          seriesName: cleanSeries,
          volumeNumber: String(volumeNumber),
          authors: valid.authors,
          publisher: valid.publisher ?? null,
          collectionName: valid.collectionName ?? null,
          publishYear: valid.publishYear ?? null,
          coverUrl: valid.coverUrl ?? null,
          source: 'bnf',
          isIntegral: false,
          includedVolumes: [],
          editionCount: valid.isbn13s.length
        };
      }
    }

    return null;
  }
}
