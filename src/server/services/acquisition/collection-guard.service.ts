// src/server/services/acquisition/collection-guard.service.ts
// Défi Algorithmique n°1 : Détection 100 % algorithmique anti-fausses séries (collections poche/éditoriales) — ZÉRO liste en dur.

import { normalizeTextKey } from '../../../shared/bibliographic/text-normalize.util';
import type { BnfConnector, CollectionSampleItem, SeriesLinkKind, SourceCandidateRecord } from '../../connectors/types';

export interface SeriesGuardVerdict {
  verdict: 'series' | 'collection';
  reason: string;
  authorHeterogeneityRatio?: number;
  sampleSize?: number;
}

export interface SeriesGuardInput {
  candidateName: string;
  linkKind: SeriesLinkKind;
  volumeNumber?: string;
  bnfEnsembleId?: string;
  allColumns: SourceCandidateRecord[];
  /** Échantillon optionnel (injectable en test ; sinon interrogé via BnF si doute). */
  preloadedSample?: CollectionSampleItem[];
}

function parsePositiveInt(raw?: string): number | null {
  if (!raw) return null;
  const clean = raw.trim();
  if (!/^\d+$/.test(clean)) return null;
  return parseInt(clean, 10);
}

/**
 * Évalue mathématiquement l'hétérogénéité des auteurs sur un échantillon d'ouvrages partageant le nom candidat.
 * - Une vraie série narrative partage un noyau d'auteurs (ratio d'auteurs distincts faible / fréquence max élevée).
 * - Une collection éditoriale (ex. poche) regroupe des livres d'auteurs presque tous différents sans recouvrement.
 */
export function evaluateAuthorHeterogeneity(sample: CollectionSampleItem[]): {
  isHeterogeneousCollection: boolean;
  distinctRatio: number;
  maxAuthorShare: number;
  itemsWithAuthors: number;
} {
  const authorCounts = new Map<string, number>();
  const primaryAuthors = new Set<string>();
  let itemsWithAuthors = 0;

  for (const item of sample) {
    const cleanAuthors = item.authors.map((a) => normalizeTextKey(a)).filter(Boolean);
    if (cleanAuthors.length === 0) continue;
    itemsWithAuthors++;
    primaryAuthors.add(cleanAuthors[0]);
    const seenInItem = new Set<string>();
    for (const a of cleanAuthors) {
      if (seenInItem.has(a)) continue;
      seenInItem.add(a);
      authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1);
    }
  }

  if (itemsWithAuthors < 3) {
    return {
      isHeterogeneousCollection: false,
      distinctRatio: 0,
      maxAuthorShare: 1,
      itemsWithAuthors
    };
  }

  let maxCount = 0;
  for (const cnt of authorCounts.values()) {
    if (cnt > maxCount) maxCount = cnt;
  }

  const distinctRatio = primaryAuthors.size / itemsWithAuthors;
  const maxAuthorShare = maxCount / itemsWithAuthors;

  // Si >= 75 % des livres ont un auteur principal différent ET aucun auteur n'apparaît dans >= 35 % des tomes
  const isHeterogeneousCollection = distinctRatio >= 0.75 && maxAuthorShare < 0.35;

  return {
    isHeterogeneousCollection,
    distinctRatio,
    maxAuthorShare,
    itemsWithAuthors
  };
}

const EXPLICIT_EDITORIAL_COLLECTION_PREFIX_RE =
  /^(?:(?:la\s+)?collection\s+|(?:la\s+|petite\s+|grande\s+)?biblioth[eè]que\s+)/i;

export class CollectionGuardService {
  private readonly bnf?: BnfConnector;

  constructor(deps?: { bnf?: BnfConnector }) {
    this.bnf = deps?.bnf;
  }

  /**
   * Applique les 3 tests algorithmiques combinés (zéro mot-clé ou liste éditoriale en dur) :
   * 1. Ancrage Graphe (Wikidata/Inventaire P179) -> Série confirmée (protège Spirou, Astérix, Les Reines de sang).
   *    Exception algorithmique : si l'intitulé porte un préfixe générique de collection éditoriale
   *    ("Collection ...", "Bibliothèque ..."), il est soumis au test mathématique d'hétérogénéité des auteurs
   *    avant toute validation (bloque "Collection Blanche", "Bibliothèque Charpentier" tout en protégeant une série mono-auteur).
   * 2. Confrontation Œuvre vs Édition -> Si l'Œuvre sur le graphe n'a aucune série (ou a une autre série),
   *    un candidat issu uniquement de 225/410 est démasqué comme collection éditoriale (protège contre "Tout Simenon").
   * 3. Distinction MARC (460 ensemble vs 225/410 collection) + Test d'hétérogénéité des auteurs sur échantillon.
   */
  async evaluateCandidate(input: SeriesGuardInput): Promise<SeriesGuardVerdict> {
    const normCandidate = normalizeTextKey(input.candidateName);
    if (!normCandidate) {
      return { verdict: 'collection', reason: 'empty_candidate' };
    }

    const hasEditorialPrefix = EXPLICIT_EDITORIAL_COLLECTION_PREFIX_RE.test(input.candidateName.trim());

    // Test 1 : Ancrage Graphe (P179 Wikidata ou Inventaire) sur ce candidat -> Vraie série garantie
    // (sauf préfixe explicite "Collection ..." / "Bibliothèque ..." qui passe par le test d'hétérogénéité des auteurs)
    const graphConfirmed = input.allColumns.some(
      (col) =>
        col.seriesLinkKind === 'graph_p179' &&
        col.seriesName &&
        normalizeTextKey(col.seriesName) === normCandidate
    );
    if ((input.linkKind === 'graph_p179' || graphConfirmed) && !hasEditorialPrefix) {
      return { verdict: 'series', reason: 'confirmed_by_graph_p179' };
    }

    // Test 2 : Confrontation Œuvre vs Édition (les sources d'Œuvre Wikidata / Inventaire ont-elles une réponse ?)
    const workLevelColumns = input.allColumns.filter(
      (col) =>
        (col.source === 'wikidata' || col.source === 'inventaire') &&
        Boolean(col.wikidataWorkQid || col.inventaireWorkUri)
    );

    const isCollectionOnly = input.linkKind === 'marc_collection_225' || input.linkKind === 'heuristic_text';

    if (isCollectionOnly && workLevelColumns.length > 0) {
      const hasDifferentGraphSeries = workLevelColumns.some(
        (col) =>
          col.seriesLinkKind === 'graph_p179' &&
          col.seriesName &&
          normalizeTextKey(col.seriesName) !== normCandidate
      );
      if (hasDifferentGraphSeries) {
        return { verdict: 'collection', reason: 'work_belongs_to_different_graph_series' };
      }

      const workExplicitlyHasNoSeries = workLevelColumns.every((col) => !col.seriesName);
      if (workExplicitlyHasNoSeries) {
        return { verdict: 'collection', reason: 'work_level_has_no_series_edition_only_225' };
      }
    }

    // Test 3a : Ensemble bibliographique MARC 460/461 (protège les anthologies multi-auteurs ancrées type Les Reines de sang)
    const ensembleConfirmed =
      input.linkKind === 'marc_ensemble_460' ||
      input.allColumns.some(
        (col) =>
          col.seriesLinkKind === 'marc_ensemble_460' &&
          col.seriesName &&
          normalizeTextKey(col.seriesName) === normCandidate
      );

    if (ensembleConfirmed && !hasEditorialPrefix) {
      const vol = parsePositiveInt(input.volumeNumber);
      // Même en 460, un n° de collection manifestement > 500 sans ancrage graphe mérite vérification
      if (vol === null || vol <= 500) {
        return { verdict: 'series', reason: 'confirmed_by_marc_460_ensemble' };
      }
    }

    // Test 3b : Candidat suspect (225/410 seul, sans P179 ni 460)
    const volNum = parsePositiveInt(input.volumeNumber);
    if (volNum !== null && volNum > 100) {
      return { verdict: 'collection', reason: 'suspect_225_high_collection_number' };
    }

    // Échantillonnage mathématique d'hétérogénéité des auteurs
    const sample =
      input.preloadedSample ??
      (this.bnf ? await this.bnf.sampleByCollectionName(input.candidateName, 10) : []);

    if (sample.length >= 3) {
      const metrics = evaluateAuthorHeterogeneity(sample);
      if (metrics.isHeterogeneousCollection) {
        return {
          verdict: 'collection',
          reason: 'author_heterogeneity_editorial_collection',
          authorHeterogeneityRatio: metrics.distinctRatio,
          sampleSize: metrics.itemsWithAuthors
        };
      }

      // Vérifie aussi si les numéros échantillonnés sont très élevés (> 100)
      const highNumbers = sample
        .map((s) => parsePositiveInt(s.volumeNumber))
        .filter((n): n is number => n !== null && n > 100);
      if (highNumbers.length >= 2) {
        return {
          verdict: 'collection',
          reason: 'sample_high_collection_numbers',
          authorHeterogeneityRatio: metrics.distinctRatio,
          sampleSize: sample.length
        };
      }

      // Cohérence d'auteurs confirmée sur l'échantillon (ex. petite série BD cataloguée uniquement en 225)
      if (metrics.itemsWithAuthors >= 3 && metrics.maxAuthorShare >= 0.5) {
        return {
          verdict: 'series',
          reason: 'homogeneous_author_core_verified',
          authorHeterogeneityRatio: metrics.distinctRatio,
          sampleSize: metrics.itemsWithAuthors
        };
      }
    }

    // Repli conservateur : un champ 225/410 isolé sans 460, sans P179 et sans noyau d'auteur vérifié reste une collection éditoriale.
    return { verdict: 'collection', reason: 'uncorroborated_marc_225_collection' };
  }
}
