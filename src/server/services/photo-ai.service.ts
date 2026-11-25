// src/server/services/photo-ai.service.ts
// Service Photo IA 100 % Serveur : quota mensuel, OCR Gemini, résolution BnF, arbitrage persisté, relance BnF serveur & validation lot.

import crypto from 'node:crypto';
import { hammingDistanceHex } from '../../shared/bibliographic/cover-dhash.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { parseIncludedVolumeNumbers } from '../../shared/bibliographic/integral.util';
import {
  cleanTitle,
  extractFranchiseBaseName,
  isGenericVolumeTitle,
  matchesAuthorName,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../shared/bibliographic/text-normalize.util';
import type { BackgroundJobView, OwnershipStatus } from '../../shared/types/domain.types';
import type { ServerConfig } from '../config';
import type { BibliographicConnectors, SourceCandidateRecord } from '../connectors/types';
import type { GeminiConnector, GeminiExtractedBookHint } from '../connectors/gemini.connector';
import type { BookRow, CatalogRepository } from '../repositories/catalog.repo';
import type { BackgroundJobRow, JobRepository } from '../repositories/job.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import type { UserRepository } from '../repositories/user.repo';
import { BookIdentifierService } from './acquisition/book-identifier.service';
import type { CoverService } from './cover.service';
import type { IngestionService } from './acquisition/ingestion.service';
import type { LibraryService } from './library.service';
import { mapJobRowToView, type JobHandlerContext } from '../workers/background-worker';
import { AppError } from '../middleware/error.middleware';

export interface PhotoCoverOption {
  coverKey: string | null;
  coverUrl: string;
  label: string;
  isbn13?: string | null;
}

export interface PhotoCandidateOption {
  bookId?: string | null;
  isbn13: string;
  siblingIsbns?: string[];
  editionCount?: number;
  title: string;
  seriesName: string | null;
  volumeNumber: string | null;
  authors: string[];
  publisher: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  coverOptions?: PhotoCoverOption[];
  isIntegral?: boolean;
  includedVolumes?: string[];
  source: string;
}

export interface PhotoJobItem {
  id: string;
  /** Position visuelle sur l'étagère (1 = le plus à gauche) et nombre total détecté. */
  spineIndex?: number;
  totalSpines?: number;
  hint: GeminiExtractedBookHint;
  status: 'identified' | 'doubt' | 'unresolved';
  options: PhotoCandidateOption[];
  /** Couverture indicative WebP (ex. trouvée par titre/auteur si aucune option ISBN n'a été identifiée). */
  fallbackCoverUrl?: string | null;
  selectedOptionIsbn13: string | null;
  /** Couverture choisie explicitement par l'utilisateur (appliquée en Couche 3 Foyer au commit). */
  selectedCoverKey?: string | null;
  selectedCoverUrl?: string | null;
  selected: boolean;
  ignored: boolean;
  alreadyStatus: OwnershipStatus;
  isIntegral: boolean;
  includedVolumes: string[];
  committedBookId: string | null;
}

export interface PhotoJobResultPayload {
  mode: 'shelf' | 'cover';
  previewCoverKey: string | null;
  previewUrl: string | null;
  items: PhotoJobItem[];
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toOption(rec: SourceCandidateRecord): PhotoCandidateOption | null {
  if (!rec.isbn13 || !rec.title) return null;
  const incVols = rec.isIntegralHint
    ? parseIncludedVolumeNumbers(`${rec.title} ${rec.subtitle ?? ''}`)
    : [];
  const edLabel = [rec.publisher, rec.publishYear ? `(${rec.publishYear})` : ''].filter(Boolean).join(' ').trim();
  const coverOptions: PhotoCoverOption[] = rec.coverUrl
    ? [
        {
          coverKey: rec.coverUrl.startsWith('/api/covers/') ? rec.coverUrl.slice('/api/covers/'.length) : null,
          coverUrl: rec.coverUrl,
          label: edLabel || `Édition ${rec.isbn13}`,
          isbn13: rec.isbn13
        }
      ]
    : [];
  return {
    bookId: null,
    isbn13: rec.isbn13,
    siblingIsbns: [rec.isbn13],
    editionCount: 1,
    title: rec.title,
    seriesName: rec.seriesName ?? null,
    volumeNumber: rec.volumeNumber ?? null,
    authors: rec.authors,
    publisher: rec.publisher ?? null,
    publishYear: rec.publishYear ?? null,
    coverUrl: rec.coverUrl ?? null,
    coverOptions,
    isIntegral: Boolean(rec.isIntegralHint),
    includedVolumes: incVols,
    source: rec.source
  };
}

function isSameAbstractWork(a: PhotoCandidateOption, b: PhotoCandidateOption): boolean {
  if (Boolean(a.isIntegral) !== Boolean(b.isIntegral)) return false;
  if (a.bookId && b.bookId) return a.bookId === b.bookId;

  const seriesA = extractFranchiseBaseName(a.seriesName || '').normalizedKey;
  const seriesB = extractFranchiseBaseName(b.seriesName || '').normalizedKey;
  const volA = normalizeSeriesNumber(a.volumeNumber);
  const volB = normalizeSeriesNumber(b.volumeNumber);
  const titleA = normalizeTextKey(cleanTitle(a.title));
  const titleB = normalizeTextKey(cleanTitle(b.title));

  // Intégrales : même série + même plage de tomes ou même titre normalisé
  if (a.isIntegral && b.isIntegral) {
    if (seriesA && seriesB && seriesA !== seriesB) return false;
    const volsA = (a.includedVolumes ?? []).join(',');
    const volsB = (b.includedVolumes ?? []).join(',');
    if (volsA && volsB && volsA === volsB) return true;
    return titleA === titleB && Boolean(titleA);
  }

  // Tomes d'une même série avec le même numéro de tome
  if (seriesA && seriesB && seriesA === seriesB && volA && volB) {
    if (volA !== volB) return false;
    if (titleA === titleB) return true;
    if (
      isGenericVolumeTitle(a.title, a.seriesName ?? '') ||
      isGenericVolumeTitle(b.title, b.seriesName ?? '')
    ) {
      return true;
    }
    return (
      tokenOverlapRatio(cleanTitle(a.title), cleanTitle(b.title)) >= 0.35 ||
      titleA.includes(titleB) ||
      titleB.includes(titleA)
    );
  }

  // Même titre exact (et pas de contradiction sur le tome ni la série)
  if (titleA && titleA === titleB) {
    if (volA && volB && volA !== volB) return false;
    if (seriesA && seriesB && seriesA !== seriesB) return false;
    return true;
  }

  return false;
}

export class PhotoAiService {
  private readonly config: ServerConfig;
  private readonly gemini: GeminiConnector;
  private readonly connectors: BibliographicConnectors;
  private readonly userRepo: UserRepository;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly jobRepo: JobRepository;
  private readonly coverService: CoverService;
  private readonly ingestionService: IngestionService;
  private readonly libraryService: LibraryService;
  private readonly bookIdentifier: BookIdentifierService;
  private readonly onJobChanged?: (job: BackgroundJobRow) => void;

  constructor(deps: {
    config: ServerConfig;
    gemini: GeminiConnector;
    connectors: BibliographicConnectors;
    userRepo: UserRepository;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    jobRepo: JobRepository;
    coverService: CoverService;
    ingestionService: IngestionService;
    libraryService: LibraryService;
    bookIdentifier?: BookIdentifierService;
    onJobChanged?: (job: BackgroundJobRow) => void;
  }) {
    this.config = deps.config;
    this.gemini = deps.gemini;
    this.connectors = deps.connectors;
    this.userRepo = deps.userRepo;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.jobRepo = deps.jobRepo;
    this.coverService = deps.coverService;
    this.ingestionService = deps.ingestionService;
    this.libraryService = deps.libraryService;
    this.bookIdentifier = deps.bookIdentifier ?? new BookIdentifierService({ connectors: deps.connectors });
    this.onJobChanged = deps.onJobChanged;
  }

  private assertOwnedJob(jobId: string, userId: string, libraryId: string): BackgroundJobRow {
    const row = this.jobRepo.findJobById(jobId);
    if (!row || row.type !== 'photo_ocr') {
      throw new AppError(404, 'PHOTO_JOB_NOT_FOUND', 'Lot Photo IA introuvable.');
    }
    if (row.user_id !== userId && row.library_id !== libraryId) {
      throw new AppError(403, 'FORBIDDEN', 'Accès refusé à ce lot Photo IA.');
    }
    return row;
  }

  private parseResult(row: BackgroundJobRow): PhotoJobResultPayload {
    if (row.result_json) {
      try {
        const parsed = JSON.parse(row.result_json) as Partial<PhotoJobResultPayload>;
        return {
          mode: parsed.mode === 'cover' ? 'cover' : 'shelf',
          previewCoverKey: parsed.previewCoverKey ?? null,
          previewUrl: parsed.previewCoverKey ? `/api/covers/${parsed.previewCoverKey}` : (parsed.previewUrl ?? null),
          items: Array.isArray(parsed.items) ? parsed.items : []
        };
      } catch {
        // fallback below
      }
    }
    return { mode: 'shelf', previewCoverKey: null, previewUrl: null, items: [] };
  }

  private lookupFoyerOwnershipByIsbn(libraryId: string, isbn13: string): OwnershipStatus {
    const book = this.catalogRepo.findBookByIsbn13(isbn13);
    if (!book) return 'none';
    const lib = this.libraryRepo.findLibraryBook(libraryId, book.id);
    if (!lib || lib.deleted_at) return 'none';
    return lib.status;
  }

  private lookupFoyerOwnershipForOption(
    libraryId: string,
    opt?: PhotoCandidateOption | null,
    fallbackIsbn?: string | null
  ): OwnershipStatus {
    if (!libraryId) return 'none';
    if (opt?.bookId) {
      const lib = this.libraryRepo.findLibraryBook(libraryId, opt.bookId);
      if (lib && !lib.deleted_at) return lib.status;
    }
    const isbns = Array.from(
      new Set([fallbackIsbn, opt?.isbn13, ...(opt?.siblingIsbns ?? [])].filter((x): x is string => Boolean(x)))
    );
    for (const isbn of isbns) {
      const status = this.lookupFoyerOwnershipByIsbn(libraryId, isbn);
      if (status !== 'none') return status;
    }
    return 'none';
  }

  /**
   * Construit une option « Œuvre abstraite » depuis le Catalogue Central SQLite avec toutes ses éditions & couvertures locales (0 ms).
   */
  private buildLocalAbstractOption(b: BookRow): PhotoCandidateOption | null {
    const eds = this.catalogRepo.listEditionsByBookId(b.id);
    const primaryIsbn = eds[0]?.isbn13;
    if (!primaryIsbn) return null;

    const coverOptions: PhotoCoverOption[] = [];
    const seenCoverKeys = new Set<string>();
    const pushLocalCov = (coverKey: string | null | undefined, label: string, isbn13?: string | null) => {
      if (!coverKey || seenCoverKeys.has(coverKey)) return;
      seenCoverKeys.add(coverKey);
      coverOptions.push({
        coverKey,
        coverUrl: `/api/covers/${coverKey}`,
        label,
        isbn13: isbn13 ?? null
      });
    };

    pushLocalCov(b.cover_key, 'Couverture principale (Catalogue)', primaryIsbn);
    for (const ed of eds) {
      const lbl = [ed.publisher || `Édition ${ed.isbn13}`, ed.publish_year ? `(${ed.publish_year})` : '']
        .filter(Boolean)
        .join(' ');
      pushLocalCov(ed.cover_key, lbl, ed.isbn13);
    }

    return {
      bookId: b.id,
      isbn13: primaryIsbn,
      siblingIsbns: eds.map((e) => e.isbn13),
      editionCount: Math.max(1, eds.length),
      title: b.title,
      seriesName: b.series_id ? (this.catalogRepo.findSeriesById(b.series_id)?.canonical_name ?? null) : null,
      volumeNumber: b.volume_label ?? (b.volume_number !== null ? String(b.volume_number) : null),
      authors: parseJsonStringArray(b.authors_json),
      publisher: b.publisher,
      publishYear: b.publish_year,
      coverUrl: b.cover_key ? `/api/covers/${b.cover_key}` : (coverOptions[0]?.coverUrl ?? null),
      coverOptions,
      isIntegral: b.is_integral === 1,
      includedVolumes: parseJsonStringArray(b.included_volumes_json),
      source: 'local'
    };
  }

  /**
   * Fusionne les éditions d'une même Œuvre abstraite dans la liste d'options au lieu d'exposer N rééditions redondantes.
   */
  private mergeOptionIntoAbstractList(list: PhotoCandidateOption[], incoming: PhotoCandidateOption | null): void {
    if (!incoming || !incoming.isbn13) return;
    const existing = list.find(
      (opt) =>
        opt.isbn13 === incoming.isbn13 ||
        (opt.siblingIsbns ?? []).includes(incoming.isbn13) ||
        isSameAbstractWork(opt, incoming)
    );

    if (!existing) {
      const siblings = Array.from(new Set([incoming.isbn13, ...(incoming.siblingIsbns ?? [])]));
      list.push({
        ...incoming,
        siblingIsbns: siblings,
        editionCount: Math.max(incoming.editionCount ?? 1, siblings.length),
        coverOptions: [...(incoming.coverOptions ?? [])]
      });
      return;
    }

    const mergedSiblings = Array.from(
      new Set([existing.isbn13, ...(existing.siblingIsbns ?? []), incoming.isbn13, ...(incoming.siblingIsbns ?? [])])
    );
    existing.siblingIsbns = mergedSiblings;
    existing.editionCount = Math.max(existing.editionCount ?? 1, mergedSiblings.length);
    if (!existing.bookId && incoming.bookId) existing.bookId = incoming.bookId;
    if (!existing.coverUrl && incoming.coverUrl) existing.coverUrl = incoming.coverUrl;
    if (!existing.seriesName && incoming.seriesName) existing.seriesName = incoming.seriesName;
    if (!existing.volumeNumber && incoming.volumeNumber) existing.volumeNumber = incoming.volumeNumber;
    if (!existing.publisher && incoming.publisher) existing.publisher = incoming.publisher;
    if (!existing.publishYear && incoming.publishYear) existing.publishYear = incoming.publishYear;
    if (existing.authors.length === 0 && incoming.authors.length > 0) existing.authors = [...incoming.authors];

    const existingCovs = existing.coverOptions ?? [];
    const seenUrls = new Set(existingCovs.map((c) => c.coverUrl));
    const incomingCovs: PhotoCoverOption[] =
      incoming.coverOptions && incoming.coverOptions.length > 0
        ? incoming.coverOptions
        : incoming.coverUrl
          ? [
              {
                coverKey: incoming.coverUrl.startsWith('/api/covers/')
                  ? incoming.coverUrl.slice('/api/covers/'.length)
                  : null,
                coverUrl: incoming.coverUrl,
                label: [incoming.publisher, incoming.publishYear ? `(${incoming.publishYear})` : '']
                  .filter(Boolean)
                  .join(' ') || `Édition ${incoming.isbn13}`,
                isbn13: incoming.isbn13
              }
            ]
          : [];
    for (const cov of incomingCovs) {
      if (!cov.coverUrl || seenUrls.has(cov.coverUrl)) continue;
      if (existingCovs.length >= 6) break;
      seenUrls.add(cov.coverUrl);
      existingCovs.push(cov);
    }
    existing.coverOptions = existingCovs;
  }

  /**
   * Résout en lecture seule le VRAI tome N d'une série via Wikidata + BookIdentifierService (sans polluer SQLite),
   * afin que Photo IA bénéficie de la même précision canonique que la recherche textuelle (Lot 3).
   */
  private async resolveCanonicalSeriesVolumeOption(
    seriesName: string,
    volumeNumber: number,
    authorHint?: string
  ): Promise<PhotoCandidateOption | null> {
    const cleanSeries = extractFranchiseBaseName(seriesName).baseName;
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
      return null;
    }

    if (!canonicalTitle) return null;

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
    if (isbns.length === 0) return null;

    return {
      bookId: null,
      isbn13: isbns[0],
      siblingIsbns: isbns,
      editionCount: isbns.length,
      title: canonicalTitle,
      seriesName: cleanSeries,
      volumeNumber: String(volumeNumber),
      authors: canonicalAuthors,
      publisher: null,
      publishYear: null,
      coverUrl: canonicalCover,
      coverOptions: canonicalCover
        ? [
            {
              coverKey: canonicalCover.startsWith('/api/covers/') ? canonicalCover.slice('/api/covers/'.length) : null,
              coverUrl: canonicalCover,
              label: `Édition ${isbns[0]}`,
              isbn13: isbns[0]
            }
          ]
        : [],
      isIntegral: false,
      includedVolumes: [],
      source: 'wikidata'
    };
  }

  private async resolveHintOptions(hint: {
    title?: string;
    series?: string;
    volumeNumber?: string;
    author?: string;
    publisher?: string;
    isbn?: string;
  }): Promise<PhotoCandidateOption[]> {
    const options: PhotoCandidateOption[] = [];
    const pushOpt = (opt: PhotoCandidateOption | null) => this.mergeOptionIntoAbstractList(options, opt);

    // 1. Si ISBN fourni directement -> Catalogue Central local d'abord, puis BnF
    if (hint.isbn) {
      const cleanIsbn = isbnUtil.normalizeToIsbn13(hint.isbn);
      if (cleanIsbn) {
        const localBook = this.catalogRepo.findBookByIsbn13(cleanIsbn);
        if (localBook) {
          const localOpt = this.buildLocalAbstractOption(localBook);
          if (localOpt) {
            pushOpt(localOpt);
            return options;
          }
        }
        const rec = await this.connectors.bnf.lookupByIsbn(cleanIsbn);
        if (rec) pushOpt(toOption(rec));
      }
    }

    const cleanSeries = hint.series?.trim() || '';
    const cleanTitle = hint.title?.trim() || '';
    const cleanAuthor = hint.author?.trim() || undefined;
    const normSeries = normalizeTextKey(cleanSeries);
    const normTitle = normalizeTextKey(cleanTitle);
    const normPub = hint.publisher ? normalizeTextKey(hint.publisher) : '';
    const volNumStr = normalizeSeriesNumber(hint.volumeNumber);
    const volNum = /^\d+$/.test(volNumStr) ? parseInt(volNumStr, 10) : null;
    const wantsIntegral = /\b(?:int[ée]grale|coffret|omnibus|compendium)\b/i.test(`${cleanSeries} ${cleanTitle}`);

    // 2. Recherche Catalogue Central local d'abord (0 appel réseau si l'Œuvre abstraite est déjà en base !)
    if (cleanTitle || cleanSeries) {
      const local = this.catalogRepo.searchLocalCatalog({
        titleNorm: cleanTitle ? normalizeTextKey(cleanTitle) : undefined,
        seriesNorm: cleanSeries ? normalizeTextKey(cleanSeries) : undefined,
        volumeNumber: volNum,
        authorNorm: cleanAuthor ? normalizeTextKey(cleanAuthor) : undefined,
        publisherNorm: hint.publisher ? normalizeTextKey(hint.publisher) : undefined,
        limit: 8
      });
      for (const b of local.books) {
        pushOpt(this.buildLocalAbstractOption(b));
      }

      // Court-circuit Catalogue Central si correspondance locale exacte (ex. série déjà étendue en base)
      const hintSeriesKey = extractFranchiseBaseName(cleanSeries || cleanTitle).normalizedKey;
      const hasLocalExactVolume =
        volNumStr.length > 0 &&
        options.some((o) => {
          if (o.source !== 'local' || o.isIntegral) return false;
          const optVol = normalizeSeriesNumber(o.volumeNumber);
          if (optVol !== volNumStr) return false;
          if (!hintSeriesKey) return true;
          const optSeriesKey = extractFranchiseBaseName(o.seriesName || '').normalizedKey;
          return (
            optSeriesKey === hintSeriesKey ||
            tokenOverlapRatio(cleanSeries || cleanTitle, `${o.seriesName ?? ''} ${o.title}`) >= 0.65
          );
        });
      const hasLocalExactSeriesTitle =
        Boolean(cleanSeries && cleanTitle) &&
        !isGenericVolumeTitle(cleanTitle, cleanSeries) &&
        options.some((o) => {
          if (o.source !== 'local') return false;
          const optSeriesKey = extractFranchiseBaseName(o.seriesName || '').normalizedKey;
          return (
            optSeriesKey === extractFranchiseBaseName(cleanSeries).normalizedKey &&
            tokenOverlapRatio(cleanTitle, o.title) >= 0.85
          );
        });
      const hasLocalExactStandaloneTitle =
        Boolean(cleanTitle) &&
        !cleanSeries &&
        !volNumStr &&
        normTitle.length >= 5 &&
        options.some((o) => o.source === 'local' && normalizeTextKey(o.title) === normTitle);

      if (hasLocalExactVolume || hasLocalExactSeriesTitle || hasLocalExactStandaloneTitle) {
        options.sort((a, b) => {
          if (Boolean(a.isIntegral) !== Boolean(b.isIntegral)) {
            return wantsIntegral ? (a.isIntegral ? -1 : 1) : a.isIntegral ? 1 : -1;
          }
          return (b.editionCount ?? 1) - (a.editionCount ?? 1);
        });
        return options.slice(0, 6);
      }
    }

    // 3A. Si Série + N° de tome demandé non encore en base -> résolution canonique Série->Tome (Wikidata + BookIdentifier)
    const seriesHint = cleanSeries || (volNum !== null ? cleanTitle : '');
    if (seriesHint && volNum !== null) {
      const canonicalOpt = await this.resolveCanonicalSeriesVolumeOption(seriesHint, volNum, cleanAuthor);
      if (canonicalOpt) {
        pushOpt(canonicalOpt);
      }
      if (wantsIntegral && this.connectors.bnf.searchSeriesIntegrals) {
        const integrals = await this.connectors.bnf.searchSeriesIntegrals(seriesHint, 10).catch(() => []);
        for (const it of integrals.filter((x) => (x.includedVolumes ?? []).includes(String(volNum))).slice(0, 2)) {
          if (!it.isbn13s[0]) continue;
          pushOpt({
            bookId: null,
            isbn13: it.isbn13s[0],
            siblingIsbns: it.isbn13s,
            editionCount: Math.max(1, it.isbn13s.length),
            title: it.title,
            seriesName: extractFranchiseBaseName(seriesHint).baseName,
            volumeNumber: it.volumeLabel ?? 'Intégrale',
            authors: it.authors,
            publisher: it.publisher ?? null,
            publishYear: it.publishYear ?? null,
            coverUrl: it.coverUrl ?? null,
            coverOptions: it.coverUrl
              ? [{ coverKey: null, coverUrl: it.coverUrl, label: it.publisher || 'Intégrale BnF', isbn13: it.isbn13s[0] }]
              : [],
            isIntegral: true,
            includedVolumes: it.includedVolumes ?? [],
            source: 'bnf'
          });
        }
      }
    }

    // 3B. Cascade externe progressive (BnF SRU + Inventaire.io) agrégée par Œuvre abstraite :
    //     Passe A : Série + Titre + Auteur
    //     Passe B (si < 2 options et série connue) : Série + Auteur
    //     Passe C (si 0 option et titre distinct de la série) : Titre + Auteur
    const runExternalPass = async (titleQuery: string, authorQuery?: string, bnfLimit = 10) => {
      if (!titleQuery && !authorQuery) return;
      const bnfHits = await this.connectors.bnf
        .searchByTitleAndAuthor(titleQuery, authorQuery, bnfLimit)
        .catch(() => []);
      for (const hit of bnfHits) {
        pushOpt(toOption(hit));
      }

      const bnfMatchedTargetVol = Boolean(
        volNumStr && bnfHits.some((h) => normalizeSeriesNumber(h.volumeNumber) === volNumStr)
      );
      const needsInventaireFallback =
        Boolean(titleQuery && this.connectors.inventaire.searchByText) &&
        (bnfHits.length === 0 || (Boolean(volNumStr) && !bnfMatchedTargetVol && bnfHits.length < 2));

      if (needsInventaireFallback && this.connectors.inventaire.searchByText) {
        const rawInvHits = await this.connectors.inventaire.searchByText(titleQuery, 4).catch(() => []);
        const invHits = rawInvHits.filter((hit) => {
          const candidateText = `${hit.seriesName ?? ''} ${hit.title ?? ''}`.trim();
          return tokenOverlapRatio(titleQuery, candidateText) >= 0.4;
        });
        for (const hit of invHits) {
          pushOpt(toOption(hit));
        }
      }
    };

    const combinedTitle =
      cleanSeries && cleanTitle && !normTitle.includes(normSeries)
        ? `${cleanSeries} ${cleanTitle}`
        : cleanTitle || cleanSeries;

    if (combinedTitle) {
      await runExternalPass(combinedTitle, cleanAuthor, 12);
    }

    const hasTargetVolume = Boolean(
      volNumStr && options.some((o) => !o.isIntegral && normalizeSeriesNumber(o.volumeNumber) === volNumStr)
    );
    if ((options.length < 2 || (volNumStr && !hasTargetVolume)) && cleanSeries) {
      await runExternalPass(cleanSeries, cleanAuthor, 25);
    }

    if (options.length === 0 && cleanTitle && cleanTitle !== combinedTitle) {
      await runExternalPass(cleanTitle, cleanAuthor, 12);
    }

    // Passe D (secours pseudonyme / co-auteur absent de BnF)
    const titleFallbackQuery = cleanTitle || cleanSeries;
    if (
      options.length === 0 &&
      cleanAuthor &&
      titleFallbackQuery &&
      normalizeTextKey(titleFallbackQuery).length >= 6 &&
      !isGenericVolumeTitle(titleFallbackQuery, cleanSeries)
    ) {
      await runExternalPass(titleFallbackQuery, undefined, 10);
    }

    // Scoring déterministe pour placer la meilleure Œuvre abstraite en #1
    const scoreOption = (opt: PhotoCandidateOption): number => {
      let score = 0;
      const optVol = normalizeSeriesNumber(opt.volumeNumber);
      if (volNumStr) {
        if (!opt.isIntegral && optVol && optVol === volNumStr) score += 55;
        else if (opt.isIntegral && (opt.includedVolumes ?? []).includes(volNumStr)) score += wantsIntegral ? 65 : 25;
        else if (optVol && optVol !== volNumStr) score -= 25;
        else if (new RegExp(`\\b${volNumStr}\\b`).test(opt.title)) score += 20;
      }
      if (cleanTitle) {
        score += Math.round(tokenOverlapRatio(cleanTitle, `${opt.seriesName ?? ''} ${opt.title}`) * 30);
      }
      if (cleanSeries) {
        score += Math.round(tokenOverlapRatio(cleanSeries, `${opt.seriesName ?? ''} ${opt.title}`) * 20);
      }
      if (normPub && opt.publisher && normalizeTextKey(opt.publisher).includes(normPub)) {
        score += 15;
      }
      if (cleanAuthor && opt.authors.some((a) => matchesAuthorName(a, cleanAuthor))) {
        score += 10;
      }
      if (opt.source === 'local') score += 8;
      if (opt.source === 'wikidata') score += 6;
      if ((opt.editionCount ?? 1) > 1) score += Math.min(8, (opt.editionCount ?? 1) * 2);
      return score;
    };

    options.sort((a, b) => scoreOption(b) - scoreOption(a));

    const topOptions = options.slice(0, 6);

    // 4. Enrichissement couverture WebP locale (/api/covers/...) + déduplication visuelle des coverOptions directes pour les 4 premières œuvres
    await Promise.allSettled(
      topOptions.slice(0, 4).map(async (opt) => {
        if (opt.source === 'local' && opt.coverUrl?.startsWith('/api/covers/')) return;

        const existingBook = this.catalogRepo.findBookByIsbn13(opt.isbn13);
        if (existingBook) {
          opt.bookId = existingBook.id;
          if (existingBook.cover_key) {
            opt.coverUrl = `/api/covers/${existingBook.cover_key}`;
          }
        }

        // Convertit les couvertures directes des éditions regroupées en WebP + déduplication par coverKey & dHash
        const rawCoverOptions = opt.coverOptions ?? [];
        const resolvedCoverOptions: PhotoCoverOption[] = [];
        const seenKeys = new Set<string>();
        const seenHashes: string[] = [];

        for (const cov of rawCoverOptions.slice(0, 4)) {
          let coverKey = cov.coverKey;
          let coverUrl = cov.coverUrl;
          if (!coverKey && coverUrl.startsWith('/api/covers/')) {
            coverKey = coverUrl.slice('/api/covers/'.length);
          } else if (!coverKey && (coverUrl.startsWith('http://') || coverUrl.startsWith('https://'))) {
            const stored = await this.coverService.ingestFromExternalUrl(coverUrl, { minBytes: 500 });
            if (stored) {
              coverKey = stored.coverKey;
              coverUrl = stored.coverUrl;
            }
          }
          if (!coverKey) continue;
          if (seenKeys.has(coverKey)) continue;

          // Déduplication perceptuelle rapide sur le WebP local
          const bin = await this.coverService.readCoverBinary(coverKey);
          if (bin) {
            const meta = await this.coverService.computeBufferVisualMeta(bin.buffer);
            if (meta) {
              if (seenHashes.some((h) => hammingDistanceHex(h, meta.hash) <= 8)) {
                continue;
              }
              seenHashes.push(meta.hash);
            }
          }

          seenKeys.add(coverKey);
          resolvedCoverOptions.push({
            coverKey,
            coverUrl,
            label: cov.label,
            isbn13: cov.isbn13 ?? opt.isbn13
          });
        }

        if (resolvedCoverOptions.length > 0) {
          opt.coverOptions = resolvedCoverOptions;
          if (!opt.coverUrl || !opt.coverUrl.startsWith('/api/covers/')) {
            opt.coverUrl = resolvedCoverOptions[0].coverUrl;
          }
          return;
        }

        if (opt.coverUrl && opt.coverUrl.startsWith('/api/covers/')) {
          const key = opt.coverUrl.slice('/api/covers/'.length);
          opt.coverOptions = [
            {
              coverKey: key,
              coverUrl: opt.coverUrl,
              label: opt.publisher || `Édition ${opt.isbn13}`,
              isbn13: opt.isbn13
            }
          ];
          return;
        }

        const stored = await this.coverService.resolveBestCoverFromCascade({
          isbn13: opt.isbn13,
          candidateUrls: opt.coverUrl ? [opt.coverUrl] : [],
          skipTitleFallback: true
        });
        if (stored) {
          opt.coverUrl = stored.coverUrl;
          opt.coverOptions = [
            {
              coverKey: stored.coverKey,
              coverUrl: stored.coverUrl,
              label: opt.publisher || `Édition ${opt.isbn13}`,
              isbn13: opt.isbn13
            }
          ];
        }
      })
    );

    return topOptions;
  }

  /**
   * Crée un job Photo IA sur le serveur (vérifie et décrémente le quota mensuel).
   */
  async createPhotoJob(input: {
    userId: string;
    libraryId: string;
    isAdmin: boolean;
    mode: 'shelf' | 'cover';
    imageDataUrl: string;
    mimeType: string;
  }): Promise<{ job: BackgroundJobView; quota: { monthKey: string; used: number; limit: number; remaining: number } }> {
    if (!this.gemini.isConfigured()) {
      throw new AppError(503, 'GEMINI_NOT_CONFIGURED', 'Le service Photo IA n’est pas configuré sur le serveur.');
    }

    const monthKey = currentMonthKey();
    const limit = this.config.monthlyAiQuota;
    const currentUsage = this.userRepo.getAiUsage(input.userId);
    const currentUsed = currentUsage && currentUsage.month_key === monthKey ? currentUsage.month_used : 0;

    if (!input.isAdmin && currentUsed >= limit) {
      throw new AppError(429, 'AI_QUOTA_EXCEEDED', `Quota mensuel Photo IA atteint (${limit}/${limit}).`);
    }

    const now = new Date().toISOString();

    // Compresse la photo d'étagère en WebP haute définition (1800 px) sur disque (/data/covers/) — zéro image base64 dans SQLite
    const storedPreview = await this.coverService.storePreviewDataUrlAsWebp(input.imageDataUrl);
    const previewCoverKey = storedPreview.coverKey;

    const updatedUsage = this.userRepo.incrementAiUsage(input.userId, monthKey, now);

    const row = this.jobRepo.createJob({
      id: generateId('pjob'),
      type: 'photo_ocr',
      userId: input.userId,
      libraryId: input.libraryId,
      payload: {
        mode: input.mode,
        mimeType: 'image/webp',
        previewCoverKey
      },
      progressTotal: 1,
      now
    });

    this.onJobChanged?.(row);

    return {
      job: mapJobRowToView(row),
      quota: {
        monthKey,
        used: updatedUsage.month_used,
        limit,
        remaining: Math.max(0, limit - updatedUsage.month_used)
      }
    };
  }

  /**
   * Exécution serveur dans le BackgroundWorker : OCR Gemini -> Résolution BnF -> Statuts Foyer -> Mise à jour SSE.
   */
  async executePhotoOcrJob(ctx: JobHandlerContext): Promise<{ result: PhotoJobResultPayload; total: number }> {
    const mode = ctx.payload.mode === 'cover' ? 'cover' : 'shelf';
    let imageDataUrl = typeof ctx.payload.imageDataUrl === 'string' ? ctx.payload.imageDataUrl : '';
    let mimeType = typeof ctx.payload.mimeType === 'string' ? ctx.payload.mimeType : 'image/webp';
    const previewCoverKey = typeof ctx.payload.previewCoverKey === 'string' ? ctx.payload.previewCoverKey : null;
    const libraryId = ctx.job.library_id ?? '';

    if (!imageDataUrl && previewCoverKey) {
      const storedBin = await this.coverService.readCoverBinary(previewCoverKey);
      if (!storedBin) {
        throw new AppError(400, 'PHOTO_IMAGE_MISSING', "L'image de cette analyse n'est plus disponible : reprenez une photo.");
      }
      mimeType = storedBin.mimeType;
      imageDataUrl = `data:${storedBin.mimeType};base64,${storedBin.buffer.toString('base64')}`;
    }

    const hints = await this.gemini.extractBooksFromImage({ imageDataUrl, mimeType, mode });
    const total = Math.max(1, hints.length);
    const items: PhotoJobItem[] = [];

    const mergeSavedArbitrations = () => {
      const latestRow = this.jobRepo.findJobById(ctx.job.id);
      if (!latestRow?.result_json) return;
      const savedItems = this.parseResult(latestRow).items;
      if (savedItems.length === 0) return;
      const savedById = new Map(savedItems.map((it) => [it.id, it]));
      for (let idx = 0; idx < items.length; idx++) {
        const persisted = savedById.get(items[idx].id);
        if (persisted) {
          // Conserve les choix déjà enregistrés par l'utilisateur pendant l'analyse en cours (édition choisie, sélection, relance BnF, intégrale)
          items[idx] = { ...items[idx], ...persisted };
        }
      }
    };

    const buildPayload = (): PhotoJobResultPayload => {
      mergeSavedArbitrations();
      return {
        mode,
        previewCoverKey,
        previewUrl: previewCoverKey ? `/api/covers/${previewCoverKey}` : null,
        items: [...items]
      };
    };

    ctx.reportProgress(0, total, buildPayload());

    for (let i = 0; i < hints.length; i++) {
      const hint = hints[i];
      const options = await this.resolveHintOptions(hint);
      const bestOpt = options[0] ?? null;
      const bestIsbn = bestOpt?.isbn13 ?? null;
      const alreadyStatus = bestIsbn && libraryId ? this.lookupFoyerOwnershipForOption(libraryId, bestOpt, bestIsbn) : 'none';

      let status: PhotoJobItem['status'] = 'unresolved';
      if (options.length === 1 && hint.confidence === 'high') {
        status = 'identified';
      } else if (options.length >= 1) {
        status = hint.confidence === 'high' ? 'identified' : 'doubt';
      }

      // Pour les éléments non identifiés (0 option ISBN), tenter une couverture indicative par titre + auteur
      let fallbackCoverUrl: string | null = null;
      if (options.length === 0 && hint.title) {
        const storedHintCover = await this.coverService.resolveBestCoverFromCascade({
          title: [hint.series, hint.title].filter(Boolean).join(' '),
          author: hint.author
        });
        if (storedHintCover) {
          fallbackCoverUrl = storedHintCover.coverUrl;
        }
      }

      items.push({
        id: generateId('pit'),
        spineIndex: hint.spineIndex ?? i + 1,
        totalSpines: hints.length,
        hint,
        status,
        options,
        fallbackCoverUrl,
        selectedOptionIsbn13: bestIsbn,
        selectedCoverKey: null,
        selectedCoverUrl: null,
        selected: status === 'identified' && alreadyStatus === 'none',
        ignored: false,
        alreadyStatus,
        isIntegral: Boolean(bestOpt?.isIntegral),
        includedVolumes: bestOpt?.isIntegral ? [...(bestOpt.includedVolumes ?? [])] : [],
        committedBookId: null
      });

      ctx.reportProgress(i + 1, total, buildPayload());
    }

    return { result: buildPayload(), total };
  }

  /**
   * Charge à la demande (au clic dans la modale Photo IA) les couvertures multi-éditions visuellement dédupliquées (`dHash`).
   * - Si l'œuvre est déjà dans le Catalogue Central : couvertures locales en 0 ms (+ externes dédupliquées si refresh ou < 2).
   * - Si œuvre nouvelle : consensus multi-éditions `dHash` (max 4 éditions, ~1 s) puis mise en cache sur l'item.
   */
  async listItemCoverOptions(input: {
    userId: string;
    libraryId: string;
    jobId: string;
    itemId: string;
    isbn13?: string;
    refreshExternal?: boolean;
  }): Promise<{ covers: PhotoCoverOption[]; job: BackgroundJobView }> {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);
    const item = result.items.find((it) => it.id === input.itemId);
    if (!item) {
      throw new AppError(404, 'PHOTO_ITEM_NOT_FOUND', 'Élément Photo IA introuvable.');
    }

    const targetIsbn = input.isbn13 || item.selectedOptionIsbn13;
    const option =
      item.options.find(
        (o) => o.isbn13 === targetIsbn || (targetIsbn ? (o.siblingIsbns ?? []).includes(targetIsbn) : false)
      ) ?? item.options[0];

    if (!option) {
      return { covers: [], job: mapJobRowToView(row) };
    }

    const mergedCovers: PhotoCoverOption[] = [];
    const seenUrls = new Set<string>();
    const seenKeys = new Set<string>();
    const pushCover = (cov: PhotoCoverOption) => {
      if (!cov.coverUrl || seenUrls.has(cov.coverUrl)) return;
      if (cov.coverKey && seenKeys.has(cov.coverKey)) return;
      seenUrls.add(cov.coverUrl);
      if (cov.coverKey) seenKeys.add(cov.coverKey);
      mergedCovers.push(cov);
    };

    for (const existingCov of option.coverOptions ?? []) {
      pushCover(existingCov);
    }
    if (option.coverUrl && option.coverUrl.startsWith('/api/covers/')) {
      pushCover({
        coverKey: option.coverUrl.slice('/api/covers/'.length),
        coverUrl: option.coverUrl,
        label: option.publisher || `Édition ${option.isbn13}`,
        isbn13: option.isbn13
      });
    }

    // Cas 1 : l'œuvre existe déjà dans le Catalogue Central -> utiliser listBookCoverCandidates (local 0 ms + dHash externe)
    const existingBook =
      (option.bookId ? this.catalogRepo.findBookById(option.bookId) : null) ??
      this.catalogRepo.findBookByIsbn13(option.isbn13);

    if (existingBook) {
      option.bookId = existingBook.id;
      const includeExternal = Boolean(input.refreshExternal || mergedCovers.length < 2);
      const candidates = await this.libraryService.listBookCoverCandidates(
        input.libraryId,
        existingBook.id,
        includeExternal
      );
      for (const cand of candidates) {
        pushCover({
          coverKey: cand.kind === 'local' ? (cand.coverKey ?? null) : null,
          coverUrl: cand.url,
          label: cand.label,
          isbn13: option.isbn13
        });
      }
    } else if (input.refreshExternal || mergedCovers.length < 2) {
      // Cas 2 : nouvelle œuvre externe -> consensus multi-éditions dHash (jusqu'à 4 ISBNs)
      const isbnPool = new Set<string>([option.isbn13, ...(option.siblingIsbns ?? [])]);
      if (isbnPool.size < 2 && option.seriesName && option.volumeNumber) {
        const parsedVol = parseInt(normalizeSeriesNumber(option.volumeNumber), 10);
        if (Number.isFinite(parsedVol) && parsedVol > 0) {
          const extraIsbns = await this.bookIdentifier
            .findRankedIsbnsForSeriesVolume(
              {
                seriesName: option.seriesName,
                title: option.title,
                volumeNumber: parsedVol,
                authors: option.authors,
                mediaFamily: 'neutral',
                isIntegral: Boolean(option.isIntegral)
              },
              4
            )
            .catch(() => []);
          for (const extra of extraIsbns) isbnPool.add(extra);
        }
      }

      const allIsbns = Array.from(isbnPool).slice(0, 4);
      option.siblingIsbns = Array.from(new Set([...(option.siblingIsbns ?? []), ...allIsbns]));
      option.editionCount = Math.max(option.editionCount ?? 1, option.siblingIsbns.length);

      const externalUrls = [option.coverUrl, ...(option.coverOptions ?? []).map((c) => c.coverUrl)].filter(
        (u): u is string => Boolean(u && (u.startsWith('http://') || u.startsWith('https://')))
      );

      const consensus = await this.coverService.electBestCoverFromMultiEditions({
        isbn13s: allIsbns,
        candidateUrls: externalUrls,
        maxEditions: 4,
        maxDistinctStored: 4
      });

      // Dédupliquer visuellement contre les couvertures déjà présentes
      const existingHashes: string[] = [];
      for (const cov of mergedCovers) {
        if (!cov.coverKey) continue;
        const bin = await this.coverService.readCoverBinary(cov.coverKey);
        if (!bin) continue;
        const meta = await this.coverService.computeBufferVisualMeta(bin.buffer);
        if (meta) existingHashes.push(meta.hash);
      }

      for (const entry of consensus.distinctCovers) {
        if (seenKeys.has(entry.cover.coverKey)) continue;
        const bin = await this.coverService.readCoverBinary(entry.cover.coverKey);
        if (bin && existingHashes.length > 0) {
          const meta = await this.coverService.computeBufferVisualMeta(bin.buffer);
          if (meta) {
            if (existingHashes.some((h) => hammingDistanceHex(h, meta.hash) <= 8)) {
              continue;
            }
            existingHashes.push(meta.hash);
          }
        }
        pushCover({
          coverKey: entry.cover.coverKey,
          coverUrl: entry.cover.coverUrl,
          label: entry.sourceIsbn ? `Édition ${entry.sourceIsbn}` : 'Édition alternative',
          isbn13: entry.sourceIsbn ?? option.isbn13
        });
      }
    }

    option.coverOptions = mergedCovers.slice(0, 8);
    if (!option.coverUrl && option.coverOptions[0]) {
      option.coverUrl = option.coverOptions[0].coverUrl;
    }

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(row.id, row.progress_done, row.progress_total, now, result);
    const updated = this.jobRepo.findJobById(row.id)!;
    this.onJobChanged?.(updated);

    return {
      covers: option.coverOptions,
      job: mapJobRowToView(updated)
    };
  }

  /**
   * Persiste sur le serveur l'arbitrage d'un item (sélection, œuvre/édition choisie, couverture Couche 3, intégrale, ignoré).
   */
  updateItemArbitration(input: {
    userId: string;
    libraryId: string;
    jobId: string;
    itemId: string;
    patch: {
      selected?: boolean;
      ignored?: boolean;
      selectedOptionIsbn13?: string | null;
      selectedCoverKey?: string | null;
      selectedCoverUrl?: string | null;
      isIntegral?: boolean;
      includedVolumes?: string[];
    };
  }): BackgroundJobView {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);
    const item = result.items.find((it) => it.id === input.itemId);
    if (!item) {
      throw new AppError(404, 'PHOTO_ITEM_NOT_FOUND', 'Élément Photo IA introuvable.');
    }

    if (input.patch.selected !== undefined) item.selected = input.patch.selected;
    if (input.patch.ignored !== undefined) {
      item.ignored = input.patch.ignored;
      if (item.ignored) item.selected = false;
    }
    if (input.patch.selectedOptionIsbn13 !== undefined) {
      const prevIsbn = item.selectedOptionIsbn13;
      item.selectedOptionIsbn13 = input.patch.selectedOptionIsbn13;
      if (item.selectedOptionIsbn13) {
        const matchedOpt = item.options.find(
          (o) =>
            o.isbn13 === item.selectedOptionIsbn13 ||
            (o.siblingIsbns ?? []).includes(item.selectedOptionIsbn13!)
        );
        item.alreadyStatus = this.lookupFoyerOwnershipForOption(
          input.libraryId,
          matchedOpt,
          item.selectedOptionIsbn13
        );
        // Si l'appelant sélectionne un ISBN frère précis qui a sa propre couverture dans coverOptions, la pré-sélectionner
        const matchingEditionCov = matchedOpt?.coverOptions?.find((c) => c.isbn13 === item.selectedOptionIsbn13);
        if (
          matchingEditionCov &&
          input.patch.selectedCoverKey === undefined &&
          input.patch.selectedCoverUrl === undefined
        ) {
          item.selectedCoverKey = matchingEditionCov.coverKey;
          item.selectedCoverUrl = matchingEditionCov.coverUrl;
        } else if (
          prevIsbn !== item.selectedOptionIsbn13 &&
          input.patch.selectedCoverKey === undefined &&
          input.patch.selectedCoverUrl === undefined
        ) {
          item.selectedCoverKey = null;
          item.selectedCoverUrl = null;
        }
        if (matchedOpt?.isIntegral && input.patch.isIntegral === undefined) {
          item.isIntegral = true;
          item.includedVolumes = [...(matchedOpt.includedVolumes ?? [])];
        }
      }
    }
    if (input.patch.selectedCoverKey !== undefined) {
      item.selectedCoverKey = input.patch.selectedCoverKey;
      if (input.patch.selectedCoverKey && input.patch.selectedCoverUrl === undefined) {
        item.selectedCoverUrl = `/api/covers/${input.patch.selectedCoverKey}`;
      }
    }
    if (input.patch.selectedCoverUrl !== undefined) {
      item.selectedCoverUrl = input.patch.selectedCoverUrl;
      if (
        input.patch.selectedCoverUrl &&
        input.patch.selectedCoverUrl.startsWith('/api/covers/') &&
        input.patch.selectedCoverKey === undefined
      ) {
        item.selectedCoverKey = input.patch.selectedCoverUrl.slice('/api/covers/'.length);
      } else if (!input.patch.selectedCoverUrl && input.patch.selectedCoverKey === undefined) {
        item.selectedCoverKey = null;
      }
    }
    if (input.patch.isIntegral !== undefined) {
      item.isIntegral = input.patch.isIntegral;
      if (!item.isIntegral) item.includedVolumes = [];
    }
    if (input.patch.includedVolumes !== undefined) {
      item.includedVolumes = parseIncludedVolumeNumbers(input.patch.includedVolumes);
    }

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(row.id, row.progress_done, row.progress_total, now, result);
    const updated = this.jobRepo.findJobById(row.id)!;
    this.onJobChanged?.(updated);
    return mapJobRowToView(updated);
  }

  /**
   * Relance BnF ciblée 100 % côté serveur à partir des 6 champs manuels de la sous-modale Photo IA.
   */
  async retryItemBnf(input: {
    userId: string;
    libraryId: string;
    jobId: string;
    itemId: string;
    hints: {
      title?: string;
      series?: string;
      volumeNumber?: string;
      author?: string;
      publisher?: string;
      isbn?: string;
    };
  }): Promise<{ job: BackgroundJobView; item: PhotoJobItem }> {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);
    const item = result.items.find((it) => it.id === input.itemId);
    if (!item) {
      throw new AppError(404, 'PHOTO_ITEM_NOT_FOUND', 'Élément Photo IA introuvable.');
    }

    const options = await this.resolveHintOptions(input.hints);
    const bestOpt = options[0] ?? null;
    item.options = options;
    item.selectedOptionIsbn13 = bestOpt?.isbn13 ?? null;
    item.selectedCoverKey = null;
    item.selectedCoverUrl = null;
    item.status = options.length === 1 ? 'identified' : options.length > 1 ? 'doubt' : 'unresolved';
    item.ignored = false;
    item.alreadyStatus = item.selectedOptionIsbn13
      ? this.lookupFoyerOwnershipForOption(input.libraryId, bestOpt, item.selectedOptionIsbn13)
      : 'none';
    item.selected = options.length > 0 && item.alreadyStatus === 'none';
    item.isIntegral = Boolean(bestOpt?.isIntegral);
    item.includedVolumes = bestOpt?.isIntegral ? [...(bestOpt.includedVolumes ?? [])] : [];

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(row.id, row.progress_done, row.progress_total, now, result);
    const updated = this.jobRepo.findJobById(row.id)!;
    this.onJobChanged?.(updated);
    return { job: mapJobRowToView(updated), item };
  }

  async retryFailedItems(input: { userId: string; libraryId: string; jobId: string }): Promise<BackgroundJobView> {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);

    for (const item of result.items) {
      if (item.status !== 'unresolved' || item.ignored) continue;
      const options = await this.resolveHintOptions(item.hint);
      if (options.length > 0) {
        item.options = options;
        item.selectedOptionIsbn13 = options[0].isbn13;
        item.selectedCoverKey = null;
        item.selectedCoverUrl = null;
        item.status = options.length === 1 ? 'identified' : 'doubt';
        item.alreadyStatus = this.lookupFoyerOwnershipForOption(input.libraryId, options[0], options[0].isbn13);
        item.selected = item.alreadyStatus === 'none';
        item.isIntegral = Boolean(options[0].isIntegral);
        item.includedVolumes = options[0].isIntegral ? [...(options[0].includedVolumes ?? [])] : [];
      }
    }

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(row.id, row.progress_done, row.progress_total, now, result);
    const updated = this.jobRepo.findJobById(row.id)!;
    this.onJobChanged?.(updated);
    return mapJobRowToView(updated);
  }

  /**
   * Recherche publique réutilisable (utilisée par Photo IA et par "Ce n'est pas le bon livre" sur une fiche).
   */
  async searchBookCandidates(hints: {
    title?: string;
    series?: string;
    volumeNumber?: string;
    author?: string;
    publisher?: string;
    isbn?: string;
  }): Promise<PhotoCandidateOption[]> {
    return this.resolveHintOptions(hints);
  }

  /**
   * Valide les items cochés du lot Photo IA vers la Collection (`owned`) ou la Wishlist (`wish`).
   * Exécution parallélisée par lots de 4 (rapide), ou en tâche de fond `photo_commit` pour les gros lots (> 3 livres ou async=true).
   */
  async commitJobItems(input: {
    userId: string;
    libraryId: string;
    jobId: string;
    targetStatus: 'owned' | 'wish';
    itemIds?: string[];
    async?: boolean;
  }): Promise<{
    committedCount: number;
    queued: boolean;
    targetCount: number;
    commitJob?: BackgroundJobView;
    job: BackgroundJobView;
  }> {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);

    const targets = result.items.filter((it) => {
      if (it.ignored || !it.selectedOptionIsbn13) return false;
      if (input.itemIds && input.itemIds.length > 0) return input.itemIds.includes(it.id);
      return it.selected;
    });

    // Pour les lots > 3 livres (ou demande explicite async), confier au BackgroundWorker existant -> réponse immédiate (< 50 ms, zéro timeout)
    if (targets.length > 0 && (input.async || targets.length > 3)) {
      const now = new Date().toISOString();
      const commitRow = this.jobRepo.createJob({
        id: generateId('pcom'),
        type: 'photo_commit',
        userId: input.userId,
        libraryId: input.libraryId,
        payload: {
          photoJobId: row.id,
          targetStatus: input.targetStatus,
          itemIds: targets.map((t) => t.id)
        },
        progressTotal: targets.length,
        now
      });
      this.onJobChanged?.(commitRow);
      return {
        committedCount: 0,
        queued: true,
        targetCount: targets.length,
        commitJob: mapJobRowToView(commitRow),
        job: mapJobRowToView(row)
      };
    }

    const { committedCount, updatedJob } = await this.commitTargetsWithConcurrency({
      row,
      result,
      targets,
      userId: input.userId,
      libraryId: input.libraryId,
      targetStatus: input.targetStatus
    });

    return {
      committedCount,
      queued: false,
      targetCount: targets.length,
      job: updatedJob
    };
  }

  /**
   * Handler BackgroundWorker pour `photo_commit` (concurrence 4, progression temps réel SSE).
   */
  async executePhotoCommitJob(ctx: JobHandlerContext): Promise<{ result: { photoJobId: string; committedCount: number }; total: number }> {
    const photoJobId = typeof ctx.payload.photoJobId === 'string' ? ctx.payload.photoJobId : '';
    const targetStatus: 'owned' | 'wish' = ctx.payload.targetStatus === 'wish' ? 'wish' : 'owned';
    const itemIds = Array.isArray(ctx.payload.itemIds)
      ? ctx.payload.itemIds.filter((x): x is string => typeof x === 'string')
      : [];
    const userId = ctx.job.user_id ?? '';
    const libraryId = ctx.job.library_id ?? '';

    const row = this.assertOwnedJob(photoJobId, userId, libraryId);
    const result = this.parseResult(row);
    const targets = result.items.filter((it) => {
      if (it.ignored || !it.selectedOptionIsbn13) return false;
      if (itemIds.length > 0) return itemIds.includes(it.id);
      return it.selected;
    });

    const total = Math.max(1, targets.length);
    ctx.reportProgress(0, total, { photoJobId, committedCount: 0 });

    const { committedCount } = await this.commitTargetsWithConcurrency({
      row,
      result,
      targets,
      userId,
      libraryId,
      targetStatus,
      onItemDone: (done, committed) => {
        ctx.reportProgress(done, total, { photoJobId, committedCount: committed });
      }
    });

    return {
      result: { photoJobId, committedCount },
      total
    };
  }

  private async commitTargetsWithConcurrency(params: {
    row: BackgroundJobRow;
    result: PhotoJobResultPayload;
    targets: PhotoJobItem[];
    userId: string;
    libraryId: string;
    targetStatus: 'owned' | 'wish';
    onItemDone?: (doneCount: number, committedCount: number) => void;
  }): Promise<{ committedCount: number; updatedJob: BackgroundJobView }> {
    let committedCount = 0;
    let doneCount = 0;
    const CONCURRENCY = 4;

    for (let i = 0; i < params.targets.length; i += CONCURRENCY) {
      const batch = params.targets.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (item) => {
          if (!item.selectedOptionIsbn13) return;
          try {
            const chosenOption =
              item.options.find(
                (o) =>
                  o.isbn13 === item.selectedOptionIsbn13 ||
                  (o.siblingIsbns ?? []).includes(item.selectedOptionIsbn13!)
              ) ?? null;

            const resolved = await this.ingestionService.resolveIsbns({
              rawIsbns: [item.selectedOptionIsbn13],
              channel: 'photo_ai',
              action: params.targetStatus,
              userId: params.userId,
              libraryId: params.libraryId
            });

            const book = resolved.results[0]?.book;
            if (book) {
              // Enregistre les ISBN frères découverts lors du regroupement d'Œuvre abstraite dans le Catalogue Central
              const nowIso = new Date().toISOString();
              for (const sibIsbn of chosenOption?.siblingIsbns ?? []) {
                if (!sibIsbn || sibIsbn === item.selectedOptionIsbn13) continue;
                if (this.catalogRepo.findEditionByIsbn13(sibIsbn)) continue;
                const sibCov = chosenOption?.coverOptions?.find((c) => c.isbn13 === sibIsbn);
                this.catalogRepo.upsertBookEdition({
                  isbn13: sibIsbn,
                  bookId: book.id,
                  publisher: null,
                  collectionName: null,
                  publishYear: null,
                  pageCount: null,
                  coverKey: sibCov?.coverKey ?? null,
                  source: chosenOption?.source ?? 'photo_ai',
                  now: nowIso
                });
              }

              // Résolution de la couverture choisie par l'utilisateur -> Couche 3 Foyer (souveraine)
              let chosenCoverKey: string | null = null;
              let explicitCoverChoice = false;

              if (item.selectedCoverKey) {
                chosenCoverKey = item.selectedCoverKey;
                explicitCoverChoice = true;
              } else if (item.selectedCoverUrl) {
                if (item.selectedCoverUrl.startsWith('/api/covers/')) {
                  chosenCoverKey = item.selectedCoverUrl.slice('/api/covers/'.length);
                  explicitCoverChoice = true;
                } else {
                  const stored = await this.coverService.ingestFromExternalUrl(item.selectedCoverUrl);
                  if (stored) {
                    chosenCoverKey = stored.coverKey;
                    explicitCoverChoice = true;
                  }
                }
              }

              if (!chosenCoverKey) {
                const matchedCov = chosenOption?.coverOptions?.find((c) => c.isbn13 === item.selectedOptionIsbn13);
                if (matchedCov?.coverKey) {
                  chosenCoverKey = matchedCov.coverKey;
                } else if (chosenOption?.coverUrl?.startsWith('/api/covers/')) {
                  chosenCoverKey = chosenOption.coverUrl.slice('/api/covers/'.length);
                } else if (chosenOption?.coverUrl) {
                  const stored = await this.coverService.ingestFromExternalUrl(chosenOption.coverUrl);
                  if (stored) chosenCoverKey = stored.coverKey;
                } else {
                  const edRow = this.catalogRepo.findEditionByIsbn13(item.selectedOptionIsbn13);
                  if (edRow?.cover_key) chosenCoverKey = edRow.cover_key;
                }
              }

              const userPickedAlternateEdition =
                Boolean(item.options[0]?.isbn13) && item.selectedOptionIsbn13 !== item.options[0].isbn13;
              const overridePatch: {
                isIntegral?: boolean;
                includedVolumes?: string[];
                coverKey?: string;
              } = {};
              if (item.isIntegral) {
                overridePatch.isIntegral = true;
                overridePatch.includedVolumes = item.includedVolumes;
              }
              if (
                chosenCoverKey &&
                (explicitCoverChoice || (chosenCoverKey !== book.coverKey && (userPickedAlternateEdition || !book.coverKey)))
              ) {
                overridePatch.coverKey = chosenCoverKey;
              }
              if (Object.keys(overridePatch).length > 0) {
                this.libraryService.updateBookOverrides(params.libraryId, params.userId, book.id, overridePatch);
              }
              item.committedBookId = book.id;
              item.alreadyStatus = params.targetStatus;
              item.selected = false;
              committedCount++;
            }
          } finally {
            doneCount++;
            params.onItemDone?.(doneCount, committedCount);
          }
        })
      );
    }

    const now = new Date().toISOString();
    this.jobRepo.updateJobProgress(params.row.id, params.row.progress_done, params.row.progress_total, now, params.result);
    const updated = this.jobRepo.findJobById(params.row.id)!;
    this.onJobChanged?.(updated);

    return { committedCount, updatedJob: mapJobRowToView(updated) };
  }

  /**
   * Relance l'analyse OCR Gemini d'un job Photo IA en erreur sans re-décompter le quota utilisateur.
   */
  retryOcrJob(input: { userId: string; libraryId: string; jobId: string }): BackgroundJobView {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload_json || '{}') as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const hasDiskImage = typeof payload.previewCoverKey === 'string' && payload.previewCoverKey.length > 0;
    const hasLegacyInlineImage = typeof payload.imageDataUrl === 'string' && payload.imageDataUrl.length > 0;
    if (!hasDiskImage && !hasLegacyInlineImage) {
      throw new AppError(400, 'PHOTO_IMAGE_MISSING', "L'image de cette analyse n'est plus disponible : reprenez une photo.");
    }
    const requeued = this.jobRepo.requeueJob(row.id, new Date().toISOString())!;
    this.onJobChanged?.(requeued);
    return mapJobRowToView(requeued);
  }

  deletePhotoJob(input: { userId: string; libraryId: string; jobId: string }): void {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    this.jobRepo.deleteJob(row.id);
  }
}
