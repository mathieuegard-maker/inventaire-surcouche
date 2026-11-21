// src/core/services/work-edition-harvester.service.ts
// Moissonnage multi-éditions en arrière-plan pour rattacher tous les ISBN connus d'une Œuvre.

import {
  bnfResolver,
  isFrancophoneBookIsbn13,
  normalizeSeriesNumber,
  normalizeTextKey
} from '../resolvers/bnf.resolver';
import { isbnUtil } from '../utils/isbn.util';

export interface HarvestWorkEditionsResult {
  knownIsbns: string[];
  openLibraryWorkKey?: string;
  fallbackCoverUrl?: string;
}

function addNormalizedIsbn(target: Set<string>, raw?: string, requireFrancophone = false): void {
  if (!raw) return;
  const norm = isbnUtil.normalize(raw);
  if (!norm || !isbnUtil.isValidFormat(norm)) return;
  if (norm.length === 13) {
    if (!requireFrancophone || isFrancophoneBookIsbn13(norm)) {
      target.add(norm);
    }
  } else if (norm.length === 10) {
    const isbn13 = isbnUtil.toIsbn13(norm);
    if (isbn13 && (!requireFrancophone || isFrancophoneBookIsbn13(isbn13))) {
      target.add(isbn13);
    }
  }
}

export const workEditionHarvesterService = {
  async harvestKnownIsbnsForWork(params: {
    title: string;
    authors?: string[];
    series?: string;
    seriesNumber?: string;
    seedIsbns?: Array<string | undefined>;
  }): Promise<HarvestWorkEditionsResult> {
    const isbns = new Set<string>();
    for (const s of params.seedIsbns || []) addNormalizedIsbn(isbns, s);

    const cleanTitle = (params.title || '').trim();
    const normTargetTitle = normalizeTextKey(cleanTitle);
    const normTargetSeries = params.series ? normalizeTextKey(params.series) : '';
    const targetVol = params.seriesNumber ? normalizeSeriesNumber(params.seriesNumber) : '';
    const isHomonymousSeriesTitle = Boolean(normTargetSeries && normTargetTitle === normTargetSeries);

    // Si un titre de tome est identique au nom de la série sans numéro de tome (ex: "Les éphémères"),
    // tout moissonnage par titre fusionnerait les ISBN de tous les tomes ensemble.
    if (isHomonymousSeriesTitle && !targetVol) {
      return { knownIsbns: Array.from(isbns) };
    }
    const primaryAuthor = (params.authors || []).find(
      (a) => a && normalizeTextKey(a) !== 'auteur inconnu'
    );

    if (!cleanTitle || normTargetTitle.length < 3) {
      return { knownIsbns: Array.from(isbns) };
    }

    const skipOpenLibrary = Boolean(targetVol || isHomonymousSeriesTitle);

    const [bnfRes, olRes] = await Promise.allSettled([
      bnfResolver.searchCandidatesByHints({
        title: cleanTitle,
        series: params.series,
        volumeNumber: params.seriesNumber,
        author: primaryAuthor
      }),
      skipOpenLibrary
        ? Promise.resolve(null)
        : (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3500);
            try {
              const qs = new URLSearchParams({
                title: cleanTitle,
                limit: '2',
                fields: 'key,title,isbn,cover_i'
              });
              if (primaryAuthor) qs.set('author', primaryAuthor);
              const res = await fetch(`https://openlibrary.org/search.json?${qs.toString()}`, {
                signal: controller.signal
              });
              if (!res.ok) return null;
              return (await res.json()) as {
                docs?: Array<{ key?: string; title?: string; isbn?: string[]; cover_i?: number }>;
              };
            } finally {
              clearTimeout(timer);
            }
          })()
    ]);

    let fallbackCoverUrl: string | undefined;
    if (bnfRes.status === 'fulfilled' && Array.isArray(bnfRes.value)) {
      for (const cand of bnfRes.value.slice(0, 12)) {
        if ((cand.meta as any).isIntegral || (cand.meta as any)._isIntegral) continue;
        const candTitleNorm = normalizeTextKey(cand.meta.title || '');
        if (candTitleNorm !== normTargetTitle) continue;
        const candVol = cand.meta.seriesNumber ? normalizeSeriesNumber(cand.meta.seriesNumber) : '';
        if (targetVol && candVol && candVol !== targetVol) continue;
        if ((targetVol && !candVol) || (!targetVol && candVol)) {
          if (isHomonymousSeriesTitle || (cand.meta.series && normalizeTextKey(cand.meta.series) === candTitleNorm)) {
            continue;
          }
        }
        addNormalizedIsbn(isbns, cand.meta.isbn, true);
        if (!fallbackCoverUrl && cand.meta.coverUrl) {
          fallbackCoverUrl = cand.meta.coverUrl;
        }
      }
    }

    let openLibraryWorkKey: string | undefined;
    if (olRes.status === 'fulfilled' && olRes.value?.docs?.length) {
      for (const doc of olRes.value.docs) {
        if (normalizeTextKey(doc.title || '') !== normTargetTitle) continue;
        if (!openLibraryWorkKey && doc.key) openLibraryWorkKey = doc.key;
        if (!fallbackCoverUrl && doc.cover_i) {
          fallbackCoverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
        }
        for (const rawIsbn of (doc.isbn || []).slice(0, 40)) {
          addNormalizedIsbn(isbns, rawIsbn, true);
        }
      }
    }

    return {
      knownIsbns: Array.from(isbns),
      openLibraryWorkKey,
      fallbackCoverUrl
    };
  }
};
