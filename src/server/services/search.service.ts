// src/server/services/search.service.ts
// Recherche catalogue multi-critères exhaustive : SQLite local (books + book_editions + series) + BnF SRU -> { series[], books[], externalBooks[] }.

import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { normalizeSeriesNumber, normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import type { BookView, SeriesView } from '../../shared/types/domain.types';
import type { BibliographicConnectors } from '../connectors/types';
import type { CatalogRepository } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
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

  constructor(deps: {
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    connectors: BibliographicConnectors;
    ingestionService: IngestionService;
  }) {
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.connectors = deps.connectors;
    this.ingestionService = deps.ingestionService;
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

    // 2. Recherche locale SQLite exhaustive (books + book_editions + series)
    const local = this.catalogRepo.searchLocalCatalog({
      titleNorm: input.title?.trim() ? normalizeTextKey(input.title) : undefined,
      seriesNorm: input.series?.trim() ? normalizeTextKey(input.series) : undefined,
      volumeNumber: volNum,
      authorNorm: input.author?.trim() ? normalizeTextKey(input.author) : undefined,
      collectionNorm: input.collection?.trim() ? normalizeTextKey(input.collection) : undefined,
      publisherNorm: input.publisher?.trim() ? normalizeTextKey(input.publisher) : undefined,
      limit: 40
    });

    const localBooks: BookView[] = local.books.map((bookRow) => {
      const libRow = this.libraryRepo.findLibraryBook(input.libraryId, bookRow.id);
      return this.ingestionService.buildMergedBookView(bookRow, libRow);
    });

    const localSeries: SeriesView[] = local.series.map((sRow) => {
      const seriesBooks = this.catalogRepo.listBooksBySeriesId(sRow.id);
      let ownedCount = 0;
      let coverUrl: string | null = null;
      for (const sb of seriesBooks) {
        const lr = this.libraryRepo.findLibraryBook(input.libraryId, sb.id);
        const mv = this.ingestionService.buildMergedBookView(sb, lr);
        if (mv.ownershipStatus === 'owned') ownedCount++;
        if (!coverUrl && mv.coverUrl) coverUrl = mv.coverUrl;
      }
      return {
        id: sRow.id,
        franchiseId: sRow.franchise_id,
        canonicalName: sRow.canonical_name,
        editionSignature: sRow.edition_signature || null,
        aliases: parseJsonArray(sRow.aliases_json),
        primaryAuthors: parseJsonArray(sRow.primary_authors_json),
        wikidataQid: sRow.wikidata_qid,
        isCompleteExpanded: sRow.is_complete_expanded === 1,
        knownVolumesCount: Math.max(sRow.known_volumes_count, seriesBooks.length),
        ownedCount,
        coverUrl,
        updatedAt: sRow.updated_at
      };
    });

    // 3. Complément externe BnF SRU (dédupliqué contre les ISBN déjà dans localBooks)
    const knownIsbns = new Set<string>();
    for (const b of localBooks) {
      for (const isbn of b.knownIsbns) knownIsbns.add(isbn);
    }

    const externalBooks: ExternalSearchHit[] = [];
    const primaryQuery = [input.series, input.title, volStr].filter(Boolean).join(' ').trim();

    if (primaryQuery || input.author?.trim()) {
      try {
        const bnfHits = await this.connectors.bnf.searchByTitleAndAuthor(
          primaryQuery || input.author!.trim(),
          input.author?.trim() || undefined,
          15
        );

        const normPub = input.publisher?.trim() ? normalizeTextKey(input.publisher) : '';
        const normCol = input.collection?.trim() ? normalizeTextKey(input.collection) : '';

        for (const hit of bnfHits) {
          if (!hit.isbn13 || !hit.title || knownIsbns.has(hit.isbn13)) continue;
          if (normPub && hit.publisher && !normalizeTextKey(hit.publisher).includes(normPub)) continue;
          if (normCol && hit.collectionName && !normalizeTextKey(hit.collectionName).includes(normCol)) continue;
          knownIsbns.add(hit.isbn13);

          externalBooks.push({
            isbn13: hit.isbn13,
            title: hit.title,
            seriesName: hit.seriesName ?? null,
            volumeNumber: hit.volumeNumber ?? null,
            authors: hit.authors,
            publisher: hit.publisher ?? null,
            collectionName: hit.collectionName ?? null,
            publishYear: hit.publishYear ?? null,
            coverUrl: hit.coverUrl ?? null,
            source: hit.source
          });
        }
      } catch {
        // Repli propre sur les résultats locaux uniquement si BnF indisponible
      }
    }

    return {
      series: localSeries,
      books: localBooks,
      externalBooks
    };
  }
}
