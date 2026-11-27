// src/server/services/photo-ai.service.ts
// Service Photo IA 100 % Serveur : quota mensuel, OCR Gemini, résolution BnF, arbitrage persisté, relance BnF serveur & validation lot.

import crypto from 'node:crypto';
import { classifyBookMetadata } from '../../shared/bibliographic/category-classifier';
import { hammingDistanceHex } from '../../shared/bibliographic/cover-dhash.util';
import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import { parseIncludedVolumeNumbers } from '../../shared/bibliographic/integral.util';
import {
  buildOmniboxSplitCandidates,
  parseSearchIntent,
  stripGenericRelevanceWords,
  type RequestedMediaHint
} from '../../shared/bibliographic/search-query.util';
import {
  cleanTitle,
  extractAuthorLastNameForQuery,
  extractFranchiseBaseName,
  getLevenshteinDistance,
  isGenericVolumeTitle,
  isLatinScriptLabel,
  matchesAuthorName,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../shared/bibliographic/text-normalize.util';
import type { BackgroundJobView, BookMainCategory, OwnershipStatus } from '../../shared/types/domain.types';
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
  collectionName?: string | null;
  publishYear: string | null;
  coverUrl: string | null;
  coverOptions?: PhotoCoverOption[];
  isIntegral?: boolean;
  includedVolumes?: string[];
  mainCategory?: BookMainCategory;
  language?: string | null;
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
  committedAction?: 'owned' | 'wish' | null;
  approximateMatch?: boolean;
}

export interface PhotoJobResultPayload {
  mode: 'auto' | 'shelf' | 'cover';
  previewCoverKey: string | null;
  previewUrl: string | null;
  notifyOnComplete?: boolean;
  committedAt?: string | null;
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

const DERIVATIVE_GUIDE_RE =
  /^(?:les\s+mondes\s+(?:magiques\s+)?d[e'’]|guide\s+(?:officiel|complet|de\s+lecture|pratique)?\s*d[e'’]|analyse\s+d[e'’]|commentaire\s+d[e'’]|autour\s+d[e'’]|dossier\s+|fiche\s+de\s+lecture|r[ée]sum[ée]\s+(?:complet\s+)?d[e'’]|profil\s+d['’]une\s+œuvre)/i;

const CLUB_OR_ABRIDGED_PUBLISHER_RE =
  /\b(france\s+loisirs|le\s+grand\s+livre\s+du\s+mois|s[ée]lection\s+du\s+reader|lire\s+c['’]est\s+partir|books\s+on\s+demand|bod\b|[ée]dilivre|edilivre|createspace|independently\s+published|hachette\s+bnf)\b/i;

function isTiltedSpineHint(hint: GeminiExtractedBookHint | undefined): boolean {
  if (!hint) return false;
  if (hint.tilt === 'lean_left' || hint.tilt === 'lean_right') return true;
  if (typeof hint.topX === 'number' && typeof hint.bottomX === 'number') {
    return Math.abs(hint.topX - hint.bottomX) >= 35;
  }
  return false;
}

function getOptionMediaBucket(cat?: BookMainCategory): RequestedMediaHint | null {
  if (!cat || cat === 'Autre') return null;
  if (cat === 'BD' || cat === 'Manga' || cat === 'Comics') return cat;
  if (cat === 'Roman' || cat === 'Jeunesse' || cat === 'Poésie / Théâtre' || cat === 'Essai') return 'Roman';
  return null;
}

function matchesRequestedMediaExact(cat: BookMainCategory | undefined, requested: RequestedMediaHint): boolean {
  const bucket = getOptionMediaBucket(cat);
  if (!bucket) return false;
  return bucket === requested;
}

function isFrenchCandidate(opt: Pick<PhotoCandidateOption, 'language' | 'isbn13'>): boolean {
  const lang = (opt.language ?? '').trim().toLowerCase();
  if (lang === 'fr' || lang === 'fre' || lang === 'fra') return true;
  if (!lang && (opt.isbn13.startsWith('9782') || opt.isbn13.startsWith('97910'))) return true;
  return false;
}

function isExplicitNonFrenchCandidate(opt: Pick<PhotoCandidateOption, 'language' | 'isbn13'>): boolean {
  const lang = (opt.language ?? '').trim().toLowerCase();
  if (!lang) return false;
  if (lang === 'fr' || lang === 'fre' || lang === 'fra') return false;
  if (opt.isbn13.startsWith('9782') || opt.isbn13.startsWith('97910')) return false;
  return true;
}

function toOption(rec: SourceCandidateRecord): PhotoCandidateOption | null {
  if (!rec.isbn13 || !rec.title) return null;
  if (!isbnUtil.isValidBookBarcode(rec.isbn13)) return null;
  if (!isLatinScriptLabel(rec.title)) return null;
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
  const classified = classifyBookMetadata({
    title: rec.title,
    series: rec.seriesName,
    publisher: rec.publisher,
    collection: rec.collectionName,
    deweyCode: rec.deweyCode,
    rawSubjects: rec.rawSubjects,
    description: rec.description,
    contentKind: rec.contentKind,
    originalLanguage: rec.originalLanguage
  });
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
    collectionName: rec.collectionName ?? null,
    publishYear: rec.publishYear ?? null,
    coverUrl: rec.coverUrl ?? null,
    coverOptions,
    isIntegral: Boolean(rec.isIntegralHint),
    includedVolumes: incVols,
    mainCategory: classified.mainCategory,
    language: rec.language ?? null,
    source: rec.source
  };
}

function isSameAbstractWork(a: PhotoCandidateOption, b: PhotoCandidateOption): boolean {
  if (Boolean(a.isIntegral) !== Boolean(b.isIntegral)) return false;
  if (a.bookId && b.bookId) return a.bookId === b.bookId;

  // Un roman et son adaptation BD/Manga/Comics ne sont JAMAIS la même œuvre abstraite
  const bucketA = getOptionMediaBucket(a.mainCategory);
  const bucketB = getOptionMediaBucket(b.mainCategory);
  if (bucketA && bucketB && bucketA !== bucketB) return false;

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
  private readonly onNotifyUser?: (params: { userId: string; title: string; body: string; url?: string }) => Promise<void> | void;

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
    onNotifyUser?: (params: { userId: string; title: string; body: string; url?: string }) => Promise<void> | void;
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
    this.onNotifyUser = deps.onNotifyUser;
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
          mode: parsed.mode === 'cover' ? 'cover' : parsed.mode === 'shelf' ? 'shelf' : 'auto',
          previewCoverKey: parsed.previewCoverKey ?? null,
          previewUrl: parsed.previewCoverKey ? `/api/covers/${parsed.previewCoverKey}` : (parsed.previewUrl ?? null),
          notifyOnComplete: Boolean(parsed.notifyOnComplete),
          committedAt: parsed.committedAt ?? null,
          items: Array.isArray(parsed.items) ? parsed.items : []
        };
      } catch {
        // fallback below
      }
    }
    return { mode: 'auto', previewCoverKey: null, previewUrl: null, notifyOnComplete: false, committedAt: null, items: [] };
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
      collectionName: b.collection_name,
      publishYear: b.publish_year,
      coverUrl: b.cover_key ? `/api/covers/${b.cover_key}` : (coverOptions[0]?.coverUrl ?? null),
      coverOptions,
      isIntegral: b.is_integral === 1,
      includedVolumes: parseJsonStringArray(b.included_volumes_json),
      mainCategory: b.main_category,
      language: b.language ?? 'fr',
      source: 'local'
    };
  }

  /**
   * Fusionne les éditions d'une même Œuvre abstraite dans la liste d'options au lieu d'exposer N rééditions redondantes.
   * Si l'édition entrante correspond mieux à l'éditeur/format demandé (ou remplace une édition club type France Loisirs),
   * elle devient l'édition primaire de l'option fusionnée tout en conservant les autres ISBNs dans `siblingIsbns`.
   */
  private mergeOptionIntoAbstractList(
    list: PhotoCandidateOption[],
    incoming: PhotoCandidateOption | null,
    pref?: { normPub?: string; editionHintTokens?: string[]; queryAsksForClub?: boolean }
  ): void {
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

    const editionPrefScore = (opt: PhotoCandidateOption): number => {
      let s = 0;
      const meta = normalizeTextKey(
        `${opt.title} ${opt.seriesName ?? ''} ${opt.publisher ?? ''} ${opt.collectionName ?? ''}`
      );
      if (pref?.normPub && opt.publisher && normalizeTextKey(opt.publisher).includes(pref.normPub)) {
        s += 25;
      }
      if (pref?.editionHintTokens && pref.editionHintTokens.length > 0) {
        for (const tok of pref.editionHintTokens) {
          if (meta.includes(tok)) s += 15;
        }
      }
      if (!pref?.queryAsksForClub && opt.publisher && CLUB_OR_ABRIDGED_PUBLISHER_RE.test(opt.publisher)) {
        s -= 12;
      }
      if (opt.bookId) s += 4;
      return s;
    };

    if (editionPrefScore(incoming) > editionPrefScore(existing)) {
      existing.isbn13 = incoming.isbn13;
      if (incoming.title) existing.title = incoming.title;
      if (incoming.publisher) existing.publisher = incoming.publisher;
      if (incoming.collectionName) existing.collectionName = incoming.collectionName;
      if (incoming.publishYear) existing.publishYear = incoming.publishYear;
      if (incoming.coverUrl) existing.coverUrl = incoming.coverUrl;
    }

    if (!existing.bookId && incoming.bookId) existing.bookId = incoming.bookId;
    if (!existing.coverUrl && incoming.coverUrl) existing.coverUrl = incoming.coverUrl;
    if (!existing.seriesName && incoming.seriesName) existing.seriesName = incoming.seriesName;
    if (!existing.volumeNumber && incoming.volumeNumber) existing.volumeNumber = incoming.volumeNumber;
    if (!existing.publisher && incoming.publisher) existing.publisher = incoming.publisher;
    if (!existing.collectionName && incoming.collectionName) existing.collectionName = incoming.collectionName;
    if (!existing.publishYear && incoming.publishYear) existing.publishYear = incoming.publishYear;
    if (!existing.language && incoming.language) existing.language = incoming.language;
    if ((!existing.mainCategory || existing.mainCategory === 'Autre') && incoming.mainCategory && incoming.mainCategory !== 'Autre') {
      existing.mainCategory = incoming.mainCategory;
    }
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
    authorHint?: string,
    mediaFamily: 'graphic' | 'prose' | 'neutral' = 'neutral'
  ): Promise<PhotoCandidateOption | null> {
    const cleanSeries = extractFranchiseBaseName(seriesName).baseName;
    let canonicalTitle: string | null = null;
    let canonicalAuthors: string[] = authorHint ? [authorHint] : [];
    let canonicalCover: string | null = null;

    try {
      const qids = this.connectors.wikidata.searchSeriesQids
        ? await this.connectors.wikidata.searchSeriesQids(cleanSeries, mediaFamily)
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
        mediaFamily,
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
    rawText?: string;
    isIntegral?: boolean;
  }): Promise<PhotoCandidateOption[]> {
    const options: PhotoCandidateOption[] = [];

    // 1B. Pré-nettoyage d'intention : extrait (BD)/(manga)/(comics), "Tome N"/"t2"/"Tome II", intégrales/plages et qualificatifs d'édition
    const intent = parseSearchIntent({
      title: hint.title,
      series: hint.series,
      volumeNumber: hint.volumeNumber,
      author: hint.author,
      publisher: hint.publisher,
      isIntegral: hint.isIntegral
    });

    const normPub = intent.effectivePublisher ? normalizeTextKey(intent.effectivePublisher) : '';
    const queryAsksForClub = Boolean(
      intent.effectivePublisher && CLUB_OR_ABRIDGED_PUBLISHER_RE.test(intent.effectivePublisher)
    );
    const mergePref = {
      normPub,
      editionHintTokens: intent.editionHintTokens,
      queryAsksForClub
    };
    const pushOpt = (opt: PhotoCandidateOption | null) => this.mergeOptionIntoAbstractList(options, opt, mergePref);

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

    const cleanSeries = intent.cleanSeries;
    const cleanTitle = intent.cleanTitle;
    const relaxedSeries = intent.relaxedSeries;
    const relaxedTitle = intent.relaxedTitle;
    const cleanAuthor = intent.cleanAuthor;
    const normSeries = normalizeTextKey(cleanSeries);
    const normTitle = normalizeTextKey(cleanTitle);
    const volNumStr = intent.volumeNumber ?? '';
    const volNum = intent.volumeNumeric;
    const wantsIntegral = intent.wantsIntegral;
    const requestedMedia = intent.requestedMedia;
    const mediaFamily: 'graphic' | 'prose' | 'neutral' =
      requestedMedia === 'Roman' ? 'prose' : requestedMedia ? 'graphic' : 'neutral';

    const matchesEditionHints = (opt: PhotoCandidateOption): boolean => {
      if (intent.editionHintTokens.length === 0) return true;
      const meta = normalizeTextKey(
        `${opt.title} ${opt.seriesName ?? ''} ${opt.publisher ?? ''} ${opt.collectionName ?? ''}`
      );
      return intent.editionHintTokens.some((tok) => meta.includes(tok));
    };

    const matchesAuthorParts = (opt: PhotoCandidateOption): boolean => {
      if (intent.allAuthorParts.length === 0) return true;
      if (opt.authors.length === 0) return false;
      return opt.authors.some((a) => intent.allAuthorParts.some((p) => matchesAuthorName(a, p)));
    };

    // 2. Recherche Catalogue Central local d'abord (0 appel réseau si l'Œuvre abstraite est déjà en base !)
    if (cleanTitle || cleanSeries) {
      const local = this.catalogRepo.searchLocalCatalog({
        titleNorm: relaxedTitle ? normalizeTextKey(relaxedTitle) : cleanTitle ? normTitle : undefined,
        seriesNorm: relaxedSeries ? normalizeTextKey(relaxedSeries) : cleanSeries ? normSeries : undefined,
        volumeNumber: volNum,
        authorNorm: cleanAuthor ? normalizeTextKey(cleanAuthor) : undefined,
        publisherNorm: intent.effectivePublisher ? normalizeTextKey(intent.effectivePublisher) : undefined,
        limit: 8
      });
      for (const b of local.books) {
        pushOpt(this.buildLocalAbstractOption(b));
      }

      // Court-circuit Catalogue Central uniquement si le média, l'auteur et les indices d'édition correspondent
      // (empêche un roman en base de court-circuiter une recherche "(BD)" ou "(manga)" ou "Deluxe").
      const localCompatible = (o: PhotoCandidateOption): boolean => {
        if (o.source !== 'local') return false;
        if (requestedMedia && !matchesRequestedMediaExact(o.mainCategory, requestedMedia)) return false;
        if (intent.allAuthorParts.length > 0 && o.authors.length > 0 && !matchesAuthorParts(o)) return false;
        if (intent.editionHintTokens.length > 0 && !matchesEditionHints(o)) return false;
        if (wantsIntegral && !o.isIntegral) return false;
        return true;
      };

      const hintSeriesKey = extractFranchiseBaseName(relaxedSeries || cleanSeries || relaxedTitle || cleanTitle).normalizedKey;
      const hasLocalExactVolume =
        volNumStr.length > 0 &&
        !wantsIntegral &&
        options.some((o) => {
          if (!localCompatible(o) || o.isIntegral) return false;
          const optVol = normalizeSeriesNumber(o.volumeNumber);
          if (optVol !== volNumStr) return false;
          if (!hintSeriesKey) return true;
          const optSeriesKey = extractFranchiseBaseName(o.seriesName || '').normalizedKey;
          return (
            optSeriesKey === hintSeriesKey ||
            tokenOverlapRatio(relaxedSeries || cleanSeries || relaxedTitle || cleanTitle, `${o.seriesName ?? ''} ${o.title}`) >= 0.65
          );
        });
      const hasLocalExactSeriesTitle =
        Boolean(cleanSeries && cleanTitle) &&
        !isGenericVolumeTitle(cleanTitle, cleanSeries) &&
        options.some((o) => {
          if (!localCompatible(o)) return false;
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
        options.some((o) => localCompatible(o) && normalizeTextKey(o.title) === normTitle);

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
    const seriesHint = relaxedSeries || cleanSeries || (volNum !== null ? (relaxedTitle || cleanTitle) : '');
    if (seriesHint && volNum !== null && !wantsIntegral) {
      const canonicalOpt = await this.resolveCanonicalSeriesVolumeOption(seriesHint, volNum, cleanAuthor, mediaFamily);
      if (canonicalOpt) {
        pushOpt(canonicalOpt);
      }
    }

    // 3A-bis. Si une intégrale/coffret est demandée (avec ou sans n° de tome explicite) -> recherche dédiée BnF Intégrales
    const integralQueryBase = intent.integralSeriesBase || seriesHint;
    if (wantsIntegral && integralQueryBase && this.connectors.bnf.searchSeriesIntegrals) {
      const integrals = await this.connectors.bnf.searchSeriesIntegrals(integralQueryBase, 15).catch(() => []);
      const filteredIntegrals =
        intent.integralRange.length >= 2
          ? integrals
              .filter((x) => {
                const inc = x.includedVolumes ?? [];
                return inc.length === 0 || intent.integralRange.some((v) => inc.includes(v));
              })
              .sort((a, b) => {
                const aMatches = intent.integralRange.filter((v) => (a.includedVolumes ?? []).includes(v)).length;
                const bMatches = intent.integralRange.filter((v) => (b.includedVolumes ?? []).includes(v)).length;
                return bMatches - aMatches;
              })
          : volNum !== null
            ? integrals.filter(
                (x) => (x.includedVolumes ?? []).includes(String(volNum)) || x.volumeNumber === volNum
              )
            : integrals;

      for (const it of (filteredIntegrals.length > 0 ? filteredIntegrals : integrals).slice(0, 4)) {
        if (!it.isbn13s[0]) continue;
        pushOpt({
          bookId: null,
          isbn13: it.isbn13s[0],
          siblingIsbns: it.isbn13s,
          editionCount: Math.max(1, it.isbn13s.length),
          title: it.title,
          seriesName: extractFranchiseBaseName(integralQueryBase).baseName,
          volumeNumber: it.volumeLabel ?? 'Intégrale',
          authors: it.authors,
          publisher: it.publisher ?? null,
          collectionName: it.collectionName ?? null,
          publishYear: it.publishYear ?? null,
          coverUrl: it.coverUrl ?? null,
          coverOptions: it.coverUrl
            ? [{ coverKey: null, coverUrl: it.coverUrl, label: it.publisher || 'Intégrale BnF', isbn13: it.isbn13s[0] }]
            : [],
          isIntegral: true,
          includedVolumes: it.includedVolumes ?? [],
          mainCategory: classifyBookMetadata({
            title: it.title,
            series: integralQueryBase,
            publisher: it.publisher ?? undefined,
            collection: it.collectionName ?? undefined,
            deweyCode: it.deweyCode ?? undefined,
            rawSubjects: it.rawSubjects,
            contentKind: it.contentKind,
            originalLanguage: it.originalLanguage ?? undefined
          }).mainCategory,
          source: 'bnf'
        });
      }
    }

    // 3B. Cascade externe progressive (BnF SRU + Inventaire.io) agrégée par Œuvre abstraite :
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

    const hasTargetVolumeMatch = () =>
      Boolean(
        volNumStr &&
          options.some(
            (o) =>
              !o.isIntegral &&
              normalizeSeriesNumber(o.volumeNumber) === volNumStr &&
              (!requestedMedia || matchesRequestedMediaExact(o.mainCategory, requestedMedia))
          )
      );

    const hasRequestedMediaMatch = () =>
      !requestedMedia || options.some((o) => matchesRequestedMediaExact(o.mainCategory, requestedMedia));

    const combinedTitle =
      cleanSeries && cleanTitle && !normTitle.includes(normSeries)
        ? `${cleanSeries} ${cleanTitle}`
        : cleanTitle || cleanSeries;

    const normRelaxedTitle = normalizeTextKey(relaxedTitle);
    const normRelaxedSeries = normalizeTextKey(relaxedSeries);
    const relaxedCombined =
      relaxedSeries && relaxedTitle && !normRelaxedTitle.includes(normRelaxedSeries)
        ? `${relaxedSeries} ${relaxedTitle}`
        : relaxedTitle || relaxedSeries;

    // Passe A : requête stricte nettoyée (inclut n° de tome si pertinent)
    const hasHighConfidenceMatch = () =>
      options.some((o) => {
        if (!isFrenchCandidate(o)) return false;
        if (requestedMedia && !matchesRequestedMediaExact(o.mainCategory, requestedMedia)) return false;
        if (wantsIntegral && !o.isIntegral) return false;
        if (volNumStr && !wantsIntegral && normalizeSeriesNumber(o.volumeNumber) !== volNumStr) return false;
        if (intent.allAuthorParts.length > 0 && o.authors.length > 0 && !matchesAuthorParts(o)) return false;
        const candText = `${o.seriesName ?? ''} ${o.title}`;
        const sigTarget = stripGenericRelevanceWords(relaxedTitle || cleanTitle || relaxedSeries || cleanSeries);
        return sigTarget.length >= 3 && tokenOverlapRatio(sigTarget, candText) >= 0.65;
      });

    if (combinedTitle) {
      await runExternalPass(combinedTitle, cleanAuthor, requestedMedia ? 15 : 12);
    }

    // Passe A-media : si un média explicite (BD/Manga/Comics) était demandé entre parenthèses et aucun résultat ne matche encore ce média
    if (requestedMedia && requestedMedia !== 'Roman' && !hasRequestedMediaMatch()) {
      const mediaBase = relaxedCombined || combinedTitle;
      const mediaKeyword =
        requestedMedia === 'Manga' ? 'manga' : requestedMedia === 'Comics' ? 'comics' : 'bande dessinée';
      if (mediaBase) {
        const mediaQuery = volNumStr && !wantsIntegral ? `${mediaBase} ${volNumStr}` : `${mediaBase} ${mediaKeyword}`;
        await runExternalPass(mediaQuery, cleanAuthor, 15);
        if (!hasRequestedMediaMatch() && mediaQuery !== `${mediaBase} ${mediaKeyword}`) {
          await runExternalPass(`${mediaBase} ${mediaKeyword}`, cleanAuthor, 15);
        }
      }
    }

    // Passe B : recherche ciblée du tome N de la série (coupée court si Passe A a déjà un match de haute confiance)
    if (!hasHighConfidenceMatch()) {
      if (volNumStr && !wantsIntegral && !hasTargetVolumeMatch()) {
        const volBase = relaxedSeries || cleanSeries || relaxedTitle || cleanTitle;
        if (volBase) {
          await runExternalPass(`${volBase} ${volNumStr}`, cleanAuthor, 15);
        }
        if (!hasTargetVolumeMatch() && cleanSeries) {
          await runExternalPass(cleanSeries, cleanAuthor, 25);
        }
      } else if (options.length < 2 && cleanSeries) {
        await runExternalPass(cleanSeries, cleanAuthor, 25);
      }
    }

    // Passe C1 : titre seul si distinct de combinedTitle (et que cleanTitle porte des mots distinctifs hors "Intégrale/Cycle")
    if (
      options.length === 0 &&
      cleanTitle &&
      cleanTitle !== combinedTitle &&
      stripGenericRelevanceWords(cleanTitle).length >= 4
    ) {
      await runExternalPass(cleanTitle, cleanAuthor, 12);
    }

    // Passe C2 (secours relâché sans qualificatifs d'édition/éditeur type "deluxe", "perfect", "black edition", "glénat", "kana"...)
    if (
      !hasHighConfidenceMatch() &&
      (options.length === 0 || (volNumStr && !wantsIntegral && !hasTargetVolumeMatch())) &&
      relaxedCombined &&
      normalizeTextKey(relaxedCombined) !== normalizeTextKey(combinedTitle)
    ) {
      await runExternalPass(
        volNumStr && !wantsIntegral ? `${relaxedCombined} ${volNumStr}` : relaxedCombined,
        cleanAuthor,
        15
      );
      if (options.length === 0) {
        await runExternalPass(relaxedCombined, cleanAuthor, 15);
      }
    }

    // Passe C2-bis (intégrale / coffret sans résultat avec le libellé complet type "Sanctuary - Coffret intégrale") :
    // retente sur la base de série propre + "intégrale", puis la base seule (attrape les éditions omnibus/deluxe/coffret).
    if (wantsIntegral && options.length === 0 && integralQueryBase && normalizeTextKey(integralQueryBase).length >= 3) {
      await runExternalPass(`${integralQueryBase} intégrale`, cleanAuthor, 12);
      if (options.length === 0) {
        await runExternalPass(integralQueryBase, cleanAuthor, 15);
      }
      if (options.length === 0 && cleanAuthor) {
        await runExternalPass(`${integralQueryBase} intégrale`, undefined, 12);
      }
    }

    // Passe C3 (bascule '&' -> 'et', ex. "Paul & Virginie" -> "Paul et Virginie")
    if (options.length === 0 && (combinedTitle.includes('&') || relaxedCombined.includes('&'))) {
      const etQuery = (relaxedCombined || combinedTitle).replace(/\s*&\s*/g, ' et ').replace(/\s+/g, ' ').trim();
      if (etQuery && etQuery !== combinedTitle) {
        await runExternalPass(etQuery, cleanAuthor, 12);
      }
    }

    // Passe D (secours pseudonyme / co-auteur absent de BnF)
    const titleFallbackQuery = relaxedTitle || cleanTitle || relaxedSeries || cleanSeries;
    if (
      options.length === 0 &&
      cleanAuthor &&
      titleFallbackQuery &&
      stripGenericRelevanceWords(titleFallbackQuery).length >= 5 &&
      !isGenericVolumeTitle(titleFallbackQuery, cleanSeries)
    ) {
      await runExternalPass(
        volNumStr && !wantsIntegral ? `${titleFallbackQuery} ${volNumStr}` : titleFallbackQuery,
        undefined,
        10
      );
      if (options.length === 0 && volNumStr && !wantsIntegral) {
        await runExternalPass(titleFallbackQuery, undefined, 10);
      }
    }

    // Garde-fou anti-hors-sujet : rejette les candidats dont le titre/série n'a aucun recouvrement SIGNIFICATIF
    // (les mots génériques "Intégrale", "Cycle", "Tome", "Volume" sont exclus pour empêcher
    // "Les Innommables - Intégrale Cycle zéro" de matcher "Fondation Intégrale Tome 1").
    const primaryQueryText = relaxedCombined || combinedTitle;
    const sigPrimaryQuery = stripGenericRelevanceWords(primaryQueryText) || normalizeTextKey(primaryQueryText);
    const sigSeriesQuery = stripGenericRelevanceWords(relaxedSeries || cleanSeries);
    const sigTitleQuery = stripGenericRelevanceWords(relaxedTitle || cleanTitle);

    const computeRelevanceOverlap = (opt: PhotoCandidateOption, queryOverride?: string): number => {
      const candText = `${opt.seriesName ?? ''} ${opt.title}`.trim();
      const target = queryOverride ? stripGenericRelevanceWords(queryOverride) || normalizeTextKey(queryOverride) : sigPrimaryQuery;
      const scores = [target ? tokenOverlapRatio(target, candText) : 0];
      if (!queryOverride) {
        if (sigTitleQuery) scores.push(tokenOverlapRatio(sigTitleQuery, candText));
        if (sigSeriesQuery) scores.push(tokenOverlapRatio(sigSeriesQuery, candText));
      }
      // Tolérance faute de frappe sur titre court en 1 mot (Levenshtein <= 2)
      const normCandTitle = normalizeTextKey(opt.title);
      const normCandSeries = normalizeTextKey(opt.seriesName ?? '');
      if (
        target.length >= 4 &&
        !target.includes(' ') &&
        ((normCandTitle && getLevenshteinDistance(target, normCandTitle) <= 2) ||
          (normCandSeries && getLevenshteinDistance(target, normCandSeries) <= 2))
      ) {
        scores.push(0.8);
      }
      return Math.max(...scores);
    };

    const filterRelevant = (list: PhotoCandidateOption[]): PhotoCandidateOption[] => {
      if (sigPrimaryQuery.length < 2) return list;
      return list.filter((opt) => {
        // Si une série explicite est demandée (ex. "Les Innommables", "B.P.R.D."), le candidat doit être compatible avec cette série
        if (sigSeriesQuery.length >= 2) {
          const candText = `${opt.seriesName ?? ''} ${opt.title}`.trim();
          const sKey = extractFranchiseBaseName(relaxedSeries || cleanSeries).normalizedKey;
          const oKey = opt.seriesName ? extractFranchiseBaseName(opt.seriesName).normalizedKey : '';
          const sameFranchise = Boolean(sKey && oKey && sKey === oKey);
          const seriesOverlap = tokenOverlapRatio(sigSeriesQuery, candText);
          const normCandSeries = normalizeTextKey(opt.seriesName ?? '');
          const closeSeries = Boolean(
            !sigSeriesQuery.includes(' ') &&
              sigSeriesQuery.length >= 4 &&
              normCandSeries &&
              getLevenshteinDistance(sigSeriesQuery, normCandSeries) <= 2
          );
          if (!sameFranchise && seriesOverlap < 0.35 && !closeSeries) {
            return false;
          }
        }

        const overlap = computeRelevanceOverlap(opt);
        if (overlap >= 0.25) return true;
        if (cleanSeries && opt.seriesName) {
          const sKey = extractFranchiseBaseName(relaxedSeries || cleanSeries).normalizedKey;
          const oKey = extractFranchiseBaseName(opt.seriesName).normalizedKey;
          if (sKey && oKey && sKey === oKey) return true;
        }
        return false;
      });
    };

    let relevantOptions = filterRelevant(options);

    // =========================================================================
    // ENTONNOIR DE SECOURS STRICT (déclenché UNIQUEMENT si 0 résultat pertinent !)
    // Risque de régression = 0 sur les livres déjà trouvés par les passes normales.
    // =========================================================================
    const omniboxRawSource = [hint.series, hint.title].filter(Boolean).join(' ').trim();
    if (relevantOptions.length === 0 && omniboxRawSource.length >= 4) {
      const omniboxCandidates: PhotoCandidateOption[] = [];
      const pushFallback = (opt: PhotoCandidateOption | null) =>
        this.mergeOptionIntoAbstractList(omniboxCandidates, opt, mergePref);

      // Secours F1 : BnF recherche globale `bib.anywhere` (1 seul appel : titre propre + nom de famille du 1er auteur sans '&')
      const primaryLastName = extractAuthorLastNameForQuery(cleanAuthor);
      const fallbackBaseText =
        wantsIntegral && integralQueryBase ? integralQueryBase : relaxedCombined || combinedTitle;
      const cleanFallbackTitle = fallbackBaseText.replace(/[?¿!¡&]+/g, ' ').replace(/\s+/g, ' ').trim();
      const anywhereQuery = [cleanFallbackTitle, primaryLastName].filter(Boolean).join(' ').trim();
      if (anywhereQuery && this.connectors.bnf.searchAnywhere) {
        const anyHits = await this.connectors.bnf.searchAnywhere(anywhereQuery, 12).catch(() => []);
        for (const hit of anyHits) {
          const opt = toOption(hit);
          if (!opt) continue;
          const fullCand = `${opt.seriesName ?? ''} ${opt.title} ${opt.authors.join(' ')}`.trim();
          const titleCand = `${opt.seriesName ?? ''} ${opt.title}`.trim();
          // Exiger un recouvrement global solide ET au moins un mot significatif dans le titre/série
          const fullOverlap = tokenOverlapRatio(sigPrimaryQuery, fullCand);
          const titleOverlap = tokenOverlapRatio(sigPrimaryQuery, titleCand);
          if (fullOverlap >= 0.45 && titleOverlap >= 0.25) {
            pushFallback(opt);
          }
        }
      }

      // Secours F2 : découpage intelligent ciblé Titre / Auteur (max 2-3 coupes, uniquement si F1 est vide !)
      if (omniboxCandidates.length === 0 && !hint.author?.trim()) {
        const splits = buildOmniboxSplitCandidates(omniboxRawSource);
        for (const split of splits) {
          const splitQuery = split.volumeNumber ? `${split.titlePart} ${split.volumeNumber}` : split.titlePart;
          const splitHits = await this.connectors.bnf
            .searchByTitleAndAuthor(splitQuery, split.authorPart, 8)
            .catch(() => []);
          const fallbackHits =
            splitHits.length === 0 && split.volumeNumber
              ? await this.connectors.bnf.searchByTitleAndAuthor(split.titlePart, split.authorPart, 8).catch(() => [])
              : splitHits;

          const sigSplitTitle = stripGenericRelevanceWords(split.titlePart) || normalizeTextKey(split.titlePart);
          for (const hit of fallbackHits) {
            const opt = toOption(hit);
            if (!opt) continue;
            const titleCand = `${opt.seriesName ?? ''} ${opt.title}`.trim();
            // Double verrou strict : le titre ET l'auteur supposé doivent tous deux correspondre !
            const titleMatches =
              tokenOverlapRatio(sigSplitTitle, titleCand) >= 0.4 ||
              (sigSplitTitle.length >= 4 &&
                !sigSplitTitle.includes(' ') &&
                getLevenshteinDistance(sigSplitTitle, normalizeTextKey(opt.title)) <= 2);
            const authorMatches = opt.authors.some((a) => matchesAuthorName(a, split.authorPart));
            if (titleMatches && authorMatches) {
              pushFallback(opt);
            }
          }
          if (omniboxCandidates.length > 0) break;
        }
      }

      // Secours F3 : Ultime recours API officielles (Google Books texte + Open Library texte — 100 % légal, zéro scraping)
      if (omniboxCandidates.length === 0) {
        const officialQuery = [
          cleanFallbackTitle,
          primaryLastName,
          volNumStr && !wantsIntegral ? volNumStr : ''
        ]
          .filter(Boolean)
          .join(' ')
          .trim();
        const tryOfficialHits = (hits: SourceCandidateRecord[]) => {
          for (const hit of hits) {
            const opt = toOption(hit);
            if (!opt) continue;
            const titleCand = `${opt.seriesName ?? ''} ${opt.title}`.trim();
            const fullCand = `${titleCand} ${opt.authors.join(' ')}`.trim();
            const titleOverlap = tokenOverlapRatio(sigPrimaryQuery, titleCand);
            const fullOverlap = tokenOverlapRatio(sigPrimaryQuery, fullCand);
            const authorOk =
              intent.allAuthorParts.length === 0 ||
              opt.authors.length === 0 ||
              matchesAuthorParts(opt);
            if (authorOk && (titleOverlap >= 0.4 || (fullOverlap >= 0.5 && titleOverlap >= 0.25))) {
              pushFallback(opt);
            }
          }
        };

        if (officialQuery && this.connectors.googleBooks.searchByText) {
          const gbHits = await this.connectors.googleBooks.searchByText(officialQuery, 6).catch(() => []);
          tryOfficialHits(gbHits);
        } else if (this.connectors.googleBooks.searchByTitleAndAuthor && (relaxedCombined || combinedTitle)) {
          const gbHits = await this.connectors.googleBooks
            .searchByTitleAndAuthor(relaxedCombined || combinedTitle, cleanAuthor, 6)
            .catch(() => []);
          tryOfficialHits(gbHits);
        }

        if (omniboxCandidates.length === 0 && officialQuery && this.connectors.openLibrary.searchByText) {
          const olHits = await this.connectors.openLibrary.searchByText(officialQuery, 6).catch(() => []);
          tryOfficialHits(olHits);
        }
      }

      if (omniboxCandidates.length > 0) {
        relevantOptions = omniboxCandidates;
      }
    }

    // Secours F4 (propositions approximatives) : exécuté UNIQUEMENT si 0 candidat n'a survécu aux passes strictes + F1-F3.
    // Évite de laisser l'utilisateur devant un item "Non identifié" sans aucune suggestion quand l'IA a pourtant lu du texte.
    if (relevantOptions.length === 0) {
      const rawHintText = [hint.rawText, hint.series, hint.title].filter(Boolean).join(' ').trim();
      const distinctiveWords = Array.from(
        new Set(
          (stripGenericRelevanceWords(rawHintText) || normalizeTextKey(rawHintText))
            .split(/\s+/)
            .filter((w) => w.length >= 4 && !/^\d+$/.test(w))
        )
      ).sort((a, b) => b.length - a.length);

      const softCandidates: PhotoCandidateOption[] = [];
      const pushSoft = (opt: PhotoCandidateOption | null) =>
        this.mergeOptionIntoAbstractList(softCandidates, opt, mergePref);

      const hasDistinctiveMatch = (opt: PhotoCandidateOption): boolean => {
        if (distinctiveWords.length === 0) return false;
        const candNorm = normalizeTextKey(`${opt.seriesName ?? ''} ${opt.title} ${opt.authors.join(' ')}`);
        if (!candNorm) return false;
        if (computeRelevanceOverlap(opt) >= 0.15) return true;
        return distinctiveWords.some((w) => w.length >= 5 && candNorm.includes(w));
      };

      // F4a : réutiliser les candidats déjà collectés avant le filtre strict s'ils partagent au moins un mot distinctif
      for (const opt of options) {
        if (hasDistinctiveMatch(opt)) {
          pushSoft(opt);
        }
      }

      // F4b : si toujours vide, requête relâchée sur les 3 mots les plus distinctifs de rawText/titre (sans auteur)
      if (softCandidates.length === 0 && distinctiveWords.length > 0) {
        const relaxedKeywords = distinctiveWords.slice(0, 3).join(' ');
        if (relaxedKeywords.length >= 4) {
          const hits: SourceCandidateRecord[] = [];
          if (this.connectors.bnf.searchAnywhere) {
            hits.push(...(await this.connectors.bnf.searchAnywhere(relaxedKeywords, 8).catch(() => [])));
          }
          if (hits.length === 0) {
            hits.push(...(await this.connectors.bnf.searchByTitleAndAuthor(relaxedKeywords, undefined, 8).catch(() => [])));
          }
          if (hits.length === 0 && this.connectors.googleBooks.searchByText) {
            hits.push(...(await this.connectors.googleBooks.searchByText(relaxedKeywords, 6).catch(() => [])));
          }
          for (const hit of hits) {
            const opt = toOption(hit);
            if (opt && hasDistinctiveMatch(opt)) {
              pushSoft(opt);
            }
          }
        }
      }

      if (softCandidates.length > 0) {
        relevantOptions = softCandidates.slice(0, 4);
      }
    }

    const rawQueryCombined = `${hint.series ?? ''} ${hint.title ?? ''}`.trim();
    const queryAsksForGuide = DERIVATIVE_GUIDE_RE.test(rawQueryCombined);

    // Détecter si les résultats contiennent à la fois le roman original et une adaptation BD/Manga/Comics du même titre
    const hasNovelAndGraphicMix =
      !requestedMedia &&
      !wantsIntegral &&
      intent.editionHintTokens.length === 0 &&
      intent.allAuthorParts.length === 1 &&
      relevantOptions.some((o) => getOptionMediaBucket(o.mainCategory) === 'Roman') &&
      relevantOptions.some((o) => {
        const b = getOptionMediaBucket(o.mainCategory);
        return b === 'BD' || b === 'Manga' || b === 'Comics';
      });

    // Scoring déterministe pour placer la meilleure Œuvre abstraite en #1
    const scoreOption = (opt: PhotoCandidateOption): number => {
      let score = 0;
      const optVol = normalizeSeriesNumber(opt.volumeNumber);
      const candText = `${opt.seriesName ?? ''} ${opt.title}`.trim();

      if (wantsIntegral) {
        if (opt.isIntegral) {
          score += 35;
          if (intent.integralRange.length >= 2) {
            const inc = opt.includedVolumes ?? [];
            const matchedCount = intent.integralRange.filter((v) => inc.includes(v)).length;
            if (matchedCount === intent.integralRange.length) score += 30;
            else if (matchedCount > 0) score += 15;
          }
        } else {
          score -= 25;
        }
      } else if (volNumStr) {
        if (!opt.isIntegral && optVol && optVol === volNumStr) score += 65;
        else if (opt.isIntegral && (opt.includedVolumes ?? []).includes(volNumStr)) score += 15;
        else if (optVol && optVol !== volNumStr) score -= 35;
        else if (new RegExp(`\\b${volNumStr.replace('.', '\\.')}\\b`).test(opt.title)) score += 20;
      } else if (opt.isIntegral) {
        score -= 10;
      }

      if (requestedMedia && opt.mainCategory) {
        const optBucket = getOptionMediaBucket(opt.mainCategory);
        if (optBucket === requestedMedia) {
          score += 45;
        } else if (optBucket) {
          const wantsGraphic = requestedMedia !== 'Roman';
          const isOptGraphic = optBucket !== 'Roman';
          score += wantsGraphic !== isOptGraphic ? -50 : -15;
        }
      }

      // Bonus titre exact (ex. "La Chatte" de Colette devant "La Chatte sur un toit brûlant")
      const normOptTitle = normalizeTextKey(opt.title);
      if (normTitle && normOptTitle === normTitle) {
        score += 18;
      }

      if (relaxedTitle || cleanTitle) {
        const tOverlap = Math.max(
          cleanTitle ? tokenOverlapRatio(cleanTitle, candText) : 0,
          relaxedTitle ? tokenOverlapRatio(relaxedTitle, candText) : 0
        );
        score += Math.round(tOverlap * 30);
      }
      if (relaxedSeries || cleanSeries) {
        const sOverlap = Math.max(
          cleanSeries ? tokenOverlapRatio(cleanSeries, candText) : 0,
          relaxedSeries ? tokenOverlapRatio(relaxedSeries, candText) : 0
        );
        score += Math.round(sOverlap * 20);
      }

      // Préférence langue française vs notices étrangères (ex. manuel anglais "Core concepts in criminal law")
      if (isFrenchCandidate(opt)) score += 12;
      else if (isExplicitNonFrenchCandidate(opt)) score -= 22;

      // Quand l'utilisateur saisit un titre + un auteur unique de roman SANS demander "(BD)"
      // et que la recherche ramène à la fois le roman original et son adaptation BD co-écrite, favoriser le roman original.
      if (hasNovelAndGraphicMix && getOptionMediaBucket(opt.mainCategory) === 'Roman' && opt.authors.length <= 2) {
        score += 14;
      }

      // Bonus qualificatifs d'édition / éditeur extraits (ex. "deluxe", "black", "perfect", "glénat", "kurokawa")
      if (intent.editionHintTokens.length > 0) {
        const candMetaNorm = normalizeTextKey(
          `${opt.title} ${opt.seriesName ?? ''} ${opt.publisher ?? ''} ${opt.collectionName ?? ''}`
        );
        let hintBonus = 0;
        for (const tok of intent.editionHintTokens) {
          if (candMetaNorm.includes(tok)) hintBonus += 15;
        }
        score += Math.min(45, hintBonus);
      }

      if (normPub && opt.publisher && normalizeTextKey(opt.publisher).includes(normPub)) {
        score += 18;
      }
      if (intent.allAuthorParts.length > 0 && opt.authors.length > 0) {
        const matchedParts = intent.allAuthorParts.filter((part) =>
          opt.authors.some((a) => matchesAuthorName(a, part))
        ).length;
        if (matchedParts > 0) {
          score += 15 + (matchedParts >= 2 ? 5 : 0);
        }
      }

      // Pénalité guides dérivés / fiches de lecture (ex. "Les mondes magiques d'Eragon" face à "Eragon")
      if (!queryAsksForGuide && DERIVATIVE_GUIDE_RE.test(opt.title.trim())) {
        score -= 40;
      }

      // Départage doux défavorisant les clubs/éditions abrégées (France Loisirs, Lire c'est partir) face aux éditions de référence
      if (!queryAsksForClub && opt.publisher && CLUB_OR_ABRIDGED_PUBLISHER_RE.test(opt.publisher)) {
        score -= 8;
      }

      if (opt.source === 'local') score += 8;
      if (opt.source === 'wikidata') score += 6;
      if ((opt.editionCount ?? 1) > 1) score += Math.min(8, (opt.editionCount ?? 1) * 2);
      return score;
    };

    relevantOptions.sort((a, b) => scoreOption(b) - scoreOption(a));

    const topOptions = relevantOptions.slice(0, 6);

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
   * Filet de sécurité post-OCR sur étagères penchées (0 appel IA supplémentaire) :
   * lorsque deux tranches voisines penchées se contaminent (ex. pied de tranche `volumeNumber`/`publisher`,
   * `series` ou `author` emprunté au voisin immédiat), relance une résolution ciblée en neutralisant le champ suspect
   * si la passe normale échoue ou renvoie un candidat hors-sujet.
   */
  private async resolveShelfHintWithNeighborGuard(
    hints: GeminiExtractedBookHint[],
    index: number
  ): Promise<{ options: PhotoCandidateOption[]; rescuedByNeighborGuard: boolean }> {
    const hint = hints[index];
    const initialOptions = await this.resolveHintOptions(hint);

    const neighbors = [hints[index - 1], hints[index + 1]].filter((n): n is GeminiExtractedBookHint => Boolean(n));
    if (neighbors.length === 0) {
      return { options: initialOptions, rescuedByNeighborGuard: false };
    }

    const nearTilt = isTiltedSpineHint(hint) || neighbors.some((n) => isTiltedSpineHint(n));
    const normTitle = normalizeTextKey(hint.title ?? '');
    const normSeries = normalizeTextKey(hint.series ?? '');
    const normPub = normalizeTextKey(hint.publisher ?? '');
    const normVol = normalizeSeriesNumber(hint.volumeNumber);
    const normAuthor = normalizeTextKey(hint.author ?? '');

    const isDifferentBookNeighbor = (n: GeminiExtractedBookHint): boolean => {
      const nTitle = normalizeTextKey(n.title ?? '');
      const nSeries = normalizeTextKey(n.series ?? '');
      if (normSeries && nSeries && normSeries === nSeries) return false;
      if (normTitle && nTitle && normTitle === nTitle) return false;
      return Boolean(nTitle || nSeries);
    };

    const sharedPubWithDiffNeighbor =
      Boolean(normPub) &&
      neighbors.some((n) => normalizeTextKey(n.publisher ?? '') === normPub && isDifferentBookNeighbor(n));
    const sharedVolWithDiffNeighbor =
      Boolean(normVol) &&
      neighbors.some((n) => normalizeSeriesNumber(n.volumeNumber) === normVol && isDifferentBookNeighbor(n));
    const sharedSeriesWithNeighbor =
      Boolean(normSeries) &&
      neighbors.some((n) => normalizeTextKey(n.series ?? '') === normSeries);
    const sharedAuthorWithDiffNeighbor =
      Boolean(normAuthor) &&
      neighbors.some((n) => normalizeTextKey(n.author ?? '') === normAuthor && isDifferentBookNeighbor(n));

    // Cas A : 0 résultat -> relances progressives ciblées sur champs potentiellement contaminés (zéro risque de régression)
    if (initialOptions.length === 0) {
      // Passe N1 : neutraliser volumeNumber et/ou publisher potentiellement empruntés au pied de tranche du voisin
      const dropVolN1 = Boolean(hint.volumeNumber) && (nearTilt || sharedVolWithDiffNeighbor);
      const dropPubN1 = Boolean(hint.publisher) && (nearTilt || sharedPubWithDiffNeighbor);
      if (dropVolN1 || dropPubN1) {
        const sanitizedN1: GeminiExtractedBookHint = {
          ...hint,
          ...(dropVolN1 ? { volumeNumber: undefined } : {}),
          ...(dropPubN1 ? { publisher: undefined } : {})
        };
        const rescuedN1 = await this.resolveHintOptions(sanitizedN1);
        if (rescuedN1.length > 0) {
          return { options: rescuedN1, rescuedByNeighborGuard: true };
        }
      }

      // Passe N2 : neutraliser `series` empruntée au voisin si le `title` de cette tranche est distinctif
      const sigTitle = stripGenericRelevanceWords(hint.title ?? '');
      if (
        hint.series &&
        (nearTilt || sharedSeriesWithNeighbor) &&
        sigTitle.length >= 4 &&
        normTitle !== normSeries
      ) {
        const sanitizedN2: GeminiExtractedBookHint = {
          ...hint,
          series: undefined,
          volumeNumber: nearTilt || sharedVolWithDiffNeighbor ? undefined : hint.volumeNumber,
          publisher: nearTilt || sharedPubWithDiffNeighbor ? undefined : hint.publisher
        };
        const rescuedN2 = await this.resolveHintOptions(sanitizedN2);
        if (rescuedN2.length > 0) {
          return { options: rescuedN2, rescuedByNeighborGuard: true };
        }
      }

      // Passe N3 : neutraliser `author` emprunté à un voisin d'un autre livre
      const sigPrimary = stripGenericRelevanceWords(hint.title || hint.series || '');
      if (hint.author && (nearTilt || sharedAuthorWithDiffNeighbor) && sigPrimary.length >= 4) {
        const sanitizedN3: GeminiExtractedBookHint = {
          ...hint,
          author: undefined,
          publisher: undefined,
          volumeNumber: nearTilt || sharedVolWithDiffNeighbor ? undefined : hint.volumeNumber
        };
        const rescuedN3 = await this.resolveHintOptions(sanitizedN3);
        if (rescuedN3.length > 0) {
          return { options: rescuedN3, rescuedByNeighborGuard: true };
        }
      }

      return { options: [], rescuedByNeighborGuard: false };
    }

    // Cas B : tranche penchée dont le top candidat ne correspond pas au titre lu alors qu'un champ (série/tome/éditeur) est partagé avec un voisin
    const sigTitle = stripGenericRelevanceWords(hint.title ?? '');
    const hasDistinctiveTitle = sigTitle.length >= 4 && normTitle !== normSeries;
    const topOpt = initialOptions[0];
    const topVol = normalizeSeriesNumber(topOpt.volumeNumber);
    const topCandText = `${topOpt.seriesName ?? ''} ${topOpt.title}`.trim();
    const targetText = hasDistinctiveTitle ? sigTitle : stripGenericRelevanceWords(hint.title || hint.series || '');
    const initialOverlap = targetText ? tokenOverlapRatio(targetText, topCandText) : 0;

    // B1 : série contaminée par un voisin penché (ex. Passe B a résolu le tome du voisin "Thorgal T.14" au lieu du titre distinctif "La Marque du diable")
    if (nearTilt && sharedSeriesWithNeighbor && hasDistinctiveTitle && initialOverlap < 0.25) {
      const sanitizedSeriesBleed: GeminiExtractedBookHint = {
        ...hint,
        series: undefined,
        volumeNumber: undefined,
        publisher: undefined,
        ...(sharedAuthorWithDiffNeighbor ? { author: undefined } : {})
      };
      const retrySeriesBleed = await this.resolveHintOptions(sanitizedSeriesBleed);
      if (retrySeriesBleed.length > 0) {
        const retryCandText = `${retrySeriesBleed[0].seriesName ?? ''} ${retrySeriesBleed[0].title}`.trim();
        const retryOverlap = tokenOverlapRatio(sigTitle, retryCandText);
        if (retryOverlap >= 0.45 && retryOverlap > initialOverlap + 0.25) {
          return { options: retrySeriesBleed, rescuedByNeighborGuard: true };
        }
      }
    }

    // B2 : tome ou éditeur contaminé par un voisin d'un autre livre sur tranche penchée
    if (nearTilt && (sharedVolWithDiffNeighbor || sharedPubWithDiffNeighbor)) {
      const volMismatch = Boolean(sharedVolWithDiffNeighbor && normVol && topVol && topVol !== normVol);
      const severeTitleMismatch = targetText.length >= 5 && initialOverlap < 0.25;
      const shouldRetryB =
        severeTitleMismatch || (hint.confidence !== 'high' && (volMismatch || initialOverlap < 0.45));

      if (shouldRetryB) {
        const sanitizedB: GeminiExtractedBookHint = {
          ...hint,
          ...(sharedVolWithDiffNeighbor ? { volumeNumber: undefined } : {}),
          ...(sharedPubWithDiffNeighbor ? { publisher: undefined } : {})
        };
        const retryB = await this.resolveHintOptions(sanitizedB);
        if (retryB.length > 0) {
          const retryCandText = `${retryB[0].seriesName ?? ''} ${retryB[0].title}`.trim();
          const retryOverlap = targetText ? tokenOverlapRatio(targetText, retryCandText) : 0;
          if (retryOverlap > initialOverlap + 0.1 || (volMismatch && retryOverlap >= initialOverlap)) {
            return { options: retryB, rescuedByNeighborGuard: true };
          }
        }
      }
    }

    return { options: initialOptions, rescuedByNeighborGuard: false };
  }

  /**
   * Crée un job Photo IA sur le serveur (vérifie et décrémente le quota mensuel).
   */
  async createPhotoJob(input: {
    userId: string;
    libraryId: string;
    isAdmin: boolean;
    mode?: 'auto' | 'shelf' | 'cover';
    imageDataUrl: string;
    mimeType: string;
    notifyOnComplete?: boolean;
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

    // Compresse la photo d'étagère en WebP haute définition (2048 px) sur disque (/data/covers/) — zéro image base64 dans SQLite
    const storedPreview = await this.coverService.storePreviewDataUrlAsWebp(input.imageDataUrl);
    const previewCoverKey = storedPreview.coverKey;

    const updatedUsage = this.userRepo.incrementAiUsage(input.userId, monthKey, now);

    const row = this.jobRepo.createJob({
      id: generateId('pjob'),
      type: 'photo_ocr',
      userId: input.userId,
      libraryId: input.libraryId,
      payload: {
        mode: input.mode ?? 'auto',
        mimeType: 'image/webp',
        previewCoverKey,
        notifyOnComplete: Boolean(input.notifyOnComplete)
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
    const mode: 'auto' | 'shelf' | 'cover' =
      ctx.payload.mode === 'cover' ? 'cover' : ctx.payload.mode === 'shelf' ? 'shelf' : 'auto';
    const notifyOnComplete = Boolean(ctx.payload.notifyOnComplete);
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
        notifyOnComplete,
        committedAt: null,
        items: [...items]
      };
    };

    ctx.reportProgress(0, total, buildPayload());

    const useShelfGuard = mode !== 'cover' && hints.length > 1;
    for (let i = 0; i < hints.length; i++) {
      const hint = hints[i];
      const { options, rescuedByNeighborGuard } = useShelfGuard
        ? await this.resolveShelfHintWithNeighborGuard(hints, i)
        : { options: await this.resolveHintOptions(hint), rescuedByNeighborGuard: false };
      const bestOpt = options[0] ?? null;
      const bestIsbn = bestOpt?.isbn13 ?? null;
      const alreadyStatus = bestIsbn && libraryId ? this.lookupFoyerOwnershipForOption(libraryId, bestOpt, bestIsbn) : 'none';

      // Vérifie la cohérence minimale titre/série pour distinguer une vraie identification d'une suggestion approximative (F4)
      const hintQuery = stripGenericRelevanceWords(`${hint.series ?? ''} ${hint.title ?? ''}`.trim());
      const bestCandText = bestOpt ? `${bestOpt.seriesName ?? ''} ${bestOpt.title}`.trim() : '';
      const bestOverlap = hintQuery && bestCandText ? tokenOverlapRatio(hintQuery, bestCandText) : 1;
      const isApproximateMatch = Boolean(bestOpt && hintQuery.length >= 4 && bestOverlap < 0.25);

      let status: PhotoJobItem['status'] = 'unresolved';
      if (options.length === 1 && hint.confidence === 'high' && !rescuedByNeighborGuard && !isApproximateMatch) {
        status = 'identified';
      } else if (options.length >= 1) {
        status =
          hint.confidence === 'high' && !rescuedByNeighborGuard && !isApproximateMatch
            ? 'identified'
            : 'doubt';
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
        committedBookId: null,
        committedAction: null,
        approximateMatch: isApproximateMatch
      });

      ctx.reportProgress(i + 1, total, buildPayload());
    }

    const finalResult = buildPayload();

    if (notifyOnComplete && ctx.job.user_id && this.onNotifyUser) {
      const remainingActive = this.jobRepo.countActivePhotoJobsForUser(ctx.job.user_id);
      // Envoie la notification Push dès que ce lot est terminé (ou qu'il était le dernier actif du lot multi-photos)
      if (remainingActive <= 1) {
        const detectedCount = items.length;
        void Promise.resolve(
          this.onNotifyUser({
            userId: ctx.job.user_id,
            title: 'Analyse Photo IA terminée',
            body:
              detectedCount > 0
                ? `${detectedCount} œuvre(s) détectée(s) — touchez pour vérifier et ajouter.`
                : 'Votre analyse photo est terminée.',
            url: '/scan?tab=photo'
          })
        ).catch(() => undefined);
      }
    }

    return { result: finalResult, total };
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

    const allHints = result.items.map((it) => it.hint);
    for (let idx = 0; idx < result.items.length; idx++) {
      const item = result.items[idx];
      if (item.status !== 'unresolved' || item.ignored) continue;
      const { options, rescuedByNeighborGuard } =
        result.mode === 'shelf'
          ? await this.resolveShelfHintWithNeighborGuard(allHints, idx)
          : { options: await this.resolveHintOptions(item.hint), rescuedByNeighborGuard: false };
      if (options.length > 0) {
        item.options = options;
        item.selectedOptionIsbn13 = options[0].isbn13;
        item.selectedCoverKey = null;
        item.selectedCoverUrl = null;
        item.status = options.length === 1 && !rescuedByNeighborGuard ? 'identified' : 'doubt';
        item.alreadyStatus = this.lookupFoyerOwnershipForOption(input.libraryId, options[0], options[0].isbn13);
        item.selected = item.alreadyStatus === 'none' && !rescuedByNeighborGuard;
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
    isIntegral?: boolean;
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
    archiveAfterCommit?: boolean;
  }): Promise<{
    committedCount: number;
    queued: boolean;
    targetCount: number;
    commitJob?: BackgroundJobView;
    job: BackgroundJobView;
  }> {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const result = this.parseResult(row);
    const shouldArchive = input.archiveAfterCommit !== false;

    const targets = result.items.filter((it) => {
      if (it.ignored || !it.selectedOptionIsbn13) return false;
      if (input.itemIds && input.itemIds.length > 0) return input.itemIds.includes(it.id);
      return it.selected;
    });

    // Pour les lots > 3 livres (ou demande explicite async), confier au BackgroundWorker existant -> réponse immédiate (< 50 ms, zéro timeout)
    if (targets.length > 0 && (input.async || targets.length > 3)) {
      const now = new Date().toISOString();
      let updatedPhotoRow = row;
      if (shouldArchive) {
        result.committedAt = now;
        this.jobRepo.updateJobProgress(row.id, row.progress_done, row.progress_total, now, result);
        updatedPhotoRow = this.jobRepo.archiveJob(row.id, now) ?? row;
        this.onJobChanged?.(updatedPhotoRow);
      }
      const commitRow = this.jobRepo.createJob({
        id: generateId('pcom'),
        type: 'photo_commit',
        userId: input.userId,
        libraryId: input.libraryId,
        payload: {
          photoJobId: row.id,
          targetStatus: input.targetStatus,
          itemIds: targets.map((t) => t.id),
          archiveAfterCommit: shouldArchive
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
        job: mapJobRowToView(updatedPhotoRow)
      };
    }

    const { committedCount, updatedJob } = await this.commitTargetsWithConcurrency({
      row,
      result,
      targets,
      userId: input.userId,
      libraryId: input.libraryId,
      targetStatus: input.targetStatus,
      archiveAfterCommit: shouldArchive
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
    const archiveAfterCommit = ctx.payload.archiveAfterCommit !== false;
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
      archiveAfterCommit,
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
    archiveAfterCommit?: boolean;
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
              item.committedAction = params.targetStatus;
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
    if (params.archiveAfterCommit !== false) {
      params.result.committedAt = now;
    }
    this.jobRepo.updateJobProgress(params.row.id, params.row.progress_done, params.row.progress_total, now, params.result);
    if (params.archiveAfterCommit !== false) {
      this.jobRepo.archiveJob(params.row.id, now);
    }
    const updated = this.jobRepo.findJobById(params.row.id)!;
    this.onJobChanged?.(updated);

    return { committedCount, updatedJob: mapJobRowToView(updated) };
  }

  listPhotoHistory(input: { userId: string; libraryId: string; retentionDays?: number }): BackgroundJobView[] {
    const retentionDays = Math.min(90, Math.max(1, input.retentionDays ?? 30));
    const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.jobRepo.listPhotoHistoryForUser(input.userId, input.libraryId, cutoffIso, 100);
    return rows.map(mapJobRowToView);
  }

  archivePhotoJob(input: { userId: string; libraryId: string; jobId: string }): BackgroundJobView {
    const row = this.assertOwnedJob(input.jobId, input.userId, input.libraryId);
    const now = new Date().toISOString();
    const archived = this.jobRepo.archiveJob(row.id, now) ?? row;
    this.onJobChanged?.(archived);
    return mapJobRowToView(archived);
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
