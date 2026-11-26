// src/server/services/acquisition/book-identifier.service.ts
// Brique réutilisable Étage 1 (Phase 3B) : convertit un indice (Série + Titre + N° de tome + Auteurs)
// en ISBN-13 français vérifié sous triple verrou strict anti-faux-positif.

import {
  buildEditionLineage,
  matchEditionLineageScore,
  type EditionLineage
} from '../../../shared/bibliographic/edition-lineage.util';
import { isbnUtil } from '../../../shared/bibliographic/isbn.util';
import {
  cleanTitle,
  isCompatibleSeriesName,
  isGenericVolumeTitle,
  matchesAuthorName,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from '../../../shared/bibliographic/text-normalize.util';
import type { BibliographicConnectors, SourceCandidateRecord, SourceName } from '../../connectors/types';

export interface SeriesVolumeIdentificationInput {
  seriesName: string;
  title: string;
  volumeNumber: number | null;
  authors: string[];
  mediaFamily?: 'graphic' | 'prose' | 'neutral';
  isIntegral?: boolean;
  /** Lignée éditoriale privilégiée (cohérence de série ou recherche ciblée d'une édition). */
  preferredEdition?: EditionLineage | null;
  /** Si true, élargit le nombre de notices BnF explorées pour repérer des rééditions spécifiques. */
  deepEditionSearch?: boolean;
}

export interface DiscoveredEditionCandidate {
  isbn13: string;
  publisher: string | null;
  collectionName: string | null;
  publishYear: string | null;
  pageCount: number | null;
  coverUrl: string | null;
  source: SourceName;
  lineageScore: number;
  score: number;
}

export class BookIdentifierService {
  private readonly connectors: BibliographicConnectors;

  constructor(deps: { connectors: BibliographicConnectors }) {
    this.connectors = deps.connectors;
  }

  /**
   * Identifie le meilleur ISBN-13 français pour un tome connu d'une série (Phase 3B)
   * en réutilisant BnF SRU d'abord puis Inventaire.io uniquement en filet de secours.
   */
  async findBestIsbnForSeriesVolume(input: SeriesVolumeIdentificationInput): Promise<string | null> {
    const ranked = await this.findRankedIsbnsForSeriesVolume(input, 1);
    return ranked[0] ?? null;
  }

  /**
   * Identifie jusqu'à `limit` ISBN-13 français distincts appartenant à la MÊME Œuvre abstraite.
   */
  async findRankedIsbnsForSeriesVolume(
    input: SeriesVolumeIdentificationInput,
    limit = 4
  ): Promise<string[]> {
    const editions = await this.findRankedEditionsForSeriesVolume(input, limit);
    return editions.map((e) => e.isbn13);
  }

  /**
   * Identifie jusqu'à `limit` éditions françaises distinctes avec leurs métadonnées propres
   * (`publisher`, `collectionName`, `publishYear`, `pageCount`, `coverUrl`) et score de compatibilité
   * avec une éventuelle lignée éditoriale privilégiée (`preferredEdition`).
   */
  async findRankedEditionsForSeriesVolume(
    input: SeriesVolumeIdentificationInput,
    limit = 4
  ): Promise<DiscoveredEditionCandidate[]> {
    const cleanS = input.seriesName.trim();
    const cleanT = cleanTitle(input.title);
    const normTargetTitle = normalizeTextKey(cleanT);
    const isGeneric = isGenericVolumeTitle(cleanT, cleanS);
    const targetVolStr =
      typeof input.volumeNumber === 'number' && input.volumeNumber > 0 ? String(input.volumeNumber) : '';
    const primaryAuthor = input.authors.find((a) => a.trim().length >= 2);
    const mediaFamily = input.mediaFamily ?? 'neutral';
    const preferredLineage = input.preferredEdition ?? null;
    const bnfLimit = input.deepEditionSearch ? 20 : 10;

    if (!cleanS && !cleanT) return [];

    const scoreCandidate = (hit: SourceCandidateRecord): DiscoveredEditionCandidate | null => {
      if (hit.isNonBook) return null;
      const isbn13 = isbnUtil.normalizeToIsbn13(hit.isbn13);
      if (!isbn13) return null;

      // Rejeter une intégrale / coffret lorsqu'on cherche un tome unitaire
      if (!input.isIntegral && hit.isIntegralHint) return null;

      // Respect strict de la famille média (BD vs Roman)
      if (mediaFamily === 'graphic' && hit.contentKind === 'text_only') return null;
      if (mediaFamily === 'prose' && hit.contentKind === 'illustrated') return null;

      // Exclure les éditions étrangères explicites (ne retenir que le français ou langue absente)
      const lang = (hit.language ?? '').toLowerCase();
      if (lang && lang !== 'fr' && lang !== 'fre') return null;

      // Si la notice porte une série explicite incompatible (ex. "La collection Spirou...", "Diptyque...", autre série) -> rejet
      const seriesCompatible = Boolean(
        cleanS && hit.seriesName && isCompatibleSeriesName(hit.seriesName, cleanS)
      );
      if (cleanS && hit.seriesName && !seriesCompatible) return null;

      const hitTitleClean = cleanTitle(hit.title ?? '');
      const normHitTitle = normalizeTextKey(hitTitleClean);
      const exactTitleMatch = Boolean(!isGeneric && normTargetTitle && normHitTitle === normTargetTitle);
      const overlap =
        !isGeneric && cleanT && hitTitleClean
          ? Math.min(tokenOverlapRatio(cleanT, hitTitleClean), tokenOverlapRatio(hitTitleClean, cleanT))
          : 0;
      const strongTitleMatch = exactTitleMatch || (!isGeneric && overlap >= 0.7);

      const hitVolStr = normalizeSeriesNumber(hit.volumeNumber);
      const sameVolume = Boolean(targetVolStr && hitVolStr && hitVolStr === targetVolStr);
      const conflictingVolume = Boolean(
        targetVolStr && hitVolStr && /^\d+$/.test(hitVolStr) && hitVolStr !== targetVolStr
      );

      // Deux numéros de tome connus et différents : rejeté, SAUF correspondance exacte sur un titre distinctif
      // dans la même série (ex. Tintin au Congo : #1 Casterman vs #2 Wikidata).
      if (conflictingVolume && !(exactTitleMatch && seriesCompatible)) return null;

      const authorMatched = Boolean(
        input.authors.length > 0 &&
          hit.authors.some((ha) => input.authors.some((ia) => matchesAuthorName(ha, ia)))
      );

      // Preuve positive minimale obligatoire (triple verrou anti-homonyme)
      if (!isGeneric) {
        if (!strongTitleMatch) {
          if (!(seriesCompatible && sameVolume)) return null;
        } else if (!seriesCompatible && !authorMatched && !sameVolume) {
          return null;
        }
      } else {
        if (!(seriesCompatible && sameVolume)) return null;
      }

      let score = 0;
      if (seriesCompatible) score += 40;
      if (sameVolume) score += 30;
      if (exactTitleMatch) score += 30;
      else if (strongTitleMatch) score += 20;
      if (authorMatched) score += 12;
      if (isbn13.startsWith('9782') || isbn13.startsWith('97910')) score += 15;
      if (hit.coverUrl) score += 15;
      if (hit.publisher) score += 5;
      if (hit.source === 'bnf') score += 5;

      const hitLineage = buildEditionLineage({
        isbn13,
        publisher: hit.publisher ?? null,
        collectionName: hit.collectionName ?? null,
        publishYear: hit.publishYear ?? null
      });
      const lineageScore = preferredLineage ? matchEditionLineageScore(preferredLineage, hitLineage) : 0;
      if (lineageScore >= 60) {
        score += Math.round(lineageScore * 0.6);
      }

      return {
        isbn13,
        publisher: hit.publisher ?? null,
        collectionName: hit.collectionName ?? null,
        publishYear: hit.publishYear ?? null,
        pageCount: hit.pageCount ?? null,
        coverUrl: hit.coverUrl ?? null,
        source: hit.source,
        lineageScore,
        score
      };
    };

    const collected = new Map<string, DiscoveredEditionCandidate>();
    const absorbHits = (hits: SourceCandidateRecord[]): DiscoveredEditionCandidate[] => {
      for (const hit of hits) {
        const scored = scoreCandidate(hit);
        if (!scored) continue;
        const prev = collected.get(scored.isbn13);
        if (!prev || scored.score > prev.score) {
          collected.set(scored.isbn13, {
            ...scored,
            publisher: scored.publisher ?? prev?.publisher ?? null,
            collectionName: scored.collectionName ?? prev?.collectionName ?? null,
            publishYear: scored.publishYear ?? prev?.publishYear ?? null,
            pageCount: scored.pageCount ?? prev?.pageCount ?? null,
            coverUrl: scored.coverUrl ?? prev?.coverUrl ?? null
          });
        }
      }
      return Array.from(collected.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    };

    const hasPreferredHit = (): boolean =>
      !preferredLineage || Array.from(collected.values()).some((c) => c.lineageScore >= 60);

    // Passe 1 (BnF) : Titre exact + Auteur (ou Série + N° si titre générique)
    const pass1Query =
      !isGeneric && normTargetTitle.length >= 3
        ? cleanT
        : cleanS && targetVolStr
          ? `${cleanS} ${targetVolStr}`
          : cleanT || cleanS;

    if (pass1Query) {
      const hits1 = await this.connectors.bnf
        .searchByTitleAndAuthor(pass1Query, primaryAuthor, bnfLimit)
        .catch(() => []);
      const ranked1 = absorbHits(hits1);
      if (ranked1.length > 0 && (!input.deepEditionSearch || hasPreferredHit())) {
        return ranked1;
      }
    }

    // Passe 1B (recherche ciblée d'édition uniquement) : requête BnF plein texte combinant titre + éditeur/collection visé
    if (
      input.deepEditionSearch &&
      preferredLineage &&
      !hasPreferredHit() &&
      this.connectors.bnf.searchAnywhere
    ) {
      const edHint = preferredLineage.collectionName || preferredLineage.publisher;
      const baseQ = !isGeneric && cleanT ? cleanT : `${cleanS} ${targetVolStr}`.trim();
      if (edHint && baseQ) {
        const hitsEd = await this.connectors.bnf
          .searchAnywhere(`${baseQ} ${edHint}`, 12)
          .catch(() => []);
        const rankedEd = absorbHits(hitsEd);
        if (rankedEd.length > 0 && hasPreferredHit()) {
          return rankedEd;
        }
      }
    }

    // Passe 2A (BnF sans auteur) : couvre les changements d'auteurs multi-époques et les pseudonymes
    if (primaryAuthor && !isGeneric && normTargetTitle.length >= 4) {
      const hits2a = await this.connectors.bnf
        .searchByTitleAndAuthor(cleanT, undefined, bnfLimit)
        .catch(() => []);
      const ranked2a = absorbHits(hits2a);
      if (ranked2a.length > 0 && (!input.deepEditionSearch || hasPreferredHit())) {
        return ranked2a;
      }
    }

    // Passe 2B (BnF Série + Numéro de tome sans auteur) : filet très fiable pour les albums numérotés
    if (cleanS && targetVolStr && (!pass1Query || pass1Query !== `${cleanS} ${targetVolStr}` || Boolean(primaryAuthor))) {
      const hits2b = await this.connectors.bnf
        .searchByTitleAndAuthor(`${cleanS} ${targetVolStr}`, undefined, bnfLimit)
        .catch(() => []);
      const ranked2b = absorbHits(hits2b);
      if (ranked2b.length > 0 && (!input.deepEditionSearch || hasPreferredHit())) {
        return ranked2b;
      }
    }

    // Passe 3 (Secours Inventaire.io uniquement si la BnF n'a rien trouvé ou si la lignée visée manque encore)
    if (this.connectors.inventaire.searchByText && (collected.size === 0 || (input.deepEditionSearch && !hasPreferredHit()))) {
      const invQuery = !isGeneric && cleanT ? cleanT : `${cleanS} ${targetVolStr}`.trim();
      if (invQuery) {
        const invHits = await this.connectors.inventaire.searchByText(invQuery, 6).catch(() => []);
        absorbHits(invHits);
      }
    }

    return Array.from(collected.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
