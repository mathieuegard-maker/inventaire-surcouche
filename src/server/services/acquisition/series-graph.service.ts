// src/server/services/acquisition/series-graph.service.ts
// Étage 3 : Modèle 2 étages Franchise -> Découpage Éditorial (fusion/séparation par contenu) + Expansion par le Graphe d'abord.

import crypto from 'node:crypto';
import {
  cleanTitle,
  extractFranchiseBaseName,
  getLevenshteinDistance,
  isCompatibleSeriesName,
  isGenericVolumeTitle,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../../shared/bibliographic/text-normalize.util';
import { classifyBookMetadata } from '../../../shared/bibliographic/category-classifier';
import type { BookMainCategory } from '../../../shared/types/domain.types';
import type { BibliographicConnectors, GraphSeriesWork } from '../../connectors/types';
import type { BookRow, CatalogRepository, FranchiseRow, SeriesRow } from '../../repositories/catalog.repo';
import type { CoverService } from '../cover.service';

export { extractFranchiseBaseName, isGenericVolumeTitle };

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
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

  const existingCol =
    existing.collection_name && !isCompatibleSeriesName(existing.collection_name, incoming.seriesName)
      ? normalizeTextKey(existing.collection_name)
      : '';
  const incomingCol =
    incoming.collectionName && !isCompatibleSeriesName(incoming.collectionName, incoming.seriesName)
      ? normalizeTextKey(incoming.collectionName)
      : '';
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
  mainCategory?: BookMainCategory | null;
  authors: string[];
  now?: string;
}

type MediaFamily = 'graphic' | 'prose' | 'neutral';

function getCategoryMediaFamily(category?: string | null): MediaFamily {
  if (!category) return 'neutral';
  if (category === 'BD' || category === 'Manga' || category === 'Comics') return 'graphic';
  if (category === 'Roman' || category === 'Essai' || category === 'Poésie / Théâtre') return 'prose';
  return 'neutral';
}

export interface SeriesExpansionReport {
  seriesId: string;
  addedCount: number;
  updatedCount: number;
  totalVolumes: number;
  sourcesUsed: string[];
  incompleteVolumeCount: number;
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

    const effectiveCollectionName =
      input.collectionName && !isCompatibleSeriesName(input.collectionName, baseName)
        ? input.collectionName.trim()
        : null;
    const incomingSig = normalizeTextKey(effectiveCollectionName || '');

    // 3. Test de compatibilité par CONTENU sur chaque découpage existant
    // Priorité au découpage dont la signature éditoriale correspond déjà si plusieurs découpages coexistent
    const orderedCuts = [...existingCuts].sort((a, b) => {
      const aExact = incomingSig && a.edition_signature === incomingSig ? 1 : 0;
      const bExact = incomingSig && b.edition_signature === incomingSig ? 1 : 0;
      return bExact - aExact;
    });

    const incomingMedia = getCategoryMediaFamily(input.mainCategory);
    const normIncomingTitle = normalizeTextKey(input.bookTitle);

    for (const cut of orderedCuts) {
      const cutBooks = this.catalogRepo.listBooksBySeriesId(cut.id);

      // Séparation média structurelle (ex. Nestor Burma BD vs Nestor Burma Romans dans la même Franchise)
      if (incomingMedia !== 'neutral') {
        const cutMedia = this.getSeriesMediaFamily(cutBooks);
        if (cutMedia !== 'neutral' && cutMedia !== incomingMedia) {
          continue;
        }
      }

      // Même œuvre déjà présente dans ce découpage (Q-ID ou titre distinctif exact / sans préfixe "Les Aventures de...") -> rattacher ici
      const strippedIncomingTitle = extractFranchiseBaseName(input.bookTitle).normalizedKey;
      const matchesExistingWork =
        Boolean(input.wikidataWorkQid && cutBooks.some((b) => b.wikidata_qid === input.wikidataWorkQid)) ||
        Boolean(
          normIncomingTitle &&
            !isGenericVolumeTitle(input.bookTitle, cut.canonical_name) &&
            cutBooks.some(
              (b) =>
                Boolean(b.is_integral) === Boolean(input.isIntegral) &&
                !isGenericVolumeTitle(b.title, cut.canonical_name) &&
                (b.normalized_title === normIncomingTitle ||
                  (Boolean(strippedIncomingTitle) &&
                    extractFranchiseBaseName(b.title).normalizedKey === strippedIncomingTitle))
            )
        );
      if (matchesExistingWork) {
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
      // Ne créer un découpage séparé sur la pagination seule QUE pour un tome standard numéroté portant une collection éditoriale distincte (ex. Urban Nomad),
      // jamais pour une intégrale, un hors-série ou une édition luxe sans collection distincte (ex. Astérix 126 p.).
      const avgPages = this.computeAveragePages(cutBooks);
      const needsPaginationCheck =
        Boolean(incomingSig) && input.volumeNumber !== null && !input.isHorsSerie && !input.isIntegral;
      const paginationCompatible =
        !needsPaginationCheck ||
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

    const labelSuffix = effectiveCollectionName || input.publisher?.trim() || `Édition ${existingCuts.length + 1}`;
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

  private getSeriesMediaFamily(books: BookRow[]): MediaFamily {
    let graphicCount = 0;
    let proseCount = 0;
    for (const b of books) {
      const catFam = getCategoryMediaFamily(b.main_category);
      const hasIllustrators = this.parseJsonArray(b.illustrators_json).length > 0;
      if (catFam === 'graphic' || hasIllustrators) graphicCount++;
      else if (catFam === 'prose') proseCount++;
    }
    if (graphicCount > 0 && graphicCount >= proseCount) return 'graphic';
    if (proseCount > 0 && proseCount > graphicCount) return 'prose';
    return 'neutral';
  }

  /**
   * Expansion d'une série PAR LE GRAPHE D'ABORD (Wikidata P179/P1545 + Inventaire P179/P629),
   * autorisant la création de tomes officiels même avant résolution de leur ISBN FR,
   * puis BnF 460$3 (`bib.ens2bib`) en filet de sécurité.
   */
  async expandSeriesByGraph(seriesId: string): Promise<SeriesExpansionReport> {
    const series = this.catalogRepo.findSeriesById(seriesId);
    if (!series) {
      return { seriesId, addedCount: 0, updatedCount: 0, totalVolumes: 0, sourcesUsed: [], incompleteVolumeCount: 0 };
    }

    const now = new Date().toISOString();
    const sourcesUsed: string[] = [];
    const graphWorks: GraphSeriesWork[] = [];
    const primaryAuthors = this.parseJsonArray(series.primary_authors_json);
    const seriesMediaFamily = this.getSeriesMediaFamily(this.catalogRepo.listBooksBySeriesId(series.id));

    const fetchGraphForCandidate = async (
      qid: string | null,
      invUri: string | null
    ): Promise<{ wdWorks: GraphSeriesWork[]; invWorks: GraphSeriesWork[] }> => {
      let wdWorks: GraphSeriesWork[] = [];
      let invWorks: GraphSeriesWork[] = [];
      if (qid) {
        try {
          wdWorks = await this.connectors.wikidata.fetchSeriesWorksByQid(qid);
        } catch {
          // continue
        }
      }
      if (invUri) {
        try {
          invWorks = await this.connectors.inventaire.fetchSeriesWorks(invUri);
        } catch {
          // continue
        }
      }
      return { wdWorks, invWorks };
    };

    const appendGraphResults = (wdWorks: GraphSeriesWork[], invWorks: GraphSeriesWork[]) => {
      if (wdWorks.length > 0) {
        if (!sourcesUsed.includes('wikidata')) sourcesUsed.push('wikidata');
        graphWorks.push(...wdWorks);
      }
      if (invWorks.length > 0) {
        if (!sourcesUsed.includes('inventaire')) sourcesUsed.push('inventaire');
        this.mergeGraphWorks(graphWorks, invWorks, series.canonical_name);
      }
    };

    if (series.wikidata_qid) {
      // 1 & 2. Graphe déjà ancré (Wikidata P179/P1545 + Inventaire P179/P629)
      const { wdWorks, invWorks } = await fetchGraphForCandidate(series.wikidata_qid, `wd:${series.wikidata_qid}`);
      appendGraphResults(wdWorks, invWorks);
    } else {
      // 0. Découverte de rattrapage Graphe par la preuve :
      //    On teste les candidats ordonnés (Inventaire puis Wikidata) et on ne verrouille wikidata_qid en base
      //    QUE si le candidat renvoie effectivement des œuvres (évite les Q-ID "franchise médiatique" / album isolé à 0 œuvre).
      const candidates: Array<{ wikidataQid: string | null; inventaireSeriesUri: string | null }> = [];
      const seenKeys = new Set<string>();
      const addCandidate = (wikidataQid: string | null, inventaireSeriesUri: string | null) => {
        const cleanQid = wikidataQid ? wikidataQid.toUpperCase() : null;
        const cleanInv = inventaireSeriesUri || (cleanQid ? `wd:${cleanQid}` : null);
        const key = `${cleanQid ?? ''}|${cleanInv ?? ''}`;
        if ((!cleanQid && !cleanInv) || seenKeys.has(key)) return;
        seenKeys.add(key);
        candidates.push({ wikidataQid: cleanQid, inventaireSeriesUri: cleanInv });
      };

      try {
        const invFound = await this.connectors.inventaire.searchSeriesUri?.(series.canonical_name);
        if (invFound) {
          addCandidate(invFound.wikidataQid ?? null, invFound.seriesUri);
        }
      } catch {
        // continue
      }

      try {
        if (this.connectors.wikidata.searchSeriesQids) {
          const wdQids = await this.connectors.wikidata.searchSeriesQids(series.canonical_name, seriesMediaFamily);
          for (const qid of wdQids) addCandidate(qid, `wd:${qid}`);
        } else if (this.connectors.wikidata.searchSeriesQid) {
          const wdFound = await this.connectors.wikidata.searchSeriesQid(series.canonical_name);
          if (wdFound) addCandidate(wdFound, `wd:${wdFound}`);
        }
      } catch {
        // continue
      }

      for (const cand of candidates.slice(0, 3)) {
        const { wdWorks, invWorks } = await fetchGraphForCandidate(cand.wikidataQid, cand.inventaireSeriesUri);
        if (wdWorks.length > 0 || invWorks.length > 0) {
          appendGraphResults(wdWorks, invWorks);
          if (cand.wikidataQid) {
            this.catalogRepo.mergeSeriesMetadataAutomatic(series.id, {
              wikidataQid: cand.wikidataQid,
              now
            });
          }
          break;
        }
      }
    }

    // 3. Phase 3A — Complément multi-dossiers BnF + Règle "Zéro trou silencieux" (continuité 1 -> maxVol + sondage suite).
    //    Tous les candidats BnF restent strictement filtrés par compatibilité média (BD vs Roman) et nom de série.
    const isCompatibleMediaWork = (work: GraphSeriesWork): boolean => {
      if (seriesMediaFamily === 'graphic' && work.contentKind === 'text_only') return false;
      if (seriesMediaFamily === 'prose' && work.contentKind === 'illustrated') return false;
      return true;
    };

    const MAX_BNF_ENSEMBLES = 5;
    const MAX_HOLE_PROBES = 12;
    const bnfEnsembleIds = new Set<string>(this.parseJsonArray(series.bnf_ensemble_ids_json));
    const queriedEnsembles = new Set<string>();
    const hasCanonicalWikidataGraph = sourcesUsed.includes('wikidata') && graphWorks.length >= 2;

    const queryAndMergeEnsemble = async (ensId: string): Promise<void> => {
      if (queriedEnsembles.has(ensId) || queriedEnsembles.size >= MAX_BNF_ENSEMBLES) return;
      queriedEnsembles.add(ensId);
      try {
        const bnfWorks = (await this.connectors.bnf.searchByEnsembleId(ensId, 80)).filter(isCompatibleMediaWork);
        if (bnfWorks.length > 0) {
          if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
          this.mergeGraphWorks(graphWorks, bnfWorks, series.canonical_name, hasCanonicalWikidataGraph);
        }
      } catch {
        // continue
      }
    };

    for (const ensId of bnfEnsembleIds) {
      await queryAndMergeEnsemble(ensId);
    }

    // Découverte multi-dossiers BnF :
    // - Sur les séries multi-auteurs (nom >= 5 car.), interroger SANS verrouiller sur le seul auteur du tome scanné
    //   (ex. Spirou T.1 Franquin doit aussi trouver les dossiers Fournier / Tome & Janry / Yoann / Schwartz).
    // - Sur un titre court ambigu (< 5 car., ex. "Bug"), conserver le filtre auteur.
    const isAmbiguousShortSeries = normalizeTextKey(series.canonical_name).length < 5;
    const discoveryAuthor = isAmbiguousShortSeries ? primaryAuthors[0] : undefined;
    const missingIsbnCount = graphWorks.filter((w) => w.isbn13s.length === 0).length;
    const shouldDiscoverMoreEnsembles =
      queriedEnsembles.size < MAX_BNF_ENSEMBLES &&
      (graphWorks.length < 2 || queriedEnsembles.size < 2 || missingIsbnCount > 0);

    if (shouldDiscoverMoreEnsembles && this.connectors.bnf.searchBySeriesName) {
      try {
        let discovery = await this.connectors.bnf.searchBySeriesName(series.canonical_name, discoveryAuthor, 50);
        if ((!discovery || discovery.works.length === 0) && !discoveryAuthor && primaryAuthors[0]) {
          discovery = await this.connectors.bnf.searchBySeriesName(series.canonical_name, primaryAuthors[0], 50);
        }
        if (discovery) {
          const compatibleWorks = discovery.works.filter(isCompatibleMediaWork);
          // Classer les dossiers découverts par richesse décroissante (les dossiers maîtres d'abord)
          const ensCounts = new Map<string, number>();
          for (const w of compatibleWorks) {
            if (w.bnfEnsembleId) {
              ensCounts.set(w.bnfEnsembleId, (ensCounts.get(w.bnfEnsembleId) ?? 0) + 1);
            }
          }
          if (ensCounts.size === 0 && compatibleWorks.length === discovery.works.length) {
            for (const ensId of discovery.discoveredEnsembleIds) {
              ensCounts.set(ensId, 1);
            }
          }
          const rankedEnsembleIds = Array.from(ensCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => id);

          if (compatibleWorks.length > 0) {
            if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
            this.mergeGraphWorks(graphWorks, compatibleWorks, series.canonical_name, hasCanonicalWikidataGraph);
          }
          for (const ensId of rankedEnsembleIds) {
            if (queriedEnsembles.size >= MAX_BNF_ENSEMBLES) break;
            bnfEnsembleIds.add(ensId);
            this.catalogRepo.mergeSeriesMetadataAutomatic(series.id, { bnfEnsembleId: ensId, now });
            await queryAndMergeEnsemble(ensId);
          }
        }
      } catch {
        // continue
      }
    }

    // Vérification ciblée SUDOC pour les rares notices BnF dont 460$v est corrompu/année (ex. Animal Jack T.8 catalogué "2023" & "7" à la BnF)
    if (this.connectors.sudoc) {
      const suspectBnfWorks = graphWorks
        .filter(
          (w) =>
            w.source === 'bnf' &&
            w.hasStructuredEnsembleVolume === false &&
            !w.isIntegral &&
            !w.isHorsSerie &&
            w.isbn13s.length > 0
        )
        .slice(0, 5);

      for (const work of suspectBnfWorks) {
        try {
          const sudocRec = await this.connectors.sudoc.lookupByIsbn(work.isbn13s[0]);
          if (
            sudocRec &&
            sudocRec.hasStructuredEnsembleVolume === true &&
            sudocRec.volumeNumber &&
            (!sudocRec.seriesName || isCompatibleSeriesName(sudocRec.seriesName, series.canonical_name))
          ) {
            const normSudocVol = normalizeSeriesNumber(sudocRec.volumeNumber);
            const parsedSudocVol = /^\d+$/.test(normSudocVol) ? parseInt(normSudocVol, 10) : null;
            if (parsedSudocVol && parsedSudocVol > 0) {
              work.volumeNumber = parsedSudocVol;
              work.volumeLabel = normSudocVol;
              work.sortOrder = parsedSudocVol;
              work.hasStructuredEnsembleVolume = true;
              if (sudocRec.title && tokenOverlapRatio(work.title, sudocRec.title) >= 0.65) {
                work.title = cleanTitle(sudocRec.title);
              }
              if (!sourcesUsed.includes('sudoc')) sourcesUsed.push('sudoc');
            }
          }
        } catch {
          // SUDOC optionnel
        }
      }
    }

    // Règle explicite "Zéro trou silencieux" : détecter les numéros manquants dans [1..maxVol] + sonder la suite (maxVol+1, +2)
    if (this.connectors.bnf.searchSeriesVolume) {
      const getPresentStandardVolumes = (): Set<number> => {
        const set = new Set<number>();
        for (const w of graphWorks) {
          if (!w.isHorsSerie && !w.isIntegral && typeof w.volumeNumber === 'number' && w.volumeNumber > 0) {
            set.add(w.volumeNumber);
          }
        }
        return set;
      };

      const initialVols = getPresentStandardVolumes();
      if (initialVols.size > 0) {
        const maxInitialVol = Math.max(...initialVols);
        let probesUsed = 0;

        // 1. Bouchage des trous internes 1..maxInitialVol (borné à MAX_HOLE_PROBES)
        for (let vol = 1; vol <= maxInitialVol && probesUsed < MAX_HOLE_PROBES; vol++) {
          if (getPresentStandardVolumes().has(vol)) continue;
          probesUsed++;
          try {
            const found = (
              await this.connectors.bnf.searchSeriesVolume(series.canonical_name, vol, discoveryAuthor)
            ).filter(isCompatibleMediaWork);
            if (found.length > 0) {
              if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
              this.mergeGraphWorks(graphWorks, found, series.canonical_name, hasCanonicalWikidataGraph);
              for (const w of found) {
                if (w.bnfEnsembleId && !queriedEnsembles.has(w.bnfEnsembleId) && queriedEnsembles.size < MAX_BNF_ENSEMBLES) {
                  bnfEnsembleIds.add(w.bnfEnsembleId);
                  this.catalogRepo.mergeSeriesMetadataAutomatic(series.id, { bnfEnsembleId: w.bnfEnsembleId, now });
                  await queryAndMergeEnsemble(w.bnfEnsembleId);
                }
              }
            }
          } catch {
            // continue
          }
        }

        // 2. Sondage de la suite immédiate (maxVol + 1, +2, +3 max) pour capter les tomes récents absents de Wikidata (ex. Spirou 56, 57)
        const currentMaxVol = Math.max(...getPresentStandardVolumes());
        for (let nextVol = currentMaxVol + 1; nextVol <= currentMaxVol + 3 && probesUsed < MAX_HOLE_PROBES + 3; nextVol++) {
          probesUsed++;
          try {
            const found = (
              await this.connectors.bnf.searchSeriesVolume(series.canonical_name, nextVol, discoveryAuthor)
            ).filter(isCompatibleMediaWork);
            if (found.length === 0) break;
            if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
            this.mergeGraphWorks(graphWorks, found, series.canonical_name, hasCanonicalWikidataGraph);
          } catch {
            break;
          }
        }
      }
    }

    // 4. Option A validée : Découverte automatique des Intégrales officielles de la série (isolées des tomes unitaires)
    if (this.connectors.bnf.searchSeriesIntegrals) {
      try {
        const integrals = (await this.connectors.bnf.searchSeriesIntegrals(series.canonical_name, 20)).filter(
          isCompatibleMediaWork
        );
        if (integrals.length > 0) {
          if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
          // Les intégrales sont marquées `isIntegral: true` -> zéro collision avec les tomes unitaires
          this.mergeGraphWorks(graphWorks, integrals, series.canonical_name, false);
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
      const isGenericT = isGenericVolumeTitle(cleanT, series.canonical_name);

      const hasConflictingVolume = (candidate: BookRow | null): boolean => {
        if (!candidate) return false;
        if (Boolean(candidate.is_integral) !== Boolean(work.isIntegral)) return true;
        if (
          candidate.volume_number !== null &&
          work.volumeNumber !== null &&
          work.volumeNumber !== undefined &&
          candidate.volume_number !== work.volumeNumber
        ) {
          return true;
        }
        return false;
      };

      // Recherche d'un tome déjà existant dans ce découpage :
      // Invariant universel : deux tomes de numéros connus et différents ne fusionnent JAMAIS,
      // et un titre générique (ex. "Bug", "Tome 1") ne matche JAMAIS uniquement sur son titre.
      let existingBook: BookRow | null =
        (work.wikidataQid ? this.catalogRepo.findBookByWikidataQid(work.wikidataQid) : null) ??
        work.isbn13s
          .map((isbn) => this.catalogRepo.findBookByIsbn13(isbn))
          .find(
            (b): b is BookRow =>
              Boolean(b) &&
              !hasConflictingVolume(b) &&
              !(b!.wikidata_qid && work.wikidataQid && b!.wikidata_qid !== work.wikidataQid)
          ) ??
        null;

      if (!existingBook && !isGenericT) {
        const byTitle = this.catalogRepo.findBookInSeriesByNormalizedTitle(series.id, normT);
        if (byTitle && !hasConflictingVolume(byTitle)) {
          existingBook = byTitle;
        }
      }

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
          const candidateHasVerifiedIsbn = this.catalogRepo.listEditionsByBookId(volCandidate.id).length > 0;
          if (cmp.sameContent && cmp.reason === 'same_edition_probable_retranslation' && candidateHasVerifiedIsbn) {
            // Un livre déjà en base avec ISBN vérifié et titre distinctif (ex. "Inventions maléfiques" T.6)
            // ne doit JAMAIS être écrasé par un tome du graphe au même numéro mais de titre totalement incompatible !
            if (work.source !== 'wikidata') {
              continue;
            }
          } else if (cmp.sameContent) {
            existingBook = volCandidate;
          } else {
            // Ce tome BnF appartient à un autre découpage éditorial -> ne pas polluer ce découpage
            continue;
          }
        }
      }

      // Garde-fou anti-écrasement d'une œuvre canonique Wikidata par une édition club BnF à titre divergent (ex. France Loisirs)
      if (
        existingBook?.wikidata_qid &&
        work.source === 'bnf' &&
        !work.wikidataQid &&
        !isGenericT &&
        !isGenericVolumeTitle(existingBook.title, series.canonical_name) &&
        Math.max(tokenOverlapRatio(cleanT, existingBook.title), tokenOverlapRatio(existingBook.title, cleanT)) < 0.45
      ) {
        continue;
      }

      // Ne jamais écraser un titre distinctif existant par un titre générique ("Bug") ou par un titre incompatible sans ISBN
      const existingHasDistinctiveTitle = Boolean(
        existingBook && !isGenericVolumeTitle(existingBook.title, series.canonical_name)
      );
      const existingHasIsbn = existingBook ? this.catalogRepo.listEditionsByBookId(existingBook.id).length > 0 : false;
      const incomingTitleDiverges =
        existingBook &&
        !isGenericT &&
        Math.max(tokenOverlapRatio(cleanT, existingBook.title), tokenOverlapRatio(existingBook.title, cleanT)) < 0.45;
      const preserveExistingTitle =
        existingHasDistinctiveTitle &&
        (isGenericT || (existingHasIsbn && work.isbn13s.length === 0 && Boolean(incomingTitleDiverges)));

      const effectiveTitle = preserveExistingTitle && existingBook ? existingBook.title : cleanT;
      const effectiveNormTitle = normalizeTextKey(effectiveTitle);

      // Téléchargement optionnel de couverture WebP via cascade rapide (URL directe + jusqu'à 2 ISBNs) si pas encore de couverture
      let coverKey: string | null = existingBook?.cover_key ?? null;
      if (!coverKey && this.coverService && (work.coverUrl || work.isbn13s.length > 0)) {
        const candidateUrls = work.coverUrl && !/\.svg(?:[?#]|$)/i.test(work.coverUrl) ? [work.coverUrl] : [];
        const isbnAttempts = work.isbn13s.length > 0 ? work.isbn13s.slice(0, 2) : [null];
        for (let idx = 0; idx < isbnAttempts.length && !coverKey; idx++) {
          const stored = await this.coverService.resolveBestCoverFromCascade({
            isbn13: isbnAttempts[idx],
            candidateUrls: idx === 0 ? candidateUrls : [],
            skipTitleFallback: true
          });
          if (stored) coverKey = stored.coverKey;
        }
      }

      const workCanonicalId =
        existingBook?.work_canonical_id ??
        (work.wikidataQid
          ? `wd:${work.wikidataQid}`
          : work.inventaireUri
            ? `inv:${work.inventaireUri}`
            : `ser:${series.id}:${work.isIntegral ? 'int' : 'vol'}:${work.volumeNumber ?? 'x'}:${effectiveNormTitle.slice(0, 40)}`);

      const classification = classifyBookMetadata({
        title: effectiveTitle,
        series: series.canonical_name,
        publisher: work.publisher ?? undefined,
        collection: work.collectionName ?? undefined,
        contentKind: work.contentKind
      });

      const saved = this.catalogRepo.upsertBookAutomatic({
        id: existingBook?.id ?? generateId('bk'),
        workCanonicalId,
        seriesId: series.id,
        title: effectiveTitle,
        normalizedTitle: effectiveNormTitle,
        volumeNumber: work.volumeNumber ?? null,
        volumeLabel: work.volumeLabel ?? (work.volumeNumber ? String(work.volumeNumber) : null),
        sortOrder: work.sortOrder ?? work.volumeNumber ?? null,
        isHorsSerie: Boolean(work.isHorsSerie),
        isIntegral: Boolean(work.isIntegral),
        includedVolumes: work.includedVolumes ?? [],
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

    const allSeriesBooks = this.catalogRepo.listBooksBySeriesId(series.id);
    const incompleteVolumeCount = allSeriesBooks.filter((b) => {
      const hasEditions = this.catalogRepo.listEditionsByBookId(b.id).length > 0;
      return !hasEditions || !b.cover_key;
    }).length;

    return {
      seriesId: series.id,
      addedCount,
      updatedCount,
      totalVolumes,
      sourcesUsed,
      incompleteVolumeCount
    };
  }

  private mergeGraphWorks(
    target: GraphSeriesWork[],
    incoming: GraphSeriesWork[],
    seriesName: string,
    restrictNewAdditionsToFrNumbered = false
  ): void {
    for (const item of incoming) {
      const normTitle = normalizeTextKey(item.title);
      const itemIsGeneric = isGenericVolumeTitle(item.title, seriesName);

      // Invariant anti-doublon ISBN : un ISBN déjà présent sur un tome consolidé (ex. corrigé T.7->T.8 via SUDOC)
      // ne doit jamais être ré-ajouté sur un autre tome lors du bouchage de trous BnF !
      const existingByIsbn =
        item.isbn13s.length > 0
          ? target.find((e) => e.isbn13s.some((isbn) => item.isbn13s.includes(isbn)))
          : undefined;
      if (existingByIsbn) {
        continue;
      }

      const match = target.find((existing) => {
        // 1. Même Q-ID Wikidata -> même œuvre garantie
        if (item.wikidataQid && existing.wikidataQid === item.wikidataQid) return true;

        // 2. Invariants universels de non-collision :
        //    - Une intégrale ne fusionne jamais avec un tome unitaire
        //    - Deux tomes portant des numéros connus et différents ne fusionnent JAMAIS
        if (Boolean(item.isIntegral) !== Boolean(existing.isIntegral)) return false;
        const hasDistinctVolumes =
          item.volumeNumber !== null &&
          item.volumeNumber !== undefined &&
          existing.volumeNumber !== null &&
          existing.volumeNumber !== undefined &&
          existing.volumeNumber !== item.volumeNumber;
        if (hasDistinctVolumes) return false;

        // 3. Correspondance par titre exact normalisé :
        //    Un titre générique (ex. "Bug", "Tome 1") ne matche sur le titre que si les numéros de tome sont identiques
        //    (évite toute collision entre un tome numéroté et une édition non numérotée du même titre générique).
        if (normTitle && normalizeTextKey(existing.title) === normTitle) {
          if (!itemIsGeneric || (item.volumeNumber ?? null) === (existing.volumeNumber ?? null)) {
            return true;
          }
        }

        // 4. Même numéro de tome (hors intégrales et hors-séries) :
        if (
          item.volumeNumber !== null &&
          item.volumeNumber !== undefined &&
          existing.volumeNumber === item.volumeNumber &&
          !item.isHorsSerie &&
          !item.isIntegral &&
          !existing.isHorsSerie &&
          !existing.isIntegral
        ) {
          if (tokenOverlapRatio(item.title, existing.title) >= 0.45) return true;
          if (
            existing.source === 'wikidata' &&
            item.source === 'bnf' &&
            existing.isbn13s.length === 0 &&
            (itemIsGeneric || isGenericVolumeTitle(existing.title, seriesName))
          ) {
            return true;
          }
        }
        return false;
      });

      if (!match) {
        // Quand un graphe canonique Wikidata (P179) est déjà présent, les notices BnF qui ne matchent
        // aucun tome existant ne sont ajoutées que si elles sont numérotées et en français (évite traductions régionales/imagiers).
        if (restrictNewAdditionsToFrNumbered) {
          const lang = (item.language ?? '').toLowerCase();
          const isForeignLang = Boolean(lang && lang !== 'fr' && lang !== 'fre');
          const hasNumber = item.volumeNumber !== null && item.volumeNumber !== undefined;
          if (isForeignLang || !hasNumber) {
            continue;
          }
        }
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
        // Complétion non destructive des champs manquants (ex. Wikidata sans P1545 complété par BnF 460$v)
        if ((match.volumeNumber === null || match.volumeNumber === undefined) && item.volumeNumber !== null && item.volumeNumber !== undefined) {
          match.volumeNumber = item.volumeNumber;
        }
        if (!match.volumeLabel && item.volumeLabel) {
          match.volumeLabel = item.volumeLabel;
        }
        if ((match.sortOrder === null || match.sortOrder === undefined) && item.sortOrder !== null && item.sortOrder !== undefined) {
          match.sortOrder = item.sortOrder;
        }
        // Invariant titre : remplacer uniquement un titre générique par un titre distinctif (jamais l'inverse)
        if (item.title && isGenericVolumeTitle(match.title, seriesName) && !itemIsGeneric) {
          match.title = item.title;
        }
        // Préférer une vraie couverture non-SVG BnF / Inventaire sur une image Wikimedia Commons générique
        const itemHasValidCover = Boolean(item.coverUrl && !/\.svg(?:[?#]|$)/i.test(item.coverUrl));
        const matchIsWikidataCover = Boolean(match.coverUrl && /wikimedia\.org/i.test(match.coverUrl));
        if (itemHasValidCover && (!match.coverUrl || (matchIsWikidataCover && item.source !== 'wikidata'))) {
          match.coverUrl = item.coverUrl;
        }
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
