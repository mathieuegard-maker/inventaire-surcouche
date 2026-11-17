// src/core/services/work-edition-harvester.service.ts
// Moissonnage multi-éditions en arrière-plan pour rattacher tous les ISBN connus d'une Œuvre.

import { bnfResolver, normalizeTextKey } from '../resolvers/bnf.resolver';
import { isbnUtil } from '../utils/isbn.util';

export interface HarvestWorkEditionsResult {
  knownIsbns: string[];
  openLibraryWorkKey?: string;
}

function addNormalizedIsbn(target: Set<string>, raw?: string): void {
  if (!raw) return;
  const norm = isbnUtil.normalize(raw);
  if (!norm) return;
  if (norm.length === 13) {
    target.add(norm);
  } else if (norm.length === 10) {
    target.add(norm);
    const isbn13 = isbnUtil.toIsbn13(norm);
    if (isbn13) target.add(isbn13);
  }
}

export const workEditionHarvesterService = {
  async harvestKnownIsbnsForWork(params: {
    title: string;
    authors?: string[];
    seedIsbns?: Array<string | undefined>;
  }): Promise<HarvestWorkEditionsResult> {
    const isbns = new Set<string>();
    for (const s of params.seedIsbns || []) addNormalizedIsbn(isbns, s);

    const cleanTitle = (params.title || '').trim();
    const normTargetTitle = normalizeTextKey(cleanTitle);
    const primaryAuthor = (params.authors || []).find(
      (a) => a && normalizeTextKey(a) !== 'auteur inconnu'
    );

    if (!cleanTitle || normTargetTitle.length < 3) {
      return { knownIsbns: Array.from(isbns) };
    }

    const [bnfRes, olRes] = await Promise.allSettled([
      bnfResolver.searchCandidatesByHints({
        title: cleanTitle,
        author: primaryAuthor
      }),
      (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        try {
          const qs = new URLSearchParams({
            title: cleanTitle,
            limit: '2',
            fields: 'key,title,isbn'
          });
          if (primaryAuthor) qs.set('author', primaryAuthor);
          const res = await fetch(`https://openlibrary.org/search.json?${qs.toString()}`, {
            signal: controller.signal
          });
          if (!res.ok) return null;
          return (await res.json()) as {
            docs?: Array<{ key?: string; title?: string; isbn?: string[] }>;
          };
        } finally {
          clearTimeout(timer);
        }
      })()
    ]);

    if (bnfRes.status === 'fulfilled' && Array.isArray(bnfRes.value)) {
      for (const cand of bnfRes.value.slice(0, 12)) {
        const candTitleNorm = normalizeTextKey(cand.meta.title || '');
        if (candTitleNorm === normTargetTitle || candTitleNorm.startsWith(`${normTargetTitle} `)) {
          addNormalizedIsbn(isbns, cand.meta.isbn);
        }
      }
    }

    let openLibraryWorkKey: string | undefined;
    if (olRes.status === 'fulfilled' && olRes.value?.docs?.length) {
      for (const doc of olRes.value.docs) {
        if (normalizeTextKey(doc.title || '') !== normTargetTitle) continue;
        if (!openLibraryWorkKey && doc.key) openLibraryWorkKey = doc.key;
        for (const rawIsbn of (doc.isbn || []).slice(0, 40)) {
          addNormalizedIsbn(isbns, rawIsbn);
        }
      }
    }

    return {
      knownIsbns: Array.from(isbns),
      openLibraryWorkKey
    };
  }
};
