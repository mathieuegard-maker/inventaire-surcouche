// src/server/services/acquisition/comparison-table.service.ts
// Étage 2 : Collecte parallèle multi-sources -> Tableau Comparatif normalisé -> Arbitre déterministe champ par champ.

import { classifyBookMetadata } from '../../../shared/bibliographic/category-classifier';
import { parseIncludedVolumeNumbers } from '../../../shared/bibliographic/integral.util';
import {
  cleanSeriesName,
  cleanTitle,
  isCompatibleSeriesName,
  isGenericVolumeTitle,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../../shared/bibliographic/text-normalize.util';
import type { BookMainCategory } from '../../../shared/types/domain.types';
import type { BibliographicConnectors, SeriesLinkKind, SourceCandidateRecord, SourceName } from '../../connectors/types';
import { CollectionGuardService, type SeriesGuardVerdict } from './collection-guard.service';

export interface ConsolidatedBookDraft {
  isbn13: string;
  title: string;
  normalizedTitle: string;
  seriesName: string | null;
  seriesLinkKind: SeriesLinkKind | null;
  bnfEnsembleId: string | null;
  wikidataSeriesQid: string | null;
  inventaireSeriesUri: string | null;
  volumeNumber: number | null;
  volumeLabel: string | null;
  sortOrder: number | null;
  isHorsSerie: boolean;
  isIntegral: boolean;
  includedVolumes: string[];
  authors: string[];
  scriptwriters: string[];
  illustrators: string[];
  publisher: string | null;
  collectionName: string | null;
  publishYear: string | null;
  pageCount: number | null;
  description: string | null;
  language: string;
  mainCategory: BookMainCategory;
  categoryConfidence?: 'explicit' | 'fallback';
  subgenres: string[];
  wikidataWorkQid: string | null;
  inventaireWorkUri: string | null;
  coverCandidates: string[];
  contributingSources: SourceName[];
  seriesGuardVerdict?: SeriesGuardVerdict;
}

const SOURCE_PRIORITY_TEXT: Record<SourceName, number> = {
  bnf: 6,
  sudoc: 5,
  inventaire: 4,
  wikidata: 3,
  google_books: 2,
  openlibrary: 1
};

const LINK_KIND_PRIORITY: Record<SeriesLinkKind, number> = {
  graph_p179: 4,
  marc_ensemble_460: 3,
  marc_collection_225: 2,
  heuristic_text: 1
};

const HORS_SERIE_RE = /\b(hors[- ]s[ée]rie|h\.?\s*s\.?|sp[ée]cial|spin[- ]off)\b/i;

function pickBestString(
  columns: SourceCandidateRecord[],
  extractor: (c: SourceCandidateRecord) => string | undefined,
  priorityMap = SOURCE_PRIORITY_TEXT
): string | null {
  const candidates = columns
    .map((c) => ({ val: extractor(c)?.trim() || '', weight: priorityMap[c.source] ?? 0 }))
    .filter((item) => item.val.length > 0)
    .sort((a, b) => b.weight - a.weight);
  return candidates[0]?.val ?? null;
}

function mergeUniqueStrings(arrays: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arr of arrays) {
    for (const raw of arr) {
      const clean = raw.trim();
      if (!clean) continue;
      const key = normalizeTextKey(clean);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

function stripRedundantSeriesPrefix(title: string, seriesName: string | null): string {
  if (!seriesName) return title;
  const normSeries = normalizeTextKey(seriesName);
  const normTitle = normalizeTextKey(title);
  if (!normSeries || normTitle === normSeries) return title;

  // Ex: "Astérix : Le Cadeau de César" -> "Le Cadeau de César"
  const escaped = seriesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixRe = new RegExp(`^${escaped}\\s*(?:[-–—:,./]|tome\\s*\\d+|t\\.?\\s*\\d+)\\s*`, 'i');
  const stripped = title.replace(prefixRe, '').trim();
  return stripped.length >= 2 ? stripped : title;
}

export class ComparisonTableService {
  private readonly connectors: BibliographicConnectors;
  private readonly collectionGuard: CollectionGuardService;

  constructor(deps: { connectors: BibliographicConnectors; collectionGuard?: CollectionGuardService }) {
    this.connectors = deps.connectors;
    this.collectionGuard = deps.collectionGuard ?? new CollectionGuardService({ bnf: deps.connectors.bnf });
  }

  /**
   * Interroge les sources en parallèle pour construire le Tableau Comparatif, puis arbitre la fiche consolidée.
   */
  async collectAndArbitrate(isbn13: string): Promise<ConsolidatedBookDraft | null> {
    const [bnfRes, sudocRes, invRes, gbRes, olRes] = await Promise.allSettled([
      this.connectors.bnf.lookupByIsbn(isbn13),
      this.connectors.sudoc.lookupByIsbn(isbn13),
      this.connectors.inventaire.lookupByIsbn(isbn13),
      this.connectors.googleBooks.lookupByIsbn(isbn13),
      this.connectors.openLibrary.lookupByIsbn(isbn13)
    ]);

    const columns: SourceCandidateRecord[] = [];
    for (const settled of [bnfRes, sudocRes, invRes, gbRes, olRes]) {
      if (settled.status === 'fulfilled' && settled.value && !settled.value.isNonBook) {
        columns.push(settled.value);
      }
    }

    // Enrichissement de la colonne Wikidata :
    // 1. Par Q-ID d'œuvre si découvert (ex. via Inventaire)
    // 2. Sinon (ex. édition collector/réédition absente d'Inventaire), par (Titre distinctif + Auteur) avec triple verrou strict
    const discoveredWorkQid = columns.find((c) => c.wikidataWorkQid)?.wikidataWorkQid;
    if (discoveredWorkQid) {
      try {
        const wdRecord = await this.connectors.wikidata.lookupWorkByQid(discoveredWorkQid, isbn13);
        if (wdRecord) columns.push(wdRecord);
      } catch {
        // Wikidata optionnel
      }
    } else if (columns.length > 0 && this.connectors.wikidata.lookupWorkByTitleAndAuthor) {
      const bestTitle = pickBestString(columns, (c) => c.title);
      const bestSeries = pickBestString(columns, (c) => c.seriesName);
      const bestAuthor = columns.flatMap((c) => c.authors).find((a) => a.trim().length >= 2);
      const cleanedTitle = bestTitle ? cleanTitle(bestTitle) : '';
      if (
        cleanedTitle &&
        bestAuthor &&
        normalizeTextKey(cleanedTitle).length >= 4 &&
        !isGenericVolumeTitle(cleanedTitle, bestSeries ?? '')
      ) {
        try {
          const wdRecord = await this.connectors.wikidata.lookupWorkByTitleAndAuthor(cleanedTitle, bestAuthor, isbn13);
          if (wdRecord) columns.push(wdRecord);
        } catch {
          // Wikidata optionnel
        }
      }
    }

    if (columns.length === 0) return null;

    return this.arbitrateColumns(isbn13, columns);
  }

  /**
   * Arbitre déterministement un Tableau Comparatif déjà collecté (100 % testable unitairement).
   */
  async arbitrateColumns(isbn13: string, columns: SourceCandidateRecord[]): Promise<ConsolidatedBookDraft | null> {
    if (columns.length === 0) return null;

    // 1. Sélection et validation algorithmique du candidat Série vs Collection éditoriale
    const seriesCandidates = columns
      .filter((c) => Boolean(c.seriesName?.trim()))
      .map((c) => ({
        name: cleanSeriesName(c.seriesName!),
        kind: c.seriesLinkKind ?? ('heuristic_text' as SeriesLinkKind),
        volumeNumber: c.volumeNumber,
        bnfEnsembleId: c.bnfEnsembleId,
        source: c.source
      }))
      .filter((c) => c.name.length > 0)
      .sort((a, b) => {
        const kindDiff = LINK_KIND_PRIORITY[b.kind] - LINK_KIND_PRIORITY[a.kind];
        if (kindDiff !== 0) return kindDiff;
        return (SOURCE_PRIORITY_TEXT[b.source] ?? 0) - (SOURCE_PRIORITY_TEXT[a.source] ?? 0);
      });

    let seriesName: string | null = null;
    let seriesLinkKind: SeriesLinkKind | null = null;
    let seriesGuardVerdict: SeriesGuardVerdict | undefined;
    let rejectedCollectionName: string | null = null;

    for (const candidate of seriesCandidates) {
      const verdict = await this.collectionGuard.evaluateCandidate({
        candidateName: candidate.name,
        linkKind: candidate.kind,
        volumeNumber: candidate.volumeNumber,
        bnfEnsembleId: candidate.bnfEnsembleId,
        allColumns: columns
      });
      seriesGuardVerdict = verdict;
      if (verdict.verdict === 'series') {
        seriesName = candidate.name;
        seriesLinkKind = candidate.kind;
        break;
      } else if (!rejectedCollectionName) {
        rejectedCollectionName = candidate.name;
      }
    }

    const compatibleSeriesCols = seriesName
      ? columns.filter((c) => !c.seriesName || isCompatibleSeriesName(c.seriesName, seriesName))
      : [];
    const incompatibleEditorialSeries = seriesName
      ? columns.find((c) => c.seriesName && !isCompatibleSeriesName(c.seriesName, seriesName))?.seriesName
      : undefined;

    const explicitCollectionName = pickBestString(columns, (c) => c.collectionName);
    const collectionName =
      explicitCollectionName ??
      (seriesName
        ? (incompatibleEditorialSeries ? cleanSeriesName(incompatibleEditorialSeries) : null)
        : rejectedCollectionName);

    // 2. Titre principal (nettoyé du préfixe série redondant si pertinent)
    // Si la BnF avait un 460$v corrompu/année (`hasStructuredEnsembleVolume === false`) alors que le SUDOC porte un
    // ensemble structuré propre (`hasStructuredEnsembleVolume === true`) avec un titre proche (ex. faute de frappe BnF),
    // préférer le titre propre du SUDOC.
    const bnfCol = columns.find((c) => c.source === 'bnf');
    const sudocCol = columns.find((c) => c.source === 'sudoc');
    const preferSudocCleanTitle = Boolean(
      bnfCol &&
        bnfCol.hasStructuredEnsembleVolume === false &&
        sudocCol?.hasStructuredEnsembleVolume === true &&
        sudocCol.title &&
        bnfCol.title &&
        tokenOverlapRatio(bnfCol.title, sudocCol.title) >= 0.65
    );
    const rawTitle = (preferSudocCleanTitle ? sudocCol!.title : pickBestString(columns, (c) => c.title)) ?? '';
    if (!rawTitle) return null;
    const title = cleanTitle(stripRedundantSeriesPrefix(rawTitle, seriesName));
    const normalizedTitle = normalizeTextKey(title);

    // 3. Numéro de tome (uniquement depuis des colonnes compatibles avec la série retenue)
    let volumeLabel: string | null = null;
    let volumeNumber: number | null = null;
    let sortOrder: number | null = null;

    if (seriesName) {
      const volumeReliabilityScore = (c: SourceCandidateRecord): number => {
        if (c.seriesLinkKind === 'graph_p179') return 3;
        if (c.hasStructuredEnsembleVolume === true) return 2;
        if (c.hasStructuredEnsembleVolume === false) return 0;
        return 1;
      };
      const matchingSeriesCols = compatibleSeriesCols
        .filter((c) => c.seriesLinkKind === 'graph_p179' || c.seriesLinkKind === 'marc_ensemble_460' || c.volumeNumber)
        .sort((a, b) => {
          const ka = a.seriesLinkKind ? LINK_KIND_PRIORITY[a.seriesLinkKind] : 0;
          const kb = b.seriesLinkKind ? LINK_KIND_PRIORITY[b.seriesLinkKind] : 0;
          if (kb !== ka) return kb - ka;
          const relDiff = volumeReliabilityScore(b) - volumeReliabilityScore(a);
          if (relDiff !== 0) return relDiff;
          return (SOURCE_PRIORITY_TEXT[b.source] ?? 0) - (SOURCE_PRIORITY_TEXT[a.source] ?? 0);
        });

      const rawVol = matchingSeriesCols.find((c) => c.volumeNumber)?.volumeNumber;
      const normVol = normalizeSeriesNumber(rawVol);
      if (normVol) {
        volumeLabel = normVol;
        if (/^\d+$/.test(normVol)) {
          volumeNumber = parseInt(normVol, 10);
          sortOrder = volumeNumber;
        }
      }
    }

    // 4. Intégrale (JAMAIS déduite du seul nombre de pages) & Hors-série (évalué APRÈS agrégation)
    const fullTextForFlags = [
      rawTitle,
      ...columns.map((c) => c.subtitle ?? ''),
      volumeLabel ?? ''
    ].join(' ');

    const parsedIntegralRange = parseIncludedVolumeNumbers(fullTextForFlags);
    const hasIntegralSignal =
      columns.some((c) => c.isIntegralHint) ||
      (parsedIntegralRange.length >= 2 && /\b(int[ée]grale|coffret|omnibus|compendium|tomes?)\b/i.test(fullTextForFlags));

    const isIntegral = Boolean(hasIntegralSignal);
    const includedVolumes = isIntegral ? parsedIntegralRange : [];

    // Hors-série évalué après agrégation (un tome numéroté entier standard n'est pas HS sauf mention explicite HS)
    const isHorsSerie =
      !isIntegral &&
      (Boolean(volumeLabel && HORS_SERIE_RE.test(volumeLabel)) ||
        (volumeNumber === null && HORS_SERIE_RE.test(fullTextForFlags)));

    // 5. Auteurs, Scénaristes, Dessinateurs (triés par priorité de source)
    const orderedCols = [...columns].sort(
      (a, b) => (SOURCE_PRIORITY_TEXT[b.source] ?? 0) - (SOURCE_PRIORITY_TEXT[a.source] ?? 0)
    );
    const authors = mergeUniqueStrings(orderedCols.map((c) => c.authors));
    const scriptwriters = mergeUniqueStrings(orderedCols.map((c) => c.scriptwriters));
    const illustrators = mergeUniqueStrings(orderedCols.map((c) => c.illustrators));

    // 6. Métadonnées éditoriales & graphe
    const publisher = pickBestString(columns, (c) => c.publisher);
    const publishYear = pickBestString(columns, (c) => c.publishYear);
    const pageCount = orderedCols.find((c) => typeof c.pageCount === 'number' && c.pageCount > 0)?.pageCount ?? null;
    const description =
      orderedCols
        .map((c) => c.description?.trim() || '')
        .filter((d) => d.length >= 20)
        .sort((a, b) => b.length - a.length)[0] ?? null;
    const language = pickBestString(columns, (c) => c.language) ?? 'fr';

    const bnfEnsembleId = seriesName ? pickBestString(compatibleSeriesCols, (c) => c.bnfEnsembleId) : null;
    const wikidataSeriesQid = seriesName ? pickBestString(compatibleSeriesCols, (c) => c.wikidataSeriesQid) : null;
    const inventaireSeriesUri = seriesName ? pickBestString(compatibleSeriesCols, (c) => c.inventaireSeriesUri) : null;
    const wikidataWorkQid = pickBestString(columns, (c) => c.wikidataWorkQid);
    const inventaireWorkUri = pickBestString(columns, (c) => c.inventaireWorkUri);

    // 7. Classification Dewey / RAMEAU / Sujets + signal ISO/RDA 051 (`contentKind`)
    // Concatène les collections de toutes les colonnes (ex. BnF 410$t "Shonen manga" / "Collection Manga")
    // pour ne jamais perdre le signal Manga/Comics si une autre source propose un nom de collection générique.
    const deweyCode = pickBestString(columns, (c) => c.deweyCode) ?? undefined;
    const rawSubjects = mergeUniqueStrings(orderedCols.map((c) => c.rawSubjects));
    const contentKind = orderedCols.find((c) => c.contentKind)?.contentKind;
    const originalLanguage = pickBestString(columns, (c) => c.originalLanguage) ?? undefined;
    const allCollectionSignals = Array.from(
      new Set([collectionName, ...orderedCols.map((c) => c.collectionName)].filter((x): x is string => Boolean(x?.trim())))
    ).join(' | ');
    const classification = classifyBookMetadata({
      title,
      series: seriesName ?? undefined,
      publisher: publisher ?? undefined,
      collection: allCollectionSignals || undefined,
      deweyCode,
      rawSubjects,
      description: description ?? undefined,
      contentKind,
      originalLanguage
    });

    // 8. Couvertures candidates (ordre de qualité : BnF, Inventaire, Wikidata, Google Books, Open Library)
    const coverPriority: Record<SourceName, number> = {
      bnf: 5,
      inventaire: 4,
      wikidata: 3,
      google_books: 2,
      openlibrary: 1,
      sudoc: 0
    };
    const coverCandidates = Array.from(
      new Set(
        [...columns]
          .sort((a, b) => (coverPriority[b.source] ?? 0) - (coverPriority[a.source] ?? 0))
          .map((c) => c.coverUrl?.trim() || '')
          .filter(Boolean)
      )
    );

    return {
      isbn13,
      title,
      normalizedTitle,
      seriesName,
      seriesLinkKind,
      bnfEnsembleId,
      wikidataSeriesQid,
      inventaireSeriesUri,
      volumeNumber,
      volumeLabel,
      sortOrder,
      isHorsSerie,
      isIntegral,
      includedVolumes,
      authors,
      scriptwriters,
      illustrators,
      publisher,
      collectionName,
      publishYear,
      pageCount,
      description,
      language,
      mainCategory: classification.mainCategory,
      categoryConfidence: classification.confidence,
      subgenres: classification.subgenres,
      wikidataWorkQid,
      inventaireWorkUri,
      coverCandidates,
      contributingSources: Array.from(new Set(columns.map((c) => c.source))),
      seriesGuardVerdict
    };
  }
}
