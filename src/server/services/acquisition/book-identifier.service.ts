// src/server/services/acquisition/book-identifier.service.ts
// Brique réutilisable Étage 1 (Phase 3B) : convertit un indice (Série + Titre + N° de tome + Auteurs)
// en ISBN-13 français vérifié sous triple verrou strict anti-faux-positif.

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
import type { BibliographicConnectors, SourceCandidateRecord } from '../../connectors/types';

export interface SeriesVolumeIdentificationInput {
  seriesName: string;
  title: string;
  volumeNumber: number | null;
  authors: string[];
  mediaFamily?: 'graphic' | 'prose' | 'neutral';
  isIntegral?: boolean;
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
    const cleanS = input.seriesName.trim();
    const cleanT = cleanTitle(input.title);
    const normTargetTitle = normalizeTextKey(cleanT);
    const isGeneric = isGenericVolumeTitle(cleanT, cleanS);
    const targetVolStr =
      typeof input.volumeNumber === 'number' && input.volumeNumber > 0 ? String(input.volumeNumber) : '';
    const primaryAuthor = input.authors.find((a) => a.trim().length >= 2);
    const mediaFamily = input.mediaFamily ?? 'neutral';

    if (!cleanS && !cleanT) return null;

    const scoreCandidate = (hit: SourceCandidateRecord): { isbn13: string; score: number } | null => {
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
          // Si le titre diffère trop, n'accepter que si série compatible + numéro exact
          if (!(seriesCompatible && sameVolume)) return null;
        } else if (!seriesCompatible && !authorMatched && !sameVolume) {
          // Titre seul sans aucune confirmation par série, auteur ni numéro -> trop risqué (homonyme)
          return null;
        }
      } else {
        // Titre générique ("Tome 4") -> exige impérativement série compatible + numéro de tome identique
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

      return { isbn13, score };
    };

    const pickBest = (hits: SourceCandidateRecord[]): { isbn13: string; score: number } | null => {
      let best: { isbn13: string; score: number } | null = null;
      for (const hit of hits) {
        const scored = scoreCandidate(hit);
        if (!scored) continue;
        if (!best || scored.score > best.score) {
          best = scored;
        }
      }
      return best;
    };

    // Passe 1 (BnF) : Titre exact + Auteur (ou Série + N° si titre générique)
    const pass1Query =
      !isGeneric && normTargetTitle.length >= 3
        ? cleanT
        : cleanS && targetVolStr
          ? `${cleanS} ${targetVolStr}`
          : cleanT || cleanS;

    if (pass1Query) {
      const hits1 = await this.connectors.bnf
        .searchByTitleAndAuthor(pass1Query, primaryAuthor, 10)
        .catch(() => []);
      const best1 = pickBest(hits1);
      if (best1) return best1.isbn13;
    }

    // Passe 2A (BnF sans auteur) : couvre les changements d'auteurs multi-époques et les pseudonymes
    if (primaryAuthor && !isGeneric && normTargetTitle.length >= 4) {
      const hits2a = await this.connectors.bnf
        .searchByTitleAndAuthor(cleanT, undefined, 10)
        .catch(() => []);
      const best2a = pickBest(hits2a);
      if (best2a) return best2a.isbn13;
    }

    // Passe 2B (BnF Série + Numéro de tome sans auteur) : filet très fiable pour les albums numérotés
    if (cleanS && targetVolStr && (!pass1Query || pass1Query !== `${cleanS} ${targetVolStr}` || Boolean(primaryAuthor))) {
      const hits2b = await this.connectors.bnf
        .searchByTitleAndAuthor(`${cleanS} ${targetVolStr}`, undefined, 10)
        .catch(() => []);
      const best2b = pickBest(hits2b);
      if (best2b) return best2b.isbn13;
    }

    // Passe 3 (Secours Inventaire.io uniquement si la BnF n'a rien trouvé)
    if (this.connectors.inventaire.searchByText) {
      const invQuery = !isGeneric && cleanT ? cleanT : `${cleanS} ${targetVolStr}`.trim();
      if (invQuery) {
        const invHits = await this.connectors.inventaire.searchByText(invQuery, 4).catch(() => []);
        const best3 = pickBest(invHits);
        if (best3) return best3.isbn13;
      }
    }

    return null;
  }
}
