// src/server/services/acquisition/series-graph.service.ts
// Étage 3 : Modèle 2 étages Franchise -> Découpage Éditorial (fusion/séparation par contenu) + Expansion par le Graphe d'abord.

import crypto from 'node:crypto';
import {
  cleanTitle,
  extractFranchiseBaseName,
  getLevenshteinDistance,
  isCompatibleSeriesName,
  isGenericVolumeTitle,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../../shared/bibliographic/text-normalize.util';
import { classifyBookMetadata } from '../../../shared/bibliographic/category-classifier';
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
    const primaryAuthors = this.parseJsonArray(series.primary_authors_json);

    let effectiveWikidataQid = series.wikidata_qid;
    let effectiveInventaireSeriesUri = effectiveWikidataQid ? `wd:${effectiveWikidataQid}` : null;

    // 0. Découverte de rattrapage Graphe si la série n'a pas encore de Q-ID Wikidata / URI Inventaire
    if (!effectiveWikidataQid) {
      try {
        const invFound = await this.connectors.inventaire.searchSeriesUri?.(series.canonical_name);
        if (invFound) {
          effectiveInventaireSeriesUri = invFound.seriesUri;
          if (invFound.wikidataQid) {
            effectiveWikidataQid = invFound.wikidataQid;
          }
        }
      } catch {
        // continue
      }

      if (!effectiveWikidataQid) {
        try {
          const wdFound = await this.connectors.wikidata.searchSeriesQid?.(series.canonical_name);
          if (wdFound) {
            effectiveWikidataQid = wdFound;
            if (!effectiveInventaireSeriesUri) {
              effectiveInventaireSeriesUri = `wd:${wdFound}`;
            }
          }
        } catch {
          // continue
        }
      }

      if (effectiveWikidataQid) {
        this.catalogRepo.mergeSeriesMetadataAutomatic(series.id, {
          wikidataQid: effectiveWikidataQid,
          now
        });
      }
    }

    // 1. Graphe Wikidata P179/P1545
    if (effectiveWikidataQid) {
      try {
        const wdWorks = await this.connectors.wikidata.fetchSeriesWorksByQid(effectiveWikidataQid);
        if (wdWorks.length > 0) {
          sourcesUsed.push('wikidata');
          graphWorks.push(...wdWorks);
        }
      } catch {
        // continue
      }
    }

    // 2. Complément graphe Inventaire (ISBN FR P629 + œuvres P179, fonctionne sur wd:Q... et inv:...)
    if (effectiveInventaireSeriesUri) {
      try {
        const invWorks = await this.connectors.inventaire.fetchSeriesWorks(effectiveInventaireSeriesUri);
        if (invWorks.length > 0) {
          sourcesUsed.push('inventaire');
          this.mergeGraphWorks(graphWorks, invWorks, series.canonical_name);
        }
      } catch {
        // continue
      }
    }

    // 3. Filet de sécurité BnF 460$3 (bib.ens2bib) + découverte d'ensemble BnF par nom de série si nécessaire
    const bnfEnsembleIds = new Set<string>(this.parseJsonArray(series.bnf_ensemble_ids_json));
    const incompleteGraphCount = graphWorks.filter(
      (w) => w.volumeNumber === null || w.volumeNumber === undefined || w.isbn13s.length === 0
    ).length;
    const needsBnfDiscovery =
      graphWorks.length < 2 ||
      (bnfEnsembleIds.size === 0 && incompleteGraphCount > 0 && incompleteGraphCount * 2 >= graphWorks.length);

    const hasCanonicalWikidataGraph = sourcesUsed.includes('wikidata') && graphWorks.length >= 2;

    if (needsBnfDiscovery) {
      try {
        const discovery = await this.connectors.bnf.searchBySeriesName?.(
          series.canonical_name,
          primaryAuthors[0],
          50
        );
        if (discovery) {
          for (const ensId of discovery.discoveredEnsembleIds) {
            bnfEnsembleIds.add(ensId);
            this.catalogRepo.mergeSeriesMetadataAutomatic(series.id, { bnfEnsembleId: ensId, now });
          }
          if (discovery.works.length > 0) {
            if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
            this.mergeGraphWorks(graphWorks, discovery.works, series.canonical_name, hasCanonicalWikidataGraph);
          }
        }
      } catch {
        // continue
      }
    }

    for (const ensId of bnfEnsembleIds) {
      try {
        const bnfWorks = await this.connectors.bnf.searchByEnsembleId(ensId, 80);
        if (bnfWorks.length > 0) {
          if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
          this.mergeGraphWorks(graphWorks, bnfWorks, series.canonical_name, hasCanonicalWikidataGraph);
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
        work.isbn13s.map((isbn) => this.catalogRepo.findBookByIsbn13(isbn)).find((b): b is BookRow => Boolean(b)) ??
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
          if (cmp.sameContent) {
            existingBook = volCandidate;
          } else {
            // Ce tome BnF appartient à un autre découpage éditorial -> ne pas polluer ce découpage
            continue;
          }
        }
      }

      // Ne jamais écraser un titre distinctif existant (ex. "Bug, Livre 4") par un titre générique ("Bug")
      const effectiveTitle =
        existingBook && !isGenericVolumeTitle(existingBook.title, series.canonical_name) && isGenericT
          ? existingBook.title
          : cleanT;
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
            : `ser:${series.id}:vol:${work.volumeNumber ?? 'x'}:${effectiveNormTitle.slice(0, 40)}`);

      const classification = classifyBookMetadata({
        title: effectiveTitle,
        series: series.canonical_name,
        publisher: work.publisher ?? undefined,
        collection: work.collectionName ?? undefined
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

  private mergeGraphWorks(
    target: GraphSeriesWork[],
    incoming: GraphSeriesWork[],
    seriesName: string,
    restrictNewAdditionsToFrNumbered = false
  ): void {
    for (const item of incoming) {
      const normTitle = normalizeTextKey(item.title);
      const itemIsGeneric = isGenericVolumeTitle(item.title, seriesName);

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
          if (existing.source === 'wikidata' && item.source === 'bnf' && existing.isbn13s.length === 0) {
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
