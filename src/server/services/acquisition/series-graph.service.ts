// src/server/services/acquisition/series-graph.service.ts
// Étage 3 : Modèle 2 étages Franchise -> Découpage Éditorial (fusion/séparation par contenu) + Expansion par le Graphe d'abord.

import crypto from 'node:crypto';
import {
  cleanSeriesName,
  cleanTitle,
  getLevenshteinDistance,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../../shared/bibliographic/text-normalize.util';
import { classifyBookMetadata } from '../../../shared/bibliographic/category-classifier';
import type { BibliographicConnectors, GraphSeriesWork } from '../../connectors/types';
import type { BookRow, CatalogRepository, FranchiseRow, SeriesRow } from '../../repositories/catalog.repo';
import type { CoverService } from '../cover.service';

const GENERIC_VOLUME_TITLE_RE = /^(?:tome|vol\.?|volume|t\.?|n°|#)?\s*\d+(?:\s*[-–]\s*\d+)?$/i;
const SERIES_PREFIX_NOISE_RE = /^(?:les\s+aventures\s+d[e'’]\s*|une\s+aventure\s+d[e'’]\s*|la\s+s[ée]rie\s+)/i;

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Extrait le tronc commun normalisé d'une franchise (ex: "Astérix, la grande collection" -> "asterix",
 * "Les Aventures d'Astérix" -> "asterix") sans liste éditoriale codée en dur.
 */
export function extractFranchiseBaseName(rawSeriesName: string): { baseName: string; normalizedKey: string } {
  const cleaned = cleanSeriesName(rawSeriesName);
  // Si le nom contient une virgule ou un séparateur de sous-collection ("Astérix, la grande collection"),
  // la tête avant la virgule porte le nom de la franchise
  const head = cleaned.split(/\s*[,—–]\s*/)[0].trim();
  const stripped = head.replace(SERIES_PREFIX_NOISE_RE, '').trim();
  const baseName = stripped.length >= 2 ? stripped : cleaned;
  return {
    baseName,
    normalizedKey: normalizeTextKey(baseName)
  };
}

export function isGenericVolumeTitle(title: string, seriesName: string): boolean {
  const cleanT = normalizeTextKey(title);
  const cleanS = normalizeTextKey(seriesName);
  if (!cleanT) return true;
  if (GENERIC_VOLUME_TITLE_RE.test(title.trim())) return true;
  if (cleanS && cleanT === cleanS) return true;
  if (cleanS && cleanT.startsWith(cleanS)) {
    const rest = cleanT.slice(cleanS.length).trim();
    if (!rest || GENERIC_VOLUME_TITLE_RE.test(rest)) return true;
  }
  return false;
}

export interface ContentComparisonResult {
  sameContent: boolean;
  reason: string;
}

/**
 * Compare deux ouvrages occupant le même numéro de tome N d'une Franchise pour décider algorithmiquement
 * s'ils appartiennent au MÊME découpage ou à un AUTRE découpage éditorial.
 * Règle d'or : le CONTENU (Q-ID + Titre + Pagination), jamais le seul libellé de collection.
 */
export function compareSameVolumeContent(
  existing: Pick<BookRow, 'title' | 'normalized_title' | 'wikidata_qid' | 'page_count' | 'collection_name' | 'publisher'>,
  incoming: {
    title: string;
    wikidataWorkQid?: string | null;
    pageCount?: number | null;
    collectionName?: string | null;
    publisher?: string | null;
    seriesName: string;
  }
): ContentComparisonResult {
  // 1. Ancrage identique Wikidata -> même œuvre garantie
  if (existing.wikidata_qid && incoming.wikidataWorkQid && existing.wikidata_qid === incoming.wikidataWorkQid) {
    return { sameContent: true, reason: 'same_wikidata_qid' };
  }

  const existingGeneric = isGenericVolumeTitle(existing.title, incoming.seriesName);
  const incomingGeneric = isGenericVolumeTitle(incoming.title, incoming.seriesName);

  const pageRatio =
    existing.page_count && incoming.pageCount && existing.page_count > 0 && incoming.pageCount > 0
      ? Math.max(existing.page_count, incoming.pageCount) / Math.min(existing.page_count, incoming.pageCount)
      : 1;

  const existingCol = normalizeTextKey(existing.collection_name || '');
  const incomingCol = normalizeTextKey(incoming.collectionName || '');
  const hasDistinctCollection = Boolean(incomingCol && existingCol !== incomingCol);
  const hasDistinctPublisher = Boolean(
    incoming.publisher &&
      existing.publisher &&
      normalizeTextKey(existing.publisher) !== normalizeTextKey(incoming.publisher)
  );

  // 2. Titres génériques ("Tome 1") : ne pas séparer sur le titre, arbitrer uniquement si pagination fortement différente + édition distincte
  if (existingGeneric || incomingGeneric) {
    if (pageRatio >= 1.65 && (hasDistinctCollection || hasDistinctPublisher)) {
      return { sameContent: false, reason: 'generic_title_divergent_pagination_and_edition' };
    }
    return { sameContent: true, reason: 'generic_title_compatible' };
  }

  // 3. Comparaison sémantique des titres propres
  const normIn = normalizeTextKey(incoming.title);
  const normEx = existing.normalized_title || normalizeTextKey(existing.title);

  if (normIn === normEx) {
    return { sameContent: true, reason: 'exact_normalized_title' };
  }

  const overlap = Math.max(tokenOverlapRatio(incoming.title, existing.title), tokenOverlapRatio(existing.title, incoming.title));
  const dist = getLevenshteinDistance(normIn, normEx);

  if (overlap >= 0.6 || dist <= 2) {
    return { sameContent: true, reason: 'close_title_match' };
  }

  // 4. Titres clairement distincts + signature éditoriale ou pagination divergente -> autre découpage éditorial !
  if (hasDistinctCollection || hasDistinctPublisher || pageRatio >= 1.55) {
    return { sameContent: false, reason: 'distinct_title_and_edition_signature' };
  }

  // Même éditeur, même collection, pagination similaire mais titre différent (ex. retraduction) -> conserver même découpage
  return { sameContent: true, reason: 'same_edition_probable_retranslation' };
}

export interface ResolveSeriesCutInput {
  seriesName: string;
  wikidataSeriesQid?: string | null;
  bnfEnsembleId?: string | null;
  bookTitle: string;
  volumeNumber: number | null;
  isHorsSerie: boolean;
  isIntegral: boolean;
  wikidataWorkQid?: string | null;
  pageCount?: number | null;
  collectionName?: string | null;
  publisher?: string | null;
  authors: string[];
  now?: string;
}

export interface SeriesExpansionReport {
  seriesId: string;
  addedCount: number;
  updatedCount: number;
  totalVolumes: number;
  sourcesUsed: string[];
}

export class SeriesGraphService {
  private readonly catalogRepo: CatalogRepository;
  private readonly connectors: BibliographicConnectors;
  private readonly coverService?: CoverService;

  constructor(deps: {
    catalogRepo: CatalogRepository;
    connectors: BibliographicConnectors;
    coverService?: CoverService;
  }) {
    this.catalogRepo = deps.catalogRepo;
    this.connectors = deps.connectors;
    this.coverService = deps.coverService;
  }

  /**
   * Trouve ou crée la Franchise (niveau macro) puis sélectionne ou crée le bon Découpage Éditorial (niveau méso).
   */
  resolveOrCreateSeriesCut(input: ResolveSeriesCutInput): { franchise: FranchiseRow; series: SeriesRow } {
    const now = input.now ?? new Date().toISOString();
    const { baseName, normalizedKey } = extractFranchiseBaseName(input.seriesName);

    // 1. Résolution de la Franchise (Q-ID d'abord, puis clé normalisée)
    let franchise: FranchiseRow | null = null;
    if (input.wikidataSeriesQid) {
      franchise = this.catalogRepo.findFranchiseByWikidataQid(input.wikidataSeriesQid);
    }
    if (!franchise) {
      franchise = this.catalogRepo.findFranchiseByNormalizedKey(normalizedKey);
    }
    if (!franchise) {
      franchise = this.catalogRepo.createFranchise({
        id: generateId('fr'),
        canonicalName: baseName,
        normalizedKey,
        wikidataQid: input.wikidataSeriesQid ?? null,
        now
      });
    } else if (input.wikidataSeriesQid && !franchise.wikidata_qid) {
      this.catalogRepo.updateFranchiseWikidata(franchise.id, input.wikidataSeriesQid, now);
      franchise = this.catalogRepo.findFranchiseById(franchise.id)!;
    }

    // 2. Récupération des découpages existants de cette Franchise
    const existingCuts = this.catalogRepo.findSeriesByFranchiseId(franchise.id);

    if (existingCuts.length === 0) {
      const created = this.catalogRepo.createSeries({
        id: generateId('ser'),
        franchiseId: franchise.id,
        canonicalName: baseName,
        normalizedKey,
        editionSignature: '',
        aliases: input.seriesName !== baseName ? [input.seriesName] : [],
        primaryAuthors: input.authors,
        wikidataQid: input.wikidataSeriesQid ?? null,
        bnfEnsembleIds: input.bnfEnsembleId ? [input.bnfEnsembleId] : [],
        now
      });
      return { franchise, series: created };
    }

    const incomingSig = normalizeTextKey(input.collectionName || '');

    // 3. Test de compatibilité par CONTENU sur chaque découpage existant
    // Priorité au découpage dont la signature éditoriale correspond déjà si plusieurs découpages coexistent
    const orderedCuts = [...existingCuts].sort((a, b) => {
      const aExact = incomingSig && a.edition_signature === incomingSig ? 1 : 0;
      const bExact = incomingSig && b.edition_signature === incomingSig ? 1 : 0;
      return bExact - aExact;
    });

    for (const cut of orderedCuts) {
      if (input.volumeNumber !== null && !input.isHorsSerie && !input.isIntegral) {
        const existingVol = this.catalogRepo.findBookInSeriesByVolume(cut.id, input.volumeNumber);
        if (existingVol) {
          const cmp = compareSameVolumeContent(existingVol, {
            title: input.bookTitle,
            wikidataWorkQid: input.wikidataWorkQid,
            pageCount: input.pageCount,
            collectionName: input.collectionName,
            publisher: input.publisher,
            seriesName: cut.canonical_name
          });
          if (cmp.sameContent) {
            const merged = this.catalogRepo.mergeSeriesMetadataAutomatic(cut.id, {
              franchiseId: franchise.id,
              alias: input.seriesName !== cut.canonical_name ? input.seriesName : undefined,
              authors: input.authors,
              wikidataQid: input.wikidataSeriesQid ?? null,
              bnfEnsembleId: input.bnfEnsembleId ?? null,
              now
            })!;
            return { franchise, series: merged };
          }
          // Contenu divergent sur ce tome N -> ne pas fusionner dans `cut`, continuer la recherche
          continue;
        }
      }

      // Pas de tome N existant dans ce découpage :
      // Si un découpage dédié existe déjà pour la même signature, ou si c'est le découpage principal compatible en pagination
      const cutBooks = this.catalogRepo.listBooksBySeriesId(cut.id);
      const avgPages = this.computeAveragePages(cutBooks);
      const paginationCompatible =
        !avgPages ||
        !input.pageCount ||
        (Math.max(avgPages, input.pageCount) / Math.min(avgPages, input.pageCount) < 1.65);

      const exactSignatureMatch = Boolean(incomingSig && cut.edition_signature === incomingSig);
      const defaultCutCompatible = cut.edition_signature === '' && paginationCompatible;

      if (exactSignatureMatch || defaultCutCompatible) {
        const merged = this.catalogRepo.mergeSeriesMetadataAutomatic(cut.id, {
          franchiseId: franchise.id,
          alias: input.seriesName !== cut.canonical_name ? input.seriesName : undefined,
          authors: input.authors,
          wikidataQid: input.wikidataSeriesQid ?? null,
          bnfEnsembleId: input.bnfEnsembleId ?? null,
          now
        })!;
        return { franchise, series: merged };
      }
    }

    // 4. Preuve algorithmique d'un nouveau découpage éditorial pour la même Franchise !
    const newSignature =
      incomingSig ||
      normalizeTextKey(input.publisher || '') ||
      `cut_${existingCuts.length + 1}`;

    const existingWithSig = this.catalogRepo.findSeriesByKeyAndSignature(normalizedKey, newSignature);
    if (existingWithSig) {
      return { franchise, series: existingWithSig };
    }

    const labelSuffix = input.collectionName?.trim() || input.publisher?.trim() || `Édition ${existingCuts.length + 1}`;
    const newCut = this.catalogRepo.createSeries({
      id: generateId('ser'),
      franchiseId: franchise.id,
      canonicalName: `${baseName} (${labelSuffix})`,
      normalizedKey,
      editionSignature: newSignature,
      aliases: [input.seriesName],
      primaryAuthors: input.authors,
      wikidataQid: null, // Un redécoupage alternatif n'usurpe pas le Q-ID canonique de la lignée principale
      bnfEnsembleIds: input.bnfEnsembleId ? [input.bnfEnsembleId] : [],
      now
    });

    return { franchise, series: newCut };
  }

  private computeAveragePages(books: BookRow[]): number | null {
    const pages = books
      .filter((b) => b.is_integral === 0 && typeof b.page_count === 'number' && b.page_count > 0)
      .map((b) => b.page_count as number);
    if (pages.length === 0) return null;
    return pages.reduce((sum, p) => sum + p, 0) / pages.length;
  }

  /**
   * Expansion d'une série PAR LE GRAPHE D'ABORD (Wikidata P179/P1545 + Inventaire P179/P629),
   * autorisant la création de tomes officiels même avant résolution de leur ISBN FR,
   * puis BnF 460$3 (`bib.ens2bib`) en filet de sécurité.
   */
  async expandSeriesByGraph(seriesId: string): Promise<SeriesExpansionReport> {
    const series = this.catalogRepo.findSeriesById(seriesId);
    if (!series) {
      return { seriesId, addedCount: 0, updatedCount: 0, totalVolumes: 0, sourcesUsed: [] };
    }

    const now = new Date().toISOString();
    const sourcesUsed: string[] = [];
    const graphWorks: GraphSeriesWork[] = [];

    // 1. Graphe Wikidata P179/P1545
    if (series.wikidata_qid) {
      try {
        const wdWorks = await this.connectors.wikidata.fetchSeriesWorksByQid(series.wikidata_qid);
        if (wdWorks.length > 0) {
          sourcesUsed.push('wikidata');
          graphWorks.push(...wdWorks);
        }
      } catch {
        // continue
      }

      // 2. Complément graphe Inventaire (ISBN FR P629 + œuvres P179)
      try {
        const invWorks = await this.connectors.inventaire.fetchSeriesWorks(`wd:${series.wikidata_qid}`);
        if (invWorks.length > 0) {
          sourcesUsed.push('inventaire');
          this.mergeGraphWorks(graphWorks, invWorks);
        }
      } catch {
        // continue
      }
    }

    // 3. Filet de sécurité BnF 460$3 (bib.ens2bib) pour les séries franco-belges ou pour compléter les ISBN FR
    const bnfEnsembleIds = this.parseJsonArray(series.bnf_ensemble_ids_json);
    for (const ensId of bnfEnsembleIds) {
      try {
        const bnfWorks = await this.connectors.bnf.searchByEnsembleId(ensId, 80);
        if (bnfWorks.length > 0) {
          if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
          this.mergeGraphWorks(graphWorks, bnfWorks);
        }
      } catch {
        // continue
      }
    }

    let addedCount = 0;
    let updatedCount = 0;

    for (const work of graphWorks) {
      const cleanT = cleanTitle(work.title);
      if (!cleanT) continue;
      const normT = normalizeTextKey(cleanT);

      // Recherche d'un tome déjà existant dans ce découpage (par Q-ID, ISBN, titre normalisé, ou n° de tome compatible)
      let existingBook: BookRow | null =
        (work.wikidataQid ? this.catalogRepo.findBookByWikidataQid(work.wikidataQid) : null) ??
        work.isbn13s.map((isbn) => this.catalogRepo.findBookByIsbn13(isbn)).find((b): b is BookRow => Boolean(b)) ??
        this.catalogRepo.findBookInSeriesByNormalizedTitle(series.id, normT);

      if (!existingBook && work.volumeNumber && !work.isHorsSerie && !work.isIntegral) {
        const volCandidate = this.catalogRepo.findBookInSeriesByVolume(series.id, work.volumeNumber);
        if (volCandidate) {
          const cmp = compareSameVolumeContent(volCandidate, {
            title: cleanT,
            wikidataWorkQid: work.wikidataQid,
            pageCount: work.pageCount,
            collectionName: work.collectionName,
            publisher: work.publisher,
            seriesName: series.canonical_name
          });
          if (cmp.sameContent) {
            existingBook = volCandidate;
          } else {
            // Ce tome BnF appartient à un autre découpage éditorial -> ne pas polluer ce découpage
            continue;
          }
        }
      }

      // Téléchargement optionnel de couverture WebP si disponible et pas encore de couverture
      let coverKey: string | null = existingBook?.cover_key ?? null;
      if (!coverKey && work.coverUrl && this.coverService) {
        const stored = await this.coverService.ingestFromExternalUrl(work.coverUrl);
        if (stored) coverKey = stored.coverKey;
      }

      const workCanonicalId =
        existingBook?.work_canonical_id ??
        (work.wikidataQid
          ? `wd:${work.wikidataQid}`
          : work.inventaireUri
            ? `inv:${work.inventaireUri}`
            : `ser:${series.id}:vol:${work.volumeNumber ?? 'x'}:${normT.slice(0, 40)}`);

      const classification = classifyBookMetadata({
        title: cleanT,
        series: series.canonical_name,
        publisher: work.publisher ?? undefined,
        collection: work.collectionName ?? undefined
      });

      const saved = this.catalogRepo.upsertBookAutomatic({
        id: existingBook?.id ?? generateId('bk'),
        workCanonicalId,
        seriesId: series.id,
        title: cleanT,
        normalizedTitle: normT,
        volumeNumber: work.volumeNumber ?? null,
        volumeLabel: work.volumeLabel ?? (work.volumeNumber ? String(work.volumeNumber) : null),
        sortOrder: work.sortOrder ?? work.volumeNumber ?? null,
        isHorsSerie: Boolean(work.isHorsSerie),
        isIntegral: Boolean(work.isIntegral),
        includedVolumes: [],
        authors: work.authors,
        scriptwriters: work.scriptwriters ?? [],
        illustrators: work.illustrators ?? [],
        publisher: work.publisher ?? null,
        collectionName: work.collectionName ?? null,
        publishYear: work.publishYear ?? null,
        pageCount: work.pageCount ?? null,
        description: null,
        language: 'fr',
        mainCategory: classification.mainCategory,
        subgenres: classification.subgenres,
        coverKey,
        wikidataQid: work.wikidataQid ?? null,
        inventaireUri: work.inventaireUri ?? null,
        sourceOrigin: 'auto',
        now
      });

      if (existingBook) {
        updatedCount++;
      } else {
        addedCount++;
      }

      for (const isbn13 of work.isbn13s) {
        this.catalogRepo.upsertBookEdition({
          isbn13,
          bookId: saved.id,
          publisher: work.publisher ?? null,
          collectionName: work.collectionName ?? null,
          publishYear: work.publishYear ?? null,
          pageCount: work.pageCount ?? null,
          coverKey,
          source: work.source,
          now
        });
      }
    }

    const totalVolumes = this.catalogRepo.recountSeriesVolumes(series.id, now);
    this.catalogRepo.mergeSeriesMetadataAutomatic(series.id, {
      isCompleteExpanded: true,
      lastCheckedAt: now,
      now
    });

    return {
      seriesId: series.id,
      addedCount,
      updatedCount,
      totalVolumes,
      sourcesUsed
    };
  }

  private mergeGraphWorks(target: GraphSeriesWork[], incoming: GraphSeriesWork[]): void {
    for (const item of incoming) {
      const normTitle = normalizeTextKey(item.title);
      const match = target.find(
        (existing) =>
          (item.wikidataQid && existing.wikidataQid === item.wikidataQid) ||
          (normTitle && normalizeTextKey(existing.title) === normTitle) ||
          (item.volumeNumber !== null &&
            item.volumeNumber !== undefined &&
            existing.volumeNumber === item.volumeNumber &&
            tokenOverlapRatio(item.title, existing.title) >= 0.5)
      );

      if (!match) {
        target.push({ ...item, isbn13s: [...item.isbn13s], authors: [...item.authors] });
      } else {
        for (const isbn of item.isbn13s) {
          if (!match.isbn13s.includes(isbn)) match.isbn13s.push(isbn);
        }
        for (const a of item.authors) {
          if (!match.authors.some((ex) => normalizeTextKey(ex) === normalizeTextKey(a))) {
            match.authors.push(a);
          }
        }
        if (!match.coverUrl && item.coverUrl) match.coverUrl = item.coverUrl;
        if (!match.publisher && item.publisher) match.publisher = item.publisher;
        if (!match.publishYear && item.publishYear) match.publishYear = item.publishYear;
        if (!match.pageCount && item.pageCount) match.pageCount = item.pageCount;
        if (!match.wikidataQid && item.wikidataQid) match.wikidataQid = item.wikidataQid;
        if (!match.inventaireUri && item.inventaireUri) match.inventaireUri = item.inventaireUri;
      }
    }
  }

  private parseJsonArray(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
}
