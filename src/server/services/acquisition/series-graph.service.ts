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
  const hasDistinctPublisher = Boolean(
    incoming.publisher &&
      existing.publisher &&
      normalizeTextKey(existing.publisher) !== normalizeTextKey(incoming.publisher)
  );
  // Une collection générique d'éditeur absente sur le squelette Wikidata (ex. `existingCol === ''` vs `Ki-oon seinen`)
  // sans tag explicite de redécoupage (Deluxe/Perfect/Nomad/Full Color) et à pagination compatible ne prouve PAS un découpage différent.
  const incomingHasExplicitRecutTag = Boolean(incomingCol && DISTINCT_EDITION_TAG_RE.test(incomingCol));
  const hasDistinctCollection = Boolean(
    incomingCol &&
      existingCol !== incomingCol &&
      (Boolean(existingCol) || incomingHasExplicitRecutTag || hasDistinctPublisher || pageRatio >= 1.3)
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

const FOREIGN_ENGLISH_TITLE_RE =
  /\b(?:the|and|of|with|from|into|returns?|conquers?|all-seeing|vol\.?\s*\d+|book\s+\d+|vs\.?)\b/i;
const FRENCH_TITLE_MARKER_RE =
  /[àâäéèêëîïôöùûüçœ]|\b(?:le|la|les|du|des|un|une|au|aux|et|dans|sur|pour|avec|chez|tome|l['’]|d['’])\b/i;
const DISTINCT_EDITION_TAG_RE =
  /\b(?:full\s*color|perfect(?:\s+[ée]dition)?|deluxe|kanzenban|nomad|urban\s+nomad|edition\s+double|double|prestige|collector|ultimate|absolute|compendium|bunko)\b/i;

function getCategoryMediaFamily(category?: string | null): MediaFamily {
  if (!category) return 'neutral';
  if (category === 'BD' || category === 'Manga' || category === 'Comics') return 'graphic';
  if (category === 'Roman' || category === 'Essai' || category === 'Poésie / Théâtre') return 'prose';
  return 'neutral';
}

/**
 * Médiane de pagination sur les tomes unitaires (hors intégrales et hors-séries).
 * Robuste aux 1–2 tomes finaux plus épais (ex. Dragon Ball T.41–42 à 240 p. sur 42 tomes à 184 p.)
 * et aux éditions luxe isolées (ex. Astérix 126 p.).
 */
export function computeMedianPageCount(
  items: Array<{ pageCount?: number | null; isIntegral?: boolean; isHorsSerie?: boolean }>
): number | null {
  const pages = items
    .filter((i) => !i.isIntegral && !i.isHorsSerie && typeof i.pageCount === 'number' && i.pageCount > 0)
    .map((i) => i.pageCount as number)
    .sort((a, b) => a - b);
  if (pages.length === 0) return null;
  const mid = Math.floor(pages.length / 2);
  return pages.length % 2 === 1 ? pages[mid] : (pages[mid - 1] + pages[mid]) / 2;
}

/**
 * Détecte un graphe externe majoritairement en langue étrangère/anglaise (ex. coupe US Viz Media
 * "The Red Ribbon Army", "Bulma Returns!", "Dragon Ball Z, Vol. 10") face à un dossier BnF français.
 */
export function isPredominantlyForeignGraph(
  works: Array<{ title: string; isIntegral?: boolean; isHorsSerie?: boolean }>,
  seriesName: string
): boolean {
  const nonGeneric = works
    .filter((w) => !w.isIntegral && !w.isHorsSerie)
    .map((w) => cleanTitle(w.title))
    .filter((t) => Boolean(t) && !isGenericVolumeTitle(t, seriesName));

  if (nonGeneric.length < 4) return false;
  let foreignCount = 0;
  for (const title of nonGeneric) {
    if (FOREIGN_ENGLISH_TITLE_RE.test(title) && !FRENCH_TITLE_MARKER_RE.test(title)) {
      foreignCount++;
    }
  }
  return foreignCount >= 3 && foreignCount / nonGeneric.length >= 0.4;
}

function titlesMatchForCutCheck(a: string, b: string): boolean {
  const na = normalizeTextKey(a);
  const nb = normalizeTextKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const overlap = Math.max(tokenOverlapRatio(a, b), tokenOverlapRatio(b, a));
  if (overlap >= 0.45) return true;
  return getLevenshteinDistance(na, nb) <= 2;
}

function extractDistinctEditionTags(
  works: Array<{ title?: string; collectionName?: string | null }>
): Set<string> {
  const tags = new Set<string>();
  for (const w of works) {
    const combined = `${w.title ?? ''} ${w.collectionName ?? ''}`;
    const matches = combined.match(new RegExp(DISTINCT_EDITION_TAG_RE.source, 'gi'));
    if (matches) {
      for (const m of matches) tags.add(normalizeTextKey(m));
    }
  }
  return tags;
}

function extractNormalizedPublishers(works: Array<{ publisher?: string | null }>): Set<string> {
  const pubs = new Set<string>();
  for (const w of works) {
    const p = normalizeTextKey(w.publisher ?? '');
    if (p) pubs.add(p);
  }
  return pubs;
}

export interface SeriesCutCompatibilityResult {
  compatible: boolean;
  reason: string;
}

/**
 * Arbitre algorithmiquement (zéro liste en dur) si un dossier BnF ou un graphe candidat appartient
 * au MÊME découpage éditorial que la référence de l'utilisateur :
 * - Règle 1 (Zéro régression Romans & BD franco-belges) : si >= 2 titres de tomes communs correspondent
 *   sans contradiction, fusion toujours autorisée (même si éditeur ou pagination poche varie).
 * - Règle 2 (Preuve par les titres) : contradiction de titres au même numéro N ou décalage majeur (>= 3 tomes,
 *   ex. "La menace" T.4 vs T.7, "Les androïdes" T.15 vs T.29) -> rejet du découpage étranger.
 * - Règle 3 (Langue étrangère) : graphe externe majoritairement anglais face à un dossier BnF français -> rejet.
 * - Règle 4 (Pagination médiane illustrés uniquement — jamais pour les romans !) : écart >= 60 % (Double vs simple)
 *   ou >= 28 % avec éditeur / tag d'édition distinct (Hachette 240 p. / Full Color vs Glénat 184 p.) -> rejet.
 */
export function assessSeriesCutCompatibility(
  referenceWorks: GraphSeriesWork[],
  candidateWorks: GraphSeriesWork[],
  options: {
    seriesName: string;
    mediaFamily: MediaFamily;
    seedVolumeNumbers?: Set<number>;
  }
): SeriesCutCompatibilityResult {
  const refUnitary = referenceWorks.filter(
    (w) => !w.isIntegral && !w.isHorsSerie && typeof w.volumeNumber === 'number' && w.volumeNumber > 0
  );
  const candUnitary = candidateWorks.filter(
    (w) => !w.isIntegral && !w.isHorsSerie && typeof w.volumeNumber === 'number' && w.volumeNumber > 0
  );

  // Aucune référence unitaire (ex. série amorcée uniquement par une intégrale) -> aucune restriction
  if (refUnitary.length === 0 || candUnitary.length === 0) {
    return { compatible: true, reason: 'insufficient_reference' };
  }

  const refByVol = new Map<number, GraphSeriesWork[]>();
  const refDistinctiveTitles: Array<{ vol: number; title: string; norm: string }> = [];

  for (const r of refUnitary) {
    const vol = r.volumeNumber!;
    const arr = refByVol.get(vol) ?? [];
    arr.push(r);
    refByVol.set(vol, arr);

    const ct = cleanTitle(r.title);
    if (ct && !isGenericVolumeTitle(ct, options.seriesName)) {
      refDistinctiveTitles.push({ vol, title: ct, norm: normalizeTextKey(ct) });
    }
  }

  let matchingTitles = 0;
  let conflictingTitles = 0;
  let seedVolumeConflict = false;
  let majorShiftedTitles = 0;

  for (const c of candUnitary) {
    const vol = c.volumeNumber!;
    const candTitle = cleanTitle(c.title);
    const candGeneric = !candTitle || isGenericVolumeTitle(candTitle, options.seriesName);
    if (candGeneric) continue;

    const refsAtVol = refByVol.get(vol);
    if (refsAtVol && refsAtVol.length > 0) {
      const nonGenericRefs = refsAtVol
        .map((r) => cleanTitle(r.title))
        .filter((t) => Boolean(t) && !isGenericVolumeTitle(t, options.seriesName));
      if (nonGenericRefs.length > 0) {
        if (nonGenericRefs.some((rt) => titlesMatchForCutCheck(candTitle, rt))) {
          matchingTitles++;
        } else {
          conflictingTitles++;
          if (options.seedVolumeNumbers?.has(vol)) {
            seedVolumeConflict = true;
          }
        }
      }
    }

    // Détection d'un titre identique décalé d'au moins 3 tomes (tolère ±1..2 comme Tintin Casterman/Wikidata)
    const normCand = normalizeTextKey(candTitle);
    if (normCand.length >= 4) {
      const shiftedHit = refDistinctiveTitles.find(
        (rt) =>
          Math.abs(rt.vol - vol) >= 3 &&
          (rt.norm === normCand ||
            (tokenOverlapRatio(candTitle, rt.title) >= 0.8 && tokenOverlapRatio(rt.title, candTitle) >= 0.8))
      );
      if (shiftedHit) {
        majorShiftedTitles++;
      }
    }
  }

  // Règle 1 : correspondance de titres avérée -> toujours fusionner (romans poche/broché, BD multi-éditeurs)
  if (matchingTitles >= 2 && conflictingTitles === 0 && majorShiftedTitles === 0) {
    return { compatible: true, reason: 'titles_confirmed' };
  }

  // Règle 2 : preuve positive de contradiction de titres ou de décalage majeur
  if (
    seedVolumeConflict ||
    conflictingTitles >= 2 ||
    majorShiftedTitles >= 1 ||
    (conflictingTitles >= 1 && matchingTitles === 0)
  ) {
    return { compatible: false, reason: 'conflicting_or_shifted_titles' };
  }

  // Règle 3 : graphe externe majoritairement étranger face à une référence francophone
  const candIsExternalGraph = candUnitary.some((w) => w.source !== 'bnf');
  if (
    candIsExternalGraph &&
    isPredominantlyForeignGraph(candUnitary, options.seriesName) &&
    !isPredominantlyForeignGraph(refUnitary, options.seriesName)
  ) {
    return { compatible: false, reason: 'foreign_language_graph' };
  }

  // Règle 4 : pagination médiane + éditeur/tag d'édition (STRICTEMENT réservée aux livres illustrés, JAMAIS aux romans !)
  if (options.mediaFamily === 'graphic' && matchingTitles === 0) {
    const refMedian = computeMedianPageCount(refUnitary);
    const candMedian = computeMedianPageCount(candUnitary);
    if (refMedian && candMedian) {
      const ratio = Math.max(refMedian, candMedian) / Math.min(refMedian, candMedian);
      if (ratio >= 1.6) {
        return { compatible: false, reason: 'graphic_pagination_major_recut' };
      }
      const refPubs = extractNormalizedPublishers(refUnitary);
      const candPubs = extractNormalizedPublishers(candUnitary);
      const publisherDiffers =
        refPubs.size > 0 && candPubs.size > 0 && !Array.from(candPubs).some((p) => refPubs.has(p));

      const refTags = extractDistinctEditionTags(refUnitary);
      const candTags = extractDistinctEditionTags(candUnitary);
      const editionTagDiffers =
        Array.from(candTags).some((t) => !refTags.has(t)) || Array.from(refTags).some((t) => !candTags.has(t));

      if (ratio >= 1.28 && (publisherDiffers || editionTagDiffers)) {
        return { compatible: false, reason: 'graphic_pagination_and_edition_recut' };
      }
    }
  }

  return { compatible: true, reason: 'compatible' };
}

interface EditionReferenceProfile {
  referenceWorks: GraphSeriesWork[];
  seriesName: string;
  mediaFamily: MediaFamily;
  medianPages: number | null;
  publishers: Set<string>;
  editionTags: Set<string>;
  seedVolumeNumbers: Set<number>;
}

function buildEditionReferenceProfile(
  referenceWorks: GraphSeriesWork[],
  seriesName: string,
  mediaFamily: MediaFamily,
  seedVolumeNumbers: Set<number>
): EditionReferenceProfile {
  const unitary = referenceWorks.filter((w) => !w.isIntegral && !w.isHorsSerie);
  return {
    referenceWorks: unitary,
    seriesName,
    mediaFamily,
    medianPages: computeMedianPageCount(unitary),
    publishers: extractNormalizedPublishers(unitary),
    editionTags: extractDistinctEditionTags(unitary),
    seedVolumeNumbers
  };
}

/**
 * Filtre un tome unitaire individuel (ex. issu d'un sondage de trou `searchSeriesVolume` ou d'un
 * coffret/double glissé dans le même dossier BnF) vis-à-vis du profil d'édition actif.
 */
export function isWorkCompatibleWithEditionProfile(
  work: GraphSeriesWork,
  profile: EditionReferenceProfile
): boolean {
  if (work.isIntegral) return false;
  if (profile.referenceWorks.length === 0) return true;

  // Vérifie contradiction de titre / décalage majeur
  const cutCheck = assessSeriesCutCompatibility(profile.referenceWorks, [work], {
    seriesName: profile.seriesName,
    mediaFamily: profile.mediaFamily,
    seedVolumeNumbers: profile.seedVolumeNumbers
  });
  if (!cutCheck.compatible) return false;

  if (profile.mediaFamily === 'graphic' && profile.medianPages && typeof work.pageCount === 'number' && work.pageCount > 0) {
    const ratio = Math.max(profile.medianPages, work.pageCount) / Math.min(profile.medianPages, work.pageCount);
    // Rejette un tome double (~360 p.) dans un découpage simple (~184 p.), tout en gardant les tomes finaux +30 % du même éditeur (ex. Dragon Ball T.41-42)
    if (ratio >= 1.6) return false;

    const workPub = normalizeTextKey(work.publisher ?? '');
    const publisherDiffers = Boolean(workPub && profile.publishers.size > 0 && !profile.publishers.has(workPub));
    const workTags = extractDistinctEditionTags([work]);
    const hasForeignTag = Array.from(workTags).some((t) => !profile.editionTags.has(t));

    if (ratio >= 1.28 && (publisherDiffers || hasForeignTag)) {
      return false;
    }
  }

  return true;
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
  /** Verrou anti-collision en mémoire : déduplique deux appels simultanés `expandSeriesByGraph(seriesId)`. */
  private readonly inFlightExpansions = new Map<string, Promise<SeriesExpansionReport>>();

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
      const cutMedia = this.getSeriesMediaFamily(cutBooks);

      // Séparation média structurelle (ex. Nestor Burma BD vs Nestor Burma Romans dans la même Franchise)
      if (incomingMedia !== 'neutral') {
        if (cutMedia !== 'neutral' && cutMedia !== incomingMedia) {
          continue;
        }
      }

      // Cycles littéraires en prose (ex. La Comédie humaine, Voyages extraordinaires) :
      // les éditions poche/classique (Folio, Livre de poche, GF...) ne créent JAMAIS de découpages séparés —
      // tout roman du cycle se rattache à la série canonique prose de la franchise.
      if (incomingMedia === 'prose' && cutMedia !== 'graphic' && cut.edition_signature === '') {
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
      // Ne créer un découpage séparé sur la pagination seule QUE pour un livre illustré (BD/Manga/Comics) standard numéroté
      // portant une collection éditoriale distincte (ex. Urban Nomad, Perfect Edition, Full Color),
      // JAMAIS pour un roman (grand format <-> poche), une intégrale, un hors-série ou une édition luxe sans collection distincte.
      const medianPages = computeMedianPageCount(
        cutBooks.map((b) => ({
          pageCount: b.page_count,
          isIntegral: b.is_integral === 1,
          isHorsSerie: b.is_hors_serie === 1
        }))
      );
      const isGraphicCut = incomingMedia === 'graphic' || this.getSeriesMediaFamily(cutBooks) === 'graphic';
      const needsPaginationCheck =
        isGraphicCut && Boolean(incomingSig) && input.volumeNumber !== null && !input.isHorsSerie && !input.isIntegral;
      const paginationCompatible =
        !needsPaginationCheck ||
        !medianPages ||
        !input.pageCount ||
        Math.max(medianPages, input.pageCount) / Math.min(medianPages, input.pageCount) < 1.3;

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

  private getDominantSeriesCategory(books: BookRow[]): BookMainCategory | null {
    const weights = new Map<BookMainCategory, number>();
    for (const b of books) {
      if (!b.main_category || b.main_category === 'Autre') continue;
      const hasRichSignals = Boolean(b.description?.trim()) || this.parseJsonArray(b.subgenres_json).length > 0;
      const weight = hasRichSignals ? 3 : 1;
      weights.set(b.main_category, (weights.get(b.main_category) ?? 0) + weight);
    }
    let best: BookMainCategory | null = null;
    let bestWeight = 0;
    for (const [cat, weight] of weights.entries()) {
      if (weight > bestWeight) {
        best = cat;
        bestWeight = weight;
      }
    }
    return best;
  }

  /**
   * Expansion d'une série ancrée sur l'édition graine de l'utilisateur :
   * 1. Précharge le dossier BnF d'origine de la graine unitaire (si présent) afin d'établir le profil du découpage éditorial ;
   * 2. Interroge le Graphe (Wikidata P179/P1545 + Inventaire P179/P629) et ne le fusionne que s'il est compatible avec le découpage ;
   * 3. Découvre les dossiers BnF complémentaires et teste CHAQUE dossier candidat individuellement avant fusion (anti-mélange redécoupages) ;
   * 4. Bouche les trous 1..maxVol dans le respect de l'éditeur et de la pagination du découpage actif ;
   * 5. Rattache séparément les Intégrales officielles (`isIntegral: true`).
   */
  async expandSeriesByGraph(
    seriesId: string,
    options?: { isCancelled?: () => boolean }
  ): Promise<SeriesExpansionReport> {
    const existingInFlight = this.inFlightExpansions.get(seriesId);
    if (existingInFlight) {
      return existingInFlight;
    }

    const promise = this.runExpandSeriesByGraph(seriesId, options).finally(() => {
      if (this.inFlightExpansions.get(seriesId) === promise) {
        this.inFlightExpansions.delete(seriesId);
      }
    });
    this.inFlightExpansions.set(seriesId, promise);
    return promise;
  }

  private async runExpandSeriesByGraph(
    seriesId: string,
    options?: { isCancelled?: () => boolean }
  ): Promise<SeriesExpansionReport> {
    const series = this.catalogRepo.findSeriesById(seriesId);
    if (!series) {
      return { seriesId, addedCount: 0, updatedCount: 0, totalVolumes: 0, sourcesUsed: [], incompleteVolumeCount: 0 };
    }

    const now = new Date().toISOString();
    const sourcesUsed: string[] = [];
    const graphWorks: GraphSeriesWork[] = [];
    const discoveredIntegrals: GraphSeriesWork[] = [];
    const primaryAuthors = this.parseJsonArray(series.primary_authors_json);
    const existingBooks = this.catalogRepo.listBooksBySeriesId(series.id);
    const seriesMediaFamily = this.getSeriesMediaFamily(existingBooks);
    const seedSeriesCategory = this.getDominantSeriesCategory(existingBooks);

    // Graine unitaire existante (une intégrale seule ne contraint JAMAIS l'expansion des tomes unitaires !)
    const existingUnitaryBooks = existingBooks.filter((b) => b.is_integral === 0 && b.is_hors_serie === 0);
    const seedVolumeNumbers = new Set<number>();
    const seedReferenceWorks: GraphSeriesWork[] = existingUnitaryBooks.map((b) => {
      const editions = this.catalogRepo.listEditionsByBookId(b.id);
      if (editions.length > 0 && typeof b.volume_number === 'number' && b.volume_number > 0) {
        seedVolumeNumbers.add(b.volume_number);
      }
      return {
        title: b.title,
        volumeNumber: b.volume_number,
        volumeLabel: b.volume_label,
        sortOrder: b.sort_order,
        wikidataQid: b.wikidata_qid,
        inventaireUri: b.inventaire_uri,
        authors: this.parseJsonArray(b.authors_json),
        isbn13s: editions.map((e) => e.isbn13),
        publisher: b.publisher,
        collectionName: b.collection_name,
        publishYear: b.publish_year,
        pageCount: b.page_count,
        language: b.language,
        isHorsSerie: false,
        isIntegral: false,
        source: 'bnf'
      };
    });

    const isCompatibleMediaWork = (work: GraphSeriesWork): boolean => {
      if (seriesMediaFamily === 'graphic' && work.contentKind === 'text_only') return false;
      if (seriesMediaFamily === 'prose' && work.contentKind === 'illustrated') return false;
      return true;
    };

    const MAX_BNF_ENSEMBLES = 5;
    const MAX_HOLE_PROBES = 12;
    const bnfEnsembleIds = new Set<string>(this.parseJsonArray(series.bnf_ensemble_ids_json));
    const queriedEnsembles = new Set<string>();
    const seedBnfUnitary: GraphSeriesWork[] = [];

    // 1. Préchargement du ou des dossier(s) BnF déjà portés par la graine unitaire (étalon du découpage éditorial)
    if (bnfEnsembleIds.size > 0) {
      for (const ensId of Array.from(bnfEnsembleIds)) {
        if (queriedEnsembles.has(ensId) || queriedEnsembles.size >= MAX_BNF_ENSEMBLES) continue;
        queriedEnsembles.add(ensId);
        try {
          const rawBnf = (await this.connectors.bnf.searchByEnsembleId(ensId, 80)).filter(isCompatibleMediaWork);
          if (rawBnf.length === 0) continue;
          const rawUnitary = rawBnf.filter((w) => !w.isIntegral);
          const rawIntegrals = rawBnf.filter((w) => w.isIntegral);
          discoveredIntegrals.push(...rawIntegrals);

          // Vérification de cohérence si plusieurs ensembles étaient déjà enregistrés sur la série
          const currentRef = [...seedReferenceWorks, ...seedBnfUnitary];
          if (seedBnfUnitary.length > 0) {
            const check = assessSeriesCutCompatibility(currentRef, rawUnitary, {
              seriesName: series.canonical_name,
              mediaFamily: seriesMediaFamily,
              seedVolumeNumbers
            });
            if (!check.compatible) continue;
          }

          // Filtrage des outliers de pagination glissés dans un même dossier BnF (ex. édition double 362 p. dans un dossier 184 p.)
          const profileBase = currentRef.length > 0 ? currentRef : rawUnitary;
          const seedProfile = buildEditionReferenceProfile(
            profileBase,
            series.canonical_name,
            seriesMediaFamily,
            seedVolumeNumbers
          );
          const cleanUnitary = rawUnitary.filter((w) =>
            seedReferenceWorks.length > 0 || seedBnfUnitary.length > 0
              ? isWorkCompatibleWithEditionProfile(w, seedProfile)
              : true
          );
          if (cleanUnitary.length > 0) {
            if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
            this.mergeGraphWorks(seedBnfUnitary, cleanUnitary, series.canonical_name, false);
          }
        } catch {
          // continue
        }
      }
    }

    const editorialReference: GraphSeriesWork[] = [...seedReferenceWorks, ...seedBnfUnitary];

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

    const isGraphCompatibleWithEditorialSeed = (wdWorks: GraphSeriesWork[], invWorks: GraphSeriesWork[]): boolean => {
      if (editorialReference.length === 0) return true;
      const combined: GraphSeriesWork[] = [];
      if (wdWorks.length > 0) combined.push(...wdWorks);
      if (invWorks.length > 0) this.mergeGraphWorks(combined, invWorks, series.canonical_name);
      if (combined.length === 0) return false;
      const check = assessSeriesCutCompatibility(editorialReference, combined, {
        seriesName: series.canonical_name,
        mediaFamily: seriesMediaFamily,
        seedVolumeNumbers
      });
      return check.compatible;
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

    // 2. Graphe (Wikidata P179/P1545 + Inventaire P179/P629) — accepté uniquement s'il est compatible avec le découpage éditorial actif
    const isSecondaryEditorialCut = Boolean(series.edition_signature && !series.wikidata_qid && editorialReference.length > 0);
    if (series.wikidata_qid) {
      const { wdWorks, invWorks } = await fetchGraphForCandidate(series.wikidata_qid, `wd:${series.wikidata_qid}`);
      if (isGraphCompatibleWithEditorialSeed(wdWorks, invWorks)) {
        appendGraphResults(wdWorks, invWorks);
      }
    } else if (!isSecondaryEditorialCut) {
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
        if ((wdWorks.length > 0 || invWorks.length > 0) && isGraphCompatibleWithEditorialSeed(wdWorks, invWorks)) {
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

    const hasCanonicalWikidataGraph = sourcesUsed.includes('wikidata') && graphWorks.length >= 2;

    // Intégration des tomes BnF préchargés de l'édition graine (au-dessus du graphe canonique si accepté, ou comme colonne vertébrale sinon)
    if (seedBnfUnitary.length > 0) {
      this.mergeGraphWorks(graphWorks, seedBnfUnitary, series.canonical_name, hasCanonicalWikidataGraph);
    }

    const getCurrentEditionProfile = (): EditionReferenceProfile =>
      buildEditionReferenceProfile(
        [...seedReferenceWorks, ...graphWorks],
        series.canonical_name,
        seriesMediaFamily,
        seedVolumeNumbers
      );

    // 3. Phase 3A — Découverte multi-dossiers BnF AVEC validation par dossier (zéro mélange de redécoupages)
    const evaluateAndMergeBnfEnsemble = async (ensId: string): Promise<boolean> => {
      if (queriedEnsembles.has(ensId) || queriedEnsembles.size >= MAX_BNF_ENSEMBLES) return false;
      queriedEnsembles.add(ensId);
      try {
        const rawBnf = (await this.connectors.bnf.searchByEnsembleId(ensId, 80)).filter(isCompatibleMediaWork);
        if (rawBnf.length === 0) return false;
        const ensUnitary = rawBnf.filter((w) => !w.isIntegral);
        const ensIntegrals = rawBnf.filter((w) => w.isIntegral);

        const currentRef = [...seedReferenceWorks, ...graphWorks];
        if (currentRef.length > 0 && ensUnitary.length > 0) {
          const check = assessSeriesCutCompatibility(currentRef, ensUnitary, {
            seriesName: series.canonical_name,
            mediaFamily: seriesMediaFamily,
            seedVolumeNumbers
          });
          if (!check.compatible) {
            return false;
          }
        }

        const profile = getCurrentEditionProfile();
        const filteredUnitary = ensUnitary.filter((w) => isWorkCompatibleWithEditionProfile(w, profile));
        if (filteredUnitary.length === 0 && ensIntegrals.length === 0) return false;

        bnfEnsembleIds.add(ensId);
        this.catalogRepo.mergeSeriesMetadataAutomatic(series.id, { bnfEnsembleId: ensId, now });
        if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
        if (filteredUnitary.length > 0) {
          this.mergeGraphWorks(graphWorks, filteredUnitary, series.canonical_name, hasCanonicalWikidataGraph);
        }
        if (ensIntegrals.length > 0) {
          discoveredIntegrals.push(...ensIntegrals);
        }
        return true;
      } catch {
        return false;
      }
    };

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
          // Classe les dossiers découverts par richesse décroissante et les valide UN PAR UN (ne jamais tout fusionner en bloc !)
          const ensCounts = new Map<string, number>();
          const worksByEns = new Map<string, GraphSeriesWork[]>();
          const orphanWorks: GraphSeriesWork[] = [];

          for (const w of compatibleWorks) {
            if (w.isIntegral) {
              discoveredIntegrals.push(w);
              continue;
            }
            if (w.bnfEnsembleId) {
              ensCounts.set(w.bnfEnsembleId, (ensCounts.get(w.bnfEnsembleId) ?? 0) + 1);
              const list = worksByEns.get(w.bnfEnsembleId) ?? [];
              list.push(w);
              worksByEns.set(w.bnfEnsembleId, list);
            } else {
              orphanWorks.push(w);
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

          for (const ensId of rankedEnsembleIds) {
            if (queriedEnsembles.size >= MAX_BNF_ENSEMBLES) break;
            if (queriedEnsembles.has(ensId)) continue;
            // Pré-filtre rapide sur l'échantillon déjà découvert pour éviter des appels inutiles sur un dossier manifestement incompatible
            const sampleForEns = worksByEns.get(ensId) ?? [];
            const currentRef = [...seedReferenceWorks, ...graphWorks];
            if (currentRef.length > 0 && sampleForEns.length > 0) {
              const preCheck = assessSeriesCutCompatibility(currentRef, sampleForEns, {
                seriesName: series.canonical_name,
                mediaFamily: seriesMediaFamily,
                seedVolumeNumbers
              });
              if (!preCheck.compatible) continue;
            }
            await evaluateAndMergeBnfEnsemble(ensId);
          }

          if (orphanWorks.length > 0) {
            const profile = getCurrentEditionProfile();
            const safeOrphans = orphanWorks.filter((w) => isWorkCompatibleWithEditionProfile(w, profile));
            if (safeOrphans.length > 0) {
              if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
              this.mergeGraphWorks(graphWorks, safeOrphans, series.canonical_name, hasCanonicalWikidataGraph);
            }
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

    // Règle explicite "Zéro trou silencieux" : détecter les numéros manquants dans [1..maxVol] + sonder la suite (maxVol+1..3)
    // en exigeant la fidélité au découpage éditorial actif (éditeur + pagination + titres).
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

      const filterHoleCandidates = (rawFound: GraphSeriesWork[]): GraphSeriesWork[] => {
        const profile = getCurrentEditionProfile();
        const mediaOk = rawFound.filter((w) => isCompatibleMediaWork(w) && isWorkCompatibleWithEditionProfile(w, profile));
        // Si le découpage illustré actif provient d'un éditeur homogène et qu'un candidat du même éditeur répond, le privilégier
        if (seriesMediaFamily === 'graphic' && profile.publishers.size === 1 && mediaOk.length > 1) {
          const samePub = mediaOk.filter((w) => w.publisher && profile.publishers.has(normalizeTextKey(w.publisher)));
          if (samePub.length > 0) return samePub;
        }
        return mediaOk;
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
            const rawFound = await this.connectors.bnf.searchSeriesVolume(series.canonical_name, vol, discoveryAuthor);
            const found = filterHoleCandidates(rawFound);
            if (found.length > 0) {
              if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
              this.mergeGraphWorks(graphWorks, found, series.canonical_name, hasCanonicalWikidataGraph);
              for (const w of found) {
                if (w.bnfEnsembleId && !queriedEnsembles.has(w.bnfEnsembleId) && queriedEnsembles.size < MAX_BNF_ENSEMBLES) {
                  await evaluateAndMergeBnfEnsemble(w.bnfEnsembleId);
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
            const rawFound = await this.connectors.bnf.searchSeriesVolume(series.canonical_name, nextVol, discoveryAuthor);
            const found = filterHoleCandidates(rawFound);
            if (found.length === 0) break;
            if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
            this.mergeGraphWorks(graphWorks, found, series.canonical_name, hasCanonicalWikidataGraph);
          } catch {
            break;
          }
        }
      }
    }

    // 4. Option A validée : Intégrales & coffrets officiels de la série (strictement isolés des tomes unitaires)
    if (discoveredIntegrals.length > 0) {
      if (!sourcesUsed.includes('bnf')) sourcesUsed.push('bnf');
      this.mergeGraphWorks(graphWorks, discoveredIntegrals, series.canonical_name, false);
    }
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
      if (options?.isCancelled?.() || !this.catalogRepo.findSeriesById(series.id)) {
        return { seriesId: series.id, addedCount, updatedCount, totalVolumes: 0, sourcesUsed, incompleteVolumeCount: 0 };
      }
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
      let coverSourceIsbn: string | null = null;
      if (!coverKey && this.coverService && (work.coverUrl || work.isbn13s.length > 0)) {
        const candidateUrls = work.coverUrl && !/\.svg(?:[?#]|$)/i.test(work.coverUrl) ? [work.coverUrl] : [];
        const isbnAttempts = work.isbn13s.length > 0 ? work.isbn13s.slice(0, 2) : [null];
        for (let idx = 0; idx < isbnAttempts.length && !coverKey; idx++) {
          const stored = await this.coverService.resolveBestCoverFromCascade({
            isbn13: isbnAttempts[idx],
            candidateUrls: idx === 0 ? candidateUrls : [],
            skipTitleFallback: true
          });
          if (stored) {
            coverKey = stored.coverKey;
            coverSourceIsbn = isbnAttempts[idx];
          }
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
        deweyCode: work.deweyCode ?? undefined,
        rawSubjects: work.rawSubjects,
        contentKind: work.contentKind,
        originalLanguage: work.originalLanguage ?? undefined
      });

      // Protection anti-écrasement : un tome déjà en base conserve sa catégorie qualifiée ;
      // un nouveau squelette sans signal explicite (ou une intégrale BnF 741.5 générique d'une série Manga/Comics)
      // hérite de la catégorie dominante de la série graine.
      const isGenericBdInsideMangaOrComics =
        classification.mainCategory === 'BD' &&
        (seedSeriesCategory === 'Manga' || seedSeriesCategory === 'Comics') &&
        (work.isIntegral || !work.originalLanguage);

      const effectiveMainCategory: BookMainCategory =
        existingBook && existingBook.main_category !== 'Autre'
          ? existingBook.main_category
          : isGenericBdInsideMangaOrComics && seedSeriesCategory
            ? seedSeriesCategory
            : classification.confidence === 'explicit'
              ? classification.mainCategory
              : (seedSeriesCategory ?? classification.mainCategory);

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
        colorists: work.colorists ?? [],
        publisher: work.publisher ?? null,
        collectionName: work.collectionName ?? null,
        publishYear: work.publishYear ?? null,
        pageCount: work.pageCount ?? null,
        description: null,
        language: 'fr',
        mainCategory: effectiveMainCategory,
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

      const editionMetaByIsbn = new Map(
        (work.editionRecords ?? []).map((er) => [er.isbn13, er])
      );
      for (let i = 0; i < work.isbn13s.length; i++) {
        const isbn13 = work.isbn13s[i];
        const edMeta = editionMetaByIsbn.get(isbn13);
        // N'attribuer `coverKey` qu'à l'ISBN ayant effectivement produit cette couverture (ou au seul ISBN connu)
        const edCoverKey =
          coverSourceIsbn
            ? isbn13 === coverSourceIsbn
              ? coverKey
              : null
            : work.isbn13s.length === 1
              ? coverKey
              : null;
        this.catalogRepo.upsertBookEdition({
          isbn13,
          bookId: saved.id,
          publisher: edMeta ? (edMeta.publisher ?? null) : (i === 0 ? (work.publisher ?? null) : null),
          collectionName: edMeta ? (edMeta.collectionName ?? null) : (i === 0 ? (work.collectionName ?? null) : null),
          publishYear: edMeta ? (edMeta.publishYear ?? null) : (i === 0 ? (work.publishYear ?? null) : null),
          pageCount: edMeta ? (edMeta.pageCount ?? null) : (i === 0 ? (work.pageCount ?? null) : null),
          coverKey: edCoverKey,
          source: edMeta?.source ?? work.source,
          now
        });
      }
    }

    if (options?.isCancelled?.() || !this.catalogRepo.findSeriesById(series.id)) {
      return { seriesId: series.id, addedCount, updatedCount, totalVolumes: 0, sourcesUsed, incompleteVolumeCount: 0 };
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
        target.push({
          ...item,
          isbn13s: [...item.isbn13s],
          editionRecords: item.editionRecords ? item.editionRecords.map((er) => ({ ...er })) : undefined,
          authors: [...item.authors]
        });
      } else {
        for (const isbn of item.isbn13s) {
          if (!match.isbn13s.includes(isbn)) match.isbn13s.push(isbn);
        }
        const incomingEdRecords =
          item.editionRecords && item.editionRecords.length > 0
            ? item.editionRecords
            : item.isbn13s.map((isbn13) => ({
                isbn13,
                publisher: item.publisher ?? null,
                collectionName: item.collectionName ?? null,
                publishYear: item.publishYear ?? null,
                pageCount: item.pageCount ?? null,
                coverUrl: item.coverUrl ?? null,
                source: item.source
              }));
        if (incomingEdRecords.length > 0) {
          match.editionRecords ??= match.isbn13s.map((isbn13) => ({
            isbn13,
            publisher: match.publisher ?? null,
            collectionName: match.collectionName ?? null,
            publishYear: match.publishYear ?? null,
            pageCount: match.pageCount ?? null,
            coverUrl: match.coverUrl ?? null,
            source: match.source
          }));
          for (const rec of incomingEdRecords) {
            const existingRec = match.editionRecords.find((er) => er.isbn13 === rec.isbn13);
            if (!existingRec) {
              match.editionRecords.push({ ...rec });
            } else {
              if (!existingRec.publisher && rec.publisher) existingRec.publisher = rec.publisher;
              if (!existingRec.collectionName && rec.collectionName) existingRec.collectionName = rec.collectionName;
              if (!existingRec.publishYear && rec.publishYear) existingRec.publishYear = rec.publishYear;
              if (!existingRec.pageCount && rec.pageCount) existingRec.pageCount = rec.pageCount;
              if (!existingRec.coverUrl && rec.coverUrl) existingRec.coverUrl = rec.coverUrl;
            }
          }
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
