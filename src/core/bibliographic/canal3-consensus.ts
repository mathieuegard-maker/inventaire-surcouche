// src/core/bibliographic/canal3-consensus.ts
// Moteur unique de scoring, consensus multi-sources et génération des alternatives Canal 3
// (partagé entre le service Back-End `canal3-resolver.service.ts` et le repli client `photo-book-resolution.service.ts`).

import {
  isFrancophoneBookIsbn13,
  normalizeTextKey,
  scoreHintMatch,
  type BnfHintQuery
} from '../resolvers/bnf.resolver';
import type { ExternalBookMetadata } from '../types';
import { imageUtil } from '../utils/image.util';
import { isbnUtil } from '../utils/isbn.util';
import { computeCanal3WorkKey, hasTextTokenOverlap, isMetaIntegral } from './work-identity';

export type Canal3Source = 'bnf' | 'openlibrary' | 'google';

export interface Canal3ScoredInput {
  source: Canal3Source;
  meta: ExternalBookMetadata;
  precomputedScore?: number;
}

export interface Canal3RankedOption {
  isbn13: string;
  title: string;
  authors: string[];
  publisher?: string;
  publishDate?: string;
  pageCount?: number;
  coverUrl?: string;
  coverFallbackUrls?: string[];
  series?: string;
  seriesNumber?: string;
  isIntegral?: boolean;
  includedVolumeNumbers?: string[];
  score: number;
  sourcesCount: number;
}

export interface Canal3ConsensusOutput {
  isbn13?: string;
  knownIsbns?: string[];
  meta?: ExternalBookMetadata;
  topScore: number;
  sourcesCount: number;
  isDoubt: boolean;
  alternatives: Canal3RankedOption[];
}

const CONSENSUS_SCORE_THRESHOLD = 28;
const DOUBT_MIN_SCORE_THRESHOLD = 18;
const DOUBT_COMPETITOR_GAP = 10;
const MULTI_SOURCE_ISBN_BONUS = 22;
const MULTI_SOURCE_WORK_BONUS = 14;
const BNF_AUTHORITY_TIEBREAK = 6;
const MAX_ALTERNATIVES = 10;

interface ConsensusBucket {
  isbn13: string;
  bestScore: number;
  sources: Set<Canal3Source>;
  workKey: string;
  bestMeta: ExternalBookMetadata;
  fromBnf: boolean;
}

function normalizeToIsbn13(raw?: string): string | undefined {
  if (!raw || !isbnUtil.isValidFormat(raw)) return undefined;
  const clean = isbnUtil.normalize(raw);
  if (!clean) return undefined;
  return clean.length === 10 ? isbnUtil.toIsbn13(clean) : clean;
}

/**
 * Agrège, score et classe les candidats multi-sources (BnF, OpenLibrary, Google Books)
 * en produisant l'édition gagnante, ses ISBN frères, les alternatives distinctes et l'indicateur de doute.
 */
export function rankCanal3Consensus(params: {
  inputs: Canal3ScoredInput[];
  hints: BnfHintQuery;
  aiConfidence?: 'high' | 'medium' | 'low';
  maxAlternatives?: number;
}): Canal3ConsensusOutput {
  const { inputs, hints, aiConfidence, maxAlternatives = MAX_ALTERNATIVES } = params;
  const buckets = new Map<string, ConsensusBucket>();
  const workKeySources = new Map<string, Set<Canal3Source>>();

  for (const item of inputs) {
    const normIsbn = normalizeToIsbn13(item.meta.isbn);
    if (!normIsbn || !isFrancophoneBookIsbn13(normIsbn)) continue;

    const score = typeof item.precomputedScore === 'number' ? item.precomputedScore : scoreHintMatch(item.meta, hints);
    if (score < DOUBT_MIN_SCORE_THRESHOLD - 6) continue;

    const workKey = computeCanal3WorkKey(item.meta, hints.volumeNumber);
    if (workKey) {
      const sSet = workKeySources.get(workKey) || new Set<Canal3Source>();
      sSet.add(item.source);
      workKeySources.set(workKey, sSet);
    }

    const existing = buckets.get(normIsbn);
    if (!existing) {
      buckets.set(normIsbn, {
        isbn13: normIsbn,
        bestScore: score,
        sources: new Set([item.source]),
        workKey,
        bestMeta: { ...item.meta, isbn: normIsbn },
        fromBnf: item.source === 'bnf'
      });
      continue;
    }

    existing.sources.add(item.source);
    const wasFromBnf = existing.fromBnf;
    if (item.source === 'bnf') existing.fromBnf = true;

    if (score > existing.bestScore || (item.source === 'bnf' && !wasFromBnf)) {
      existing.bestScore = Math.max(existing.bestScore, score);
      existing.bestMeta = {
        ...existing.bestMeta,
        ...item.meta,
        isbn: normIsbn,
        coverUrl: item.meta.coverUrl || existing.bestMeta.coverUrl
      };
    } else if (!existing.bestMeta.coverUrl && item.meta.coverUrl) {
      existing.bestMeta.coverUrl = item.meta.coverUrl;
    }
    if (!existing.workKey && workKey) {
      existing.workKey = workKey;
    }
  }

  const ranked = Array.from(buckets.values())
    .map((bucket) => {
      const wkSourceCount = bucket.workKey ? (workKeySources.get(bucket.workKey)?.size ?? 1) : 1;
      const effectiveSources = Math.max(bucket.sources.size, wkSourceCount);
      const isbnConsensusBonus = Math.max(0, bucket.sources.size - 1) * MULTI_SOURCE_ISBN_BONUS;
      const workConsensusBonus = Math.max(0, wkSourceCount - bucket.sources.size) * MULTI_SOURCE_WORK_BONUS;
      const tieBreak = bucket.fromBnf ? BNF_AUTHORITY_TIEBREAK : 0;
      const finalScore = bucket.bestScore + isbnConsensusBonus + workConsensusBonus + tieBreak;
      return { bucket, effectiveSources, finalScore };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  const top = ranked[0];
  if (!top || top.finalScore < DOUBT_MIN_SCORE_THRESHOLD) {
    return { topScore: 0, sourcesCount: 0, isDoubt: false, alternatives: [] };
  }

  const seenSlots = new Set<string>();
  const alternatives: Canal3RankedOption[] = [];
  const topAnchorText = `${top.bucket.bestMeta.series || ''} ${top.bucket.bestMeta.title || ''}`.trim();
  const minAltScore = Math.max(DOUBT_MIN_SCORE_THRESHOLD - 4, top.finalScore - 36);

  for (const entry of ranked) {
    const isInt = isMetaIntegral(entry.bucket.bestMeta);
    const candText = `${entry.bucket.bestMeta.series || ''} ${entry.bucket.bestMeta.title || ''}`.trim();
    const isSameFamilyIntegral = isInt && hasTextTokenOverlap(candText, topAnchorText);
    if (entry.finalScore < minAltScore && !isSameFamilyIntegral) continue;
    if (entry.finalScore < DOUBT_MIN_SCORE_THRESHOLD - 4) break;

    const wk = entry.bucket.workKey || `isbn:${entry.bucket.isbn13}`;
    const slotKey = `${wk}|${isInt ? 'INT' : 'UNIT'}|${normalizeTextKey(entry.bucket.bestMeta.publisher || '')}`;
    if (seenSlots.has(slotKey) && alternatives.length >= 2) continue;
    seenSlots.add(slotKey);

    const fallbacks = imageUtil.buildCoverCandidates(entry.bucket.isbn13, [
      entry.bucket.bestMeta.coverUrl,
      ...(entry.bucket.bestMeta.coverFallbackUrls || [])
    ]);
    alternatives.push({
      isbn13: entry.bucket.isbn13,
      title: entry.bucket.bestMeta.title || hints.title || 'Titre inconnu',
      authors: entry.bucket.bestMeta.authors || [],
      publisher: entry.bucket.bestMeta.publisher,
      publishDate: entry.bucket.bestMeta.publishDate,
      pageCount: entry.bucket.bestMeta.pageCount,
      coverUrl: entry.bucket.bestMeta.coverUrl || fallbacks[0],
      coverFallbackUrls: fallbacks,
      series: entry.bucket.bestMeta.series,
      seriesNumber: entry.bucket.bestMeta.seriesNumber,
      isIntegral: isInt,
      score: entry.finalScore,
      sourcesCount: entry.effectiveSources
    });
    if (alternatives.length >= maxAlternatives) break;
  }

  const topIsInt = isMetaIntegral(top.bucket.bestMeta);
  const secondDistinct = alternatives.find((alt, idx) => {
    if (idx === 0 || alt.isbn13 === top.bucket.isbn13) return false;
    if (Boolean(alt.isIntegral) !== topIsInt) return true;
    const altWk = computeCanal3WorkKey(
      {
        title: alt.title,
        authors: alt.authors,
        series: alt.series,
        seriesNumber: alt.seriesNumber,
        isIntegral: alt.isIntegral
      },
      hints.volumeNumber
    );
    return !top.bucket.workKey || altWk !== top.bucket.workKey;
  });

  const hasCompetingWork =
    Boolean(secondDistinct) &&
    top.effectiveSources < 2 &&
    top.finalScore - (secondDistinct?.score || 0) <= DOUBT_COMPETITOR_GAP;
  const isBorderlineScore = top.finalScore < CONSENSUS_SCORE_THRESHOLD;
  const isLowConfidenceSingle = aiConfidence === 'low' && top.effectiveSources < 2;
  const isDoubt = isBorderlineScore || hasCompetingWork || isLowConfidenceSingle;

  const topWorkIsbns = top.bucket.workKey
    ? Array.from(new Set(ranked.filter((r) => r.bucket.workKey === top.bucket.workKey).map((r) => r.bucket.isbn13)))
    : [top.bucket.isbn13];

  return {
    isbn13: top.bucket.isbn13,
    knownIsbns: topWorkIsbns,
    meta: top.bucket.bestMeta,
    topScore: top.finalScore,
    sourcesCount: top.effectiveSources,
    isDoubt,
    alternatives
  };
}
