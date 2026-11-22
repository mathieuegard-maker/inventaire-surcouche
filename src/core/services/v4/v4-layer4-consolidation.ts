// src/core/services/v4/v4-layer4-consolidation.ts
// Couche 4 V4 : Détection intégrales, vote canonique de série, consolidation FRBR en D1 et liaison bibliothèque foyer.

import type { DatabaseBinding } from '../../adapters/storage-db.interface';
import type { EditionCatalogEntry, IntegralMetadata, ParentIntegralRef } from '../../types';
import {
  cleanSeriesName,
  cleanTitle,
  normalizeSeriesNumber,
  normalizeTextKey,
  parseSeriesFromTitle
} from '../../resolvers/bnf.resolver';
import {
  areDistinctSeriesWorkTitles,
  fetchCanonicalSeriesIndex,
  isCleanerCanonicalSeriesName,
  resolveCanonicalVolumeNumber,
  type CanonicalSeriesIndex
} from '../../resolvers/series-canonical.resolver';
import { classifyBookMetadata } from '../../utils/category-classifier.util';
import { isbnUtil } from '../../utils/isbn.util';
import { isEditorialPaperbackCollectionName, stripEditorialCollectionSuffixes } from '../../utils/series-matcher.util';
import { resolveBestCoverUrl, upsertCatalogEntity } from '../d1-gateway.service';
import { generateTraceId, PipelineTracer } from '../pipeline-logger.service';
import {
  mapBookRow,
  parseIntegralMetadataDb,
  safeJsonParse,
  serializeIntegralMetadataDb,
  type SeriesVoteCandidate,
  type SourceChannel,
  type StagingPayload,
  type UserIngestHint,
  type V4BookRecord
} from './v4-shared';

// ============================================================================
// COUCHE 4 : CONSOLIDATION POST-COLLECTE (DOUBLES = INTÉGRALES, VOTE SÉRIE, HÉRITAGE TOME -> HORS-SÉRIE)
// ============================================================================

export function detectIntegralAndIncludedVolumes(payload: StagingPayload): {
  isIntegral: boolean;
  isDoubleAlbum: boolean;
  doubleSubTitles: string[];
  includedVolumeNumbers: string[];
  integralOrdinal?: string;
} {
  const allTexts = [payload.anchorTitle, ...payload.rawTitles];
  const combined = allTexts.join(' | ');
  const combinedWithoutTexteIntegral = combined.replace(/\b(?:texte|version)\s+int[ée]grale?\b/gi, ' ');
  const desc = payload.description || '';

  // 1. Détection explicite d'intégrale / coffret / omnibus / plage de tomes (hors mention "texte intégral")
  const hasExplicitIntegralKeyword = /(?:l['’]?\s*int[ée]grale|\bint[ée]grale?\b|\bcoffret\b|\bomnibus\b|\bcompil\b|\bdouble\s+album\b|\b2\s+en\s+1\b|\btomes?\s+\d+\s*(?:[àa]|et|&|-|\/)\s*\d+)/i.test(
    combinedWithoutTexteIntegral
  );

  const nums = new Set<string>(payload.includedVolumeNumbersHint || []);
  for (const srcText of [combinedWithoutTexteIntegral, desc]) {
    // Exiger un mot-clé de volume/tome/intégrale avant la plage numérique pour ne jamais confondre un titre historique ("14-18", "39-45") avec une intégrale !
    const rangeMatch = /(?:tomes?|volumes?|vol\.?|albums?|int[ée]grale|coffret)\s*[:.n°#]?\s*(\d{1,2})\s*(?:[àa]|-|au)\s*(\d{1,2})\b/i.exec(srcText);
    if (rangeMatch) {
      const startN = parseInt(rangeMatch[1], 10);
      const endN = parseInt(rangeMatch[2], 10);
      if (startN > 0 && endN > startN && endN - startN <= 15) {
        for (let i = startN; i <= endN; i++) nums.add(String(i));
      }
    }
    const pairMatch = /\b(?:tomes?|volumes?|vol\.?|albums?)\s*(\d{1,2})\s*(?:et|&|\/|\+|,)\s*(\d{1,2})(?:\s*(?:et|&|,)\s*(\d{1,2}))?\b/i.exec(srcText);
    if (pairMatch) {
      for (const grp of [pairMatch[1], pairMatch[2], pairMatch[3]]) {
        if (grp) nums.add(String(parseInt(grp, 10)));
      }
    }
  }

  // Numéro d'intégrale (ex: "Intégrale 1", "Intégrale 02", "Coffret 2")
  const ordMatch = /(?:l['’]?\s*int[ée]grale|int[ée]grale|coffret|omnibus)\s*(?:n°\s*)?0*(\d{1,2})\b/i.exec(combined);
  const integralOrdinal = ordMatch ? String(parseInt(ordMatch[1], 10)) : payload.integralOrdinalHint;

  // 2. Détection Album Double (ex: "Astérix le Gaulois / La serpe d'or", "Titre A ; Titre B", "Titre A suivi de Titre B")
  // Ne jamais déclencher sur un simple sous-titre de one-shot ("Journal", "Enquête", "Roman", etc.) !
  let isDoubleAlbum = false;
  let doubleSubTitles: string[] = [];
  const primaryTitle = payload.anchorTitle || payload.rawTitles[0] || '';
  const slashParts = primaryTitle
    .split(/\s+\/\s+|\s+;\s+|\s+suivi\s+de\s+/i)
    .map((p) => cleanTitle(p))
    .filter(
      (p) =>
        p.length >= 4 &&
        !/^(?:ed\.?|edition|tome|vol|journal|enqu[êe]te|voyage|histoires|souvenirs|carnet|roman|essai|biographie|m[ée]moires|une?\s)/i.test(p)
    );
  const looksLikeTwoDistinctTitles =
    slashParts.length >= 2 &&
    slashParts.length <= 4 &&
    (payload.seriesCandidates.length > 0 ||
      /\b(?:tomes?|albums?|double|2\s+en\s+1)\b/i.test(primaryTitle) ||
      slashParts.every((p) => /^[A-ZÀ-ÖØ-Þ"«]/.test(p) && p.split(/\s+/).length >= 2));

  if (
    looksLikeTwoDistinctTitles &&
    normalizeTextKey(slashParts[0]) !== normalizeTextKey(slashParts[1]) &&
    (!payload.pageCount || payload.pageCount >= 64)
  ) {
    isDoubleAlbum = true;
    doubleSubTitles = slashParts;
  }

  const isIntegral = Boolean(
    payload.anchorIsIntegralHint || hasExplicitIntegralKeyword || isDoubleAlbum || nums.size >= 2
  );
  return {
    isIntegral,
    isDoubleAlbum,
    doubleSubTitles,
    includedVolumeNumbers: Array.from(nums).sort((a, b) => Number(a) - Number(b)),
    integralOrdinal
  };
}

export function electCanonicalSeriesFromVotes(candidates: SeriesVoteCandidate[]): {
  coreKey: string;
  canonicalName: string;
  aliases: string[];
  confidenceRatio: number;
  ensembleIds: string[];
  wikidataQids: string[];
} | null {
  if (!candidates.length) return null;

  const clusters = new Map<
    string,
    {
      totalWeight: number;
      names: Map<string, number>;
      ensembleIds: Set<string>;
      wikidataQids: Set<string>;
    }
  >();

  let totalAllWeights = 0;
  for (const c of candidates) {
    totalAllWeights += c.weight;
    let bucket = clusters.get(c.coreKey);
    if (!bucket) {
      bucket = {
        totalWeight: 0,
        names: new Map(),
        ensembleIds: new Set(),
        wikidataQids: new Set()
      };
      clusters.set(c.coreKey, bucket);
    }
    bucket.totalWeight += c.weight;
    bucket.names.set(c.cleanDisplay, (bucket.names.get(c.cleanDisplay) || 0) + c.weight);
    if (c.rawName && c.rawName !== c.cleanDisplay) {
      bucket.names.set(c.rawName, bucket.names.get(c.rawName) || 0.1);
    }
    if (c.ensembleId) bucket.ensembleIds.add(c.ensembleId);
    if (c.wikidataQid) bucket.wikidataQids.add(c.wikidataQid);
  }

  const ranked = Array.from(clusters.entries()).sort((a, b) => b[1].totalWeight - a[1].totalWeight);
  const [bestCoreKey, bestCluster] = ranked[0];
  const confidenceRatio = totalAllWeights > 0 ? bestCluster.totalWeight / totalAllWeights : 1;

  // Préférer la forme sans suffixe éditorial avec le plus fort poids
  const sortedNames = Array.from(bestCluster.names.entries()).sort((a, b) => b[1] - a[1]);
  const canonicalName = sortedNames[0]?.[0] || bestCoreKey;
  const aliases = Array.from(bestCluster.names.keys()).filter((n) => n && n !== canonicalName);

  return {
    coreKey: bestCoreKey,
    canonicalName,
    aliases,
    confidenceRatio,
    ensembleIds: Array.from(bestCluster.ensembleIds),
    wikidataQids: Array.from(bestCluster.wikidataQids)
  };
}

export async function consolidateBookLayer4(
  db: DatabaseBinding,
  payload: StagingPayload,
  options: {
    sourceChannel: SourceChannel;
    libraryId?: string | null;
    action?: 'owned' | 'wishlist' | 'preview';
    tracer?: PipelineTracer;
    userHint?: UserIngestHint;
    replaceSkeletonBookId?: string;
  }
): Promise<V4BookRecord> {
  const start = Date.now();
  const now = new Date().toISOString();
  const tracer = options.tracer;
  const userHint = options.userHint;

  // 1. Détection Intégrale & Album Double AVANT indexation (avec éventuel arbitrage explicite utilisateur)
  const integralCheck = detectIntegralAndIncludedVolumes(payload);
  if (userHint?.isIntegral === true) {
    integralCheck.isIntegral = true;
    if (Array.isArray(userHint.includedVolumeNumbers) && userHint.includedVolumeNumbers.length > 0) {
      const mergedVols = new Set<string>(integralCheck.includedVolumeNumbers);
      for (const rawVol of userHint.includedVolumeNumbers) {
        const norm = normalizeSeriesNumber(String(rawVol));
        if (norm) mergedVols.add(norm);
      }
      integralCheck.includedVolumeNumbers = Array.from(mergedVols).sort((a, b) => Number(a) - Number(b));
    }
  } else if (userHint?.isIntegral === false) {
    integralCheck.isIntegral = false;
    integralCheck.isDoubleAlbum = false;
  }

  // Si l'utilisateur a spécifié ou corrigé le nom de série, l'injecter avec un poids fort (hors collections poches/éditeurs)
  const seriesVotePool = [...payload.seriesCandidates];
  if (userHint?.series?.trim() && !isEditorialPaperbackCollectionName(userHint.series)) {
    const cleanedUserSeries = cleanSeriesName(userHint.series);
    if (!isEditorialPaperbackCollectionName(cleanedUserSeries)) {
      const { coreKey, cleanDisplay } = stripEditorialCollectionSuffixes(cleanedUserSeries);
      if (coreKey.length >= 2 && !isEditorialPaperbackCollectionName(cleanDisplay)) {
        seriesVotePool.push({
          source: 'user_hint',
          rawName: userHint.series.trim(),
          coreKey,
          cleanDisplay: cleanDisplay || cleanedUserSeries,
          weight: 5
        });
      }
    }
  }

  // 2. Vote majoritaire par cluster sur la Série Canonique
  const electedSeries = electCanonicalSeriesFromVotes(seriesVotePool);
  if (electedSeries && electedSeries.confidenceRatio < 0.6) {
    tracer?.record(
      'C4',
      'series_majority_vote',
      'warn',
      `Consensus série fragile (${Math.round(electedSeries.confidenceRatio * 100)}% < 60%) pour « ${electedSeries.canonicalName} »`,
      { candidates: payload.seriesCandidates, electedSeries }
    );
  }

  // Upsert dans v4_series si série élue (matching par coreKey OU bnfEnsembleId OU wikidataQid)
  let seriesId: string | null = null;
  let seriesName: string | null = null;
  let resolvedSeriesWdQid: string | null = null;
  let canonicalSeriesIndex: CanonicalSeriesIndex | null = null;
  if (electedSeries) {
    let existingSeries = await db
      .prepare('SELECT * FROM v4_series WHERE normalized_core_key = ? LIMIT 1')
      .bind(electedSeries.coreKey)
      .first<Record<string, any>>();

    if (!existingSeries && electedSeries.wikidataQids[0]) {
      existingSeries = await db
        .prepare('SELECT * FROM v4_series WHERE wikidata_qid = ? LIMIT 1')
        .bind(electedSeries.wikidataQids[0])
        .first<Record<string, any>>();
    }
    if (!existingSeries && electedSeries.ensembleIds[0]) {
      existingSeries = await db
        .prepare('SELECT * FROM v4_series WHERE bnf_ensemble_ids_json LIKE ? LIMIT 1')
        .bind(`%${electedSeries.ensembleIds[0]}%`)
        .first<Record<string, any>>();
    }

    resolvedSeriesWdQid =
      (existingSeries?.wikidata_qid as string | null) ||
      electedSeries.wikidataQids[0] ||
      payload.wikidataSeriesQid ||
      null;

    // Résolveur canonique de série (Wikidata P179/P1545) : ordre officiel des tomes + nom propre FR
    if (resolvedSeriesWdQid) {
      canonicalSeriesIndex = await fetchCanonicalSeriesIndex(resolvedSeriesWdQid).catch(() => null);
    }

    // Réutiliser un éventuel URI de série existant dans catalog_entities pour garantir l'unification V4 <-> V2
    let existingCatalogSeriesUri: string | null = null;
    if (!existingSeries) {
      try {
        const allCatSeries = await db
          .prepare("SELECT uri, label FROM catalog_entities WHERE entity_type = 'serie'")
          .all<{ uri: string; label: string }>();
        const matchedCat = (allCatSeries.results || []).find(
          (row) => stripEditorialCollectionSuffixes(row.label).coreKey === electedSeries.coreKey
        );
        if (matchedCat?.uri) existingCatalogSeriesUri = matchedCat.uri;
      } catch {
        // Ignore si catalog_entities absent
      }
    }

    if (existingSeries) {
      seriesId = String(existingSeries.id);
      const currentDbSeriesName = String(existingSeries.canonical_name);
      const cleanerCandidate =
        canonicalSeriesIndex?.canonicalSeriesName &&
        isCleanerCanonicalSeriesName(canonicalSeriesIndex.canonicalSeriesName, currentDbSeriesName)
          ? canonicalSeriesIndex.canonicalSeriesName
          : isCleanerCanonicalSeriesName(electedSeries.canonicalName, currentDbSeriesName)
            ? electedSeries.canonicalName
            : null;
      seriesName = cleanerCandidate || currentDbSeriesName;

      const prevAliases = safeJsonParse<string[]>(existingSeries.aliases_json, []);
      const prevEns = safeJsonParse<string[]>(existingSeries.bnf_ensemble_ids_json, []);
      const prevAuthors = safeJsonParse<string[]>(existingSeries.primary_authors_json, []);
      const mergedAliases = Array.from(
        new Set([...prevAliases, ...electedSeries.aliases, electedSeries.canonicalName, currentDbSeriesName])
      ).filter((a) => a && a !== seriesName);
      const mergedEns = Array.from(new Set([...prevEns, ...electedSeries.ensembleIds]));
      const mergedAuthors = Array.from(new Set([...prevAuthors, ...payload.authors]));
      const mergedWdQid = resolvedSeriesWdQid;

      await db
        .prepare(
          `UPDATE v4_series
           SET canonical_name = ?, aliases_json = ?, bnf_ensemble_ids_json = ?, primary_authors_json = ?, wikidata_qid = COALESCE(wikidata_qid, ?), updated_at = ?
           WHERE id = ?`
        )
        .bind(
          seriesName,
          JSON.stringify(mergedAliases),
          JSON.stringify(mergedEns),
          JSON.stringify(mergedAuthors),
          mergedWdQid,
          now,
          seriesId
        )
        .run();
    } else {
      seriesId =
        existingCatalogSeriesUri ||
        `ser_${electedSeries.coreKey.replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 7)}`;
      seriesName =
        canonicalSeriesIndex?.canonicalSeriesName &&
        isCleanerCanonicalSeriesName(canonicalSeriesIndex.canonicalSeriesName, electedSeries.canonicalName)
          ? canonicalSeriesIndex.canonicalSeriesName
          : electedSeries.canonicalName;
      await db
        .prepare(
          `INSERT INTO v4_series
            (id, canonical_name, normalized_core_key, aliases_json, primary_authors_json, wikidata_qid, bnf_ensemble_ids_json, is_complete_expanded, known_volumes_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
           ON CONFLICT(normalized_core_key) DO UPDATE SET
             canonical_name = excluded.canonical_name,
             wikidata_qid = COALESCE(v4_series.wikidata_qid, excluded.wikidata_qid),
             updated_at = excluded.updated_at`
        )
        .bind(
          seriesId,
          seriesName,
          electedSeries.coreKey,
          JSON.stringify(electedSeries.aliases),
          JSON.stringify(payload.authors),
          resolvedSeriesWdQid,
          JSON.stringify(electedSeries.ensembleIds),
          now,
          now
        )
        .run();
      const confirmedSeries = await db
        .prepare('SELECT id FROM v4_series WHERE normalized_core_key = ? LIMIT 1')
        .bind(electedSeries.coreKey)
        .first<{ id: string }>();
      if (confirmedSeries?.id) seriesId = String(confirmedSeries.id);
    }
  }

  // 3. Résolution canonique du numéro de tome (Arbitrage utilisateur > Index canonique Wikidata > Vote pondéré éditions sœurs > Titre)
  const resolvedVolume = resolveCanonicalVolumeNumber({
    userHintVolume: userHint?.volumeNumber,
    wikidataWorkQid: payload.wikidataWorkQid,
    canonicalSeriesIndex,
    sisterEditions: payload.sisterEditions,
    rawTitles: [payload.anchorTitle, ...payload.rawTitles],
    seriesName: seriesName || undefined
  });
  const inheritedVolStr = resolvedVolume.volumeNumber;

  const preferredRawTitle =
    (userHint?.title?.trim() ? userHint.title.trim() : '') ||
    (integralCheck.isIntegral
      ? [payload.anchorTitle, ...payload.rawTitles].find((t) =>
          /\b(?:l['’]?\s*int[ée]grale|int[ée]grale|coffret|omnibus)\b/i.test(t)
        ) || payload.anchorTitle
      : payload.anchorTitle);
  const parsedAnchor = parseSeriesFromTitle(preferredRawTitle);
  let canonicalTitle = cleanTitle(
    integralCheck.isIntegral && /\b(?:int[ée]grale|coffret|omnibus)\b/i.test(preferredRawTitle)
      ? preferredRawTitle
      : parsedAnchor.title || preferredRawTitle
  );
  if (canonicalTitle && seriesName) {
    const escapedSeries = seriesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = canonicalTitle.replace(new RegExp(`^${escapedSeries}\\s*[-:–]\\s*`, 'i'), '').trim();
    if (integralCheck.isIntegral) {
      // Conserver un libellé complet et distinctif pour les Intégrales (ex: "Aya de Yopougon — Intégrale 1")
      if (stripped.length >= 3 && /\b(?:int[ée]grale|coffret|omnibus|tomes?\s+\d+)/i.test(stripped)) {
        const cap = stripped.charAt(0).toUpperCase() + stripped.slice(1);
        canonicalTitle = cap.toLowerCase().includes(seriesName.toLowerCase()) ? cap : `${seriesName} — ${cap}`;
      } else if (!/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(canonicalTitle)) {
        canonicalTitle = integralCheck.integralOrdinal
          ? `${seriesName} — Intégrale ${integralCheck.integralOrdinal}`
          : `${seriesName} — Intégrale`;
      }
    } else if (stripped.length >= 3) {
      // Retirer un éventuel préfixe "Astérix - " si déjà égal à la série sur tome unitaire
      canonicalTitle = stripped;
    }
  }

  const hasAuthoritativeVolume =
    Boolean(userHint?.volumeNumber?.trim()) ||
    resolvedVolume.source === 'wikidata_series_index' ||
    resolvedVolume.source === 'weighted_vote';
  const isExplicitHs =
    !hasAuthoritativeVolume &&
    /\b(hors[- ]s[ée]rie|n°\s*sp[ée]cial|num[ée]ro\s+sp[ée]cial|hs\b|making[- ]of|artbook|tome\s*0\b)/i.test(
      payload.rawTitles.join(' ')
    );
  let volumeNumber: number | null =
    seriesId && !integralCheck.isIntegral && !isExplicitHs && inheritedVolStr
      ? parseInt(inheritedVolStr, 10)
      : null;
  if (volumeNumber !== null && (!Number.isFinite(volumeNumber) || volumeNumber <= 0 || volumeNumber > 500)) {
    volumeNumber = null;
  }

  let volumeLabel: string | null = volumeNumber !== null ? String(volumeNumber) : null;
  if (integralCheck.isIntegral) {
    const inc = integralCheck.includedVolumeNumbers;
    if (inc.length >= 2) {
      volumeLabel = `Int. T.${inc[0]}-${inc[inc.length - 1]}`;
    } else if (integralCheck.integralOrdinal) {
      volumeLabel = `Int. ${integralCheck.integralOrdinal}`;
    } else {
      volumeLabel = 'Intégrale';
    }
  }

  // Règle Hors-Série appliquée STRICTEMENT en fin de pipeline :
  // Si appartient à une série, non-intégrale, et qu'AUCUNE édition sœur FR / Wikidata n'a fourni de numéro de tome
  const isHorsSerie = Boolean(
    seriesId && !integralCheck.isIntegral && (isExplicitHs || volumeNumber === null)
  );
  const horsSerieLabel = isHorsSerie ? (isExplicitHs ? 'HS' : 'Hors-Série') : null;

  // 4. Classification catégorie & sous-genres
  const classification = classifyBookMetadata({
    title: canonicalTitle,
    series: seriesName || undefined,
    publisher: payload.publisher,
    deweyCode: payload.deweyCode,
    rawSubjects: payload.rawSubjects,
    description: payload.description
  });

  // 5. Agrégation de tous les ISBN FR sœurs + éditionsCatalog + couverture exacte de l'édition choisie en priorité
  const knownIsbnsSet = new Set<string>([payload.anchorIsbn13]);
  const editionsCatalogMap = new Map<string, EditionCatalogEntry>();
  let exactBnfCover: string | undefined;
  let exactGbCover: string | undefined;
  let exactOlCover: string | undefined;
  let exactInvCover: string | undefined;
  let bnfCoverCandidate: string | undefined;
  let gbCoverCandidate: string | undefined;
  let olCoverCandidate: string | undefined;
  let invCoverCandidate: string | undefined;

  for (const s of payload.sisterEditions) {
    if (s.isbn13 && isbnUtil.isValidBookBarcode(s.isbn13)) {
      knownIsbnsSet.add(s.isbn13);
      if (!editionsCatalogMap.has(s.isbn13)) {
        editionsCatalogMap.set(s.isbn13, {
          isbn13: s.isbn13,
          publisher: s.publisher,
          publicationYear: s.publishDate,
          coverUrl: s.coverUrl
        });
      }
    }
    const isExactAnchor = s.isbn13 === payload.anchorIsbn13;
    if (s.source === 'bnf' && s.coverUrl) {
      if (isExactAnchor && !exactBnfCover) exactBnfCover = s.coverUrl;
      if (!bnfCoverCandidate) bnfCoverCandidate = s.coverUrl;
    }
    if (s.source === 'google_books' && s.coverUrl) {
      if (isExactAnchor && !exactGbCover) exactGbCover = s.coverUrl;
      if (!gbCoverCandidate) gbCoverCandidate = s.coverUrl;
    }
    if (s.source === 'openlibrary' && s.coverUrl) {
      if (isExactAnchor && !exactOlCover) exactOlCover = s.coverUrl;
      if (!olCoverCandidate) olCoverCandidate = s.coverUrl;
    }
    if (s.source === 'inventaire' && s.coverUrl) {
      if (isExactAnchor && !exactInvCover) exactInvCover = s.coverUrl;
      if (!invCoverCandidate) invCoverCandidate = s.coverUrl;
    }
  }
  bnfCoverCandidate = exactBnfCover || bnfCoverCandidate;
  gbCoverCandidate = exactGbCover || gbCoverCandidate;
  invCoverCandidate = exactInvCover || invCoverCandidate;
  olCoverCandidate = exactOlCover || olCoverCandidate;
  if (!editionsCatalogMap.has(payload.anchorIsbn13)) {
    editionsCatalogMap.set(payload.anchorIsbn13, {
      isbn13: payload.anchorIsbn13,
      publisher: payload.publisher,
      publicationYear: payload.publishDate,
      coverUrl: bnfCoverCandidate || invCoverCandidate || userHint?.coverUrl
    });
  }

  const selectedCoverUrl =
    (await resolveBestCoverUrl(payload.anchorIsbn13, {
      bnfCoverUrl: bnfCoverCandidate,
      gbCoverUrl: gbCoverCandidate,
      olCoverUrl: olCoverCandidate,
      invCoverUrl: invCoverCandidate,
      title: canonicalTitle,
      author: payload.authors[0]
    })) ||
    bnfCoverCandidate ||
    invCoverCandidate ||
    gbCoverCandidate ||
    olCoverCandidate ||
    userHint?.coverUrl ||
    null;

  // 6. Clé canonique FRBR & Idempotence (anti-doublon à l'échelle de l'Œuvre)
  const normTitle = normalizeTextKey(canonicalTitle);
  const seriesCoreKey = electedSeries?.coreKey || '';
  let workCanonicalId = integralCheck.isIntegral
    ? `integral:${seriesCoreKey || normTitle}:${integralCheck.includedVolumeNumbers.join('-') || (integralCheck.integralOrdinal ? `int${integralCheck.integralOrdinal}` : payload.anchorIsbn13)}`
    : seriesId && volumeNumber !== null && !isHorsSerie
      ? `series:${seriesCoreKey}:vol:${volumeNumber}`
      : payload.wikidataWorkQid
        ? `wd:${payload.wikidataWorkQid}`
        : `work:${normTitle}:${normalizeTextKey(payload.authors[0] || payload.anchorIsbn13)}`;

  // Vérifier si ce Work existe déjà (par work_canonical_id, ou par series_id + volume_number)
  let existingBook = await db
    .prepare('SELECT * FROM books WHERE work_canonical_id = ? LIMIT 1')
    .bind(workCanonicalId)
    .first<Record<string, any>>();

  if (!existingBook && seriesId && volumeNumber !== null && !isHorsSerie && !integralCheck.isIntegral) {
    existingBook = await db
      .prepare('SELECT * FROM books WHERE series_id = ? AND volume_number = ? AND is_integral = 0 LIMIT 1')
      .bind(seriesId, volumeNumber)
      .first<Record<string, any>>();
  }

  // GARDE CRITIQUE ANTI-ÉCRASEMENT : si un livre existant dans la série porte déjà ce volume_number
  // mais avec un titre d'album DISTINCTIF incompatible (ex: "L'île noire" vs "L'étoile mystérieuse" sur Tintin #10),
  // ne JAMAIS écraser l'œuvre existante ni mélanger leurs ISBNs/couvertures !
  if (
    existingBook &&
    !integralCheck.isIntegral &&
    seriesId &&
    areDistinctSeriesWorkTitles(String(existingBook.canonical_title || ''), canonicalTitle, seriesName)
  ) {
    tracer?.record(
      'C4',
      'volume_collision_guard',
      'warn',
      `Collision de numéro évitée dans « ${seriesName} » #${volumeNumber} : « ${canonicalTitle} » ≠ « ${existingBook.canonical_title} »`,
      {
        seriesId,
        volumeNumber,
        existingBookId: existingBook.id,
        existingTitle: existingBook.canonical_title,
        incomingTitle: canonicalTitle,
        volumeSource: resolvedVolume.source
      }
    );
    workCanonicalId = payload.wikidataWorkQid
      ? `series:${seriesCoreKey}:wd:${payload.wikidataWorkQid}`
      : `series:${seriesCoreKey}:vol:${volumeNumber}:${normTitle.slice(0, 40)}`;
    existingBook = await db
      .prepare('SELECT * FROM books WHERE work_canonical_id = ? LIMIT 1')
      .bind(workCanonicalId)
      .first<Record<string, any>>();
  }

  let bookId = existingBook ? String(existingBook.id) : `bk_${generateTraceId('').replace(/^_/, '')}_${Math.random().toString(36).slice(2, 6)}`;
  let existingParentIntegrals: ParentIntegralRef[] = existingBook
    ? safeJsonParse<ParentIntegralRef[]>(existingBook.parent_integrals_json, [])
    : [];
  let integralMeta: IntegralMetadata = existingBook
    ? parseIntegralMetadataDb(existingBook.integral_metadata_json)
    : { includedVolumeNumbers: [], includedWorkIds: [], includedIsbns: [] };

  if (integralCheck.isIntegral) {
    integralMeta.includedVolumeNumbers = Array.from(
      new Set([...integralMeta.includedVolumeNumbers, ...integralCheck.includedVolumeNumbers])
    );
  }

  // Fusion des ISBNs connus et catalogue d'éditions
  if (existingBook) {
    for (const k of safeJsonParse<string[]>(existingBook.known_isbns_json, [])) knownIsbnsSet.add(k);
    for (const e of safeJsonParse<EditionCatalogEntry[]>(existingBook.editions_catalog_json, [])) {
      if (e.isbn13 && !editionsCatalogMap.has(e.isbn13)) editionsCatalogMap.set(e.isbn13, e);
    }
  }

  const finalKnownIsbns = Array.from(knownIsbnsSet);
  const finalEditionsCatalog = Array.from(editionsCatalogMap.values());
  const effectiveCover = selectedCoverUrl || existingBook?.selected_cover_url || null;

  // Synchronisation bidirectionnelle avec les Intégrales <-> Tomes unitaires
  if (integralCheck.isIntegral && seriesId) {
    const childQuery = await db
      .prepare('SELECT id, volume_number, canonical_title, known_isbns_json, parent_integrals_json FROM books WHERE series_id = ? AND is_integral = 0')
      .bind(seriesId)
      .all<Record<string, any>>();
    const intRef: ParentIntegralRef = {
      integralBookId: bookId,
      title: canonicalTitle,
      isbn13: payload.anchorIsbn13
    };
    for (const child of childQuery.results || []) {
      const childVolMatch =
        child.volume_number !== null && integralMeta.includedVolumeNumbers.includes(String(child.volume_number));
      const childDoubleMatch =
        integralCheck.isDoubleAlbum &&
        integralCheck.doubleSubTitles.some((st) => normalizeTextKey(st) === normalizeTextKey(String(child.canonical_title)));
      if (childVolMatch || childDoubleMatch) {
        integralMeta.includedWorkIds = Array.from(new Set([...integralMeta.includedWorkIds, String(child.id)]));
        for (const cIsbn of safeJsonParse<string[]>(child.known_isbns_json, [])) {
          integralMeta.includedIsbns = Array.from(new Set([...integralMeta.includedIsbns, cIsbn]));
        }
        if (child.volume_number !== null) {
          integralMeta.includedVolumeNumbers = Array.from(
            new Set([...integralMeta.includedVolumeNumbers, String(child.volume_number)])
          );
        }
        const childParents = safeJsonParse<ParentIntegralRef[]>(child.parent_integrals_json, []);
        if (!childParents.some((p) => p.integralBookId === bookId)) {
          childParents.push(intRef);
          await db
            .prepare('UPDATE books SET parent_integrals_json = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(childParents), now, child.id)
            .run();
        }
      }
    }
  } else if (!integralCheck.isIntegral && seriesId && volumeNumber !== null) {
    const intRows = await db
      .prepare('SELECT id, canonical_title, known_isbns_json, integral_metadata_json FROM books WHERE series_id = ? AND is_integral = 1')
      .bind(seriesId)
      .all<Record<string, any>>();
    for (const intRow of intRows.results || []) {
      const meta = parseIntegralMetadataDb(intRow.integral_metadata_json);
      if (meta.includedVolumeNumbers.includes(String(volumeNumber)) || meta.includedWorkIds.includes(bookId)) {
        const intIsbns = safeJsonParse<string[]>(intRow.known_isbns_json, []);
        if (!existingParentIntegrals.some((p) => p.integralBookId === intRow.id)) {
          existingParentIntegrals.push({
            integralBookId: String(intRow.id),
            title: String(intRow.canonical_title),
            isbn13: intIsbns[0] || ''
          });
        }
        meta.includedWorkIds = Array.from(new Set([...meta.includedWorkIds, bookId]));
        meta.includedIsbns = Array.from(new Set([...meta.includedIsbns, ...finalKnownIsbns]));
        await db
          .prepare('UPDATE books SET integral_metadata_json = ?, updated_at = ? WHERE id = ?')
          .bind(serializeIntegralMetadataDb(meta), now, intRow.id)
          .run();
      }
    }
  }

  // Pont rétro-compatible avec `catalog_entities` V2/V3 (SeriesView / BookDetailView / Notifications)
  const legacyEditionUri = existingBook?.legacy_entity_uri || `isbn:${payload.anchorIsbn13}`;
  let legacySeriesUri: string | undefined;
  const legacyAuthorUris: string[] = [];
  try {
    for (const aName of payload.authors) {
      legacyAuthorUris.push(
        await upsertCatalogEntity(db, {
          entityType: 'human',
          label: aName,
          claims: { 'wdt:P31': ['wd:Q5'] }
        })
      );
    }
    if (seriesName && seriesId) {
      legacySeriesUri = await upsertCatalogEntity(db, {
        uri: seriesId,
        entityType: 'serie',
        label: seriesName,
        mainCategory: classification.mainCategory,
        subgenres: classification.subgenres,
        authorUris: legacyAuthorUris,
        claims: {
          'wdt:P31': ['wd:Q277759'],
          ...(electedSeries?.ensembleIds.length ? { 'wdt:P268': electedSeries.ensembleIds } : {}),
          ...(payload.wikidataSeriesQid ? { 'invp:wikidataSeriesUri': [`wd:${payload.wikidataSeriesQid}`] } : {})
        }
      });
    }
    const legacyWorkSeriesNumber = integralCheck.isIntegral ? undefined : volumeLabel || undefined;
    const legacyWorkUri = await upsertCatalogEntity(db, {
      entityType: 'work',
      label: canonicalTitle,
      seriesUri: legacySeriesUri,
      seriesNumber: legacyWorkSeriesNumber,
      authorUris: legacyAuthorUris,
      mainCategory: classification.mainCategory,
      subgenres: classification.subgenres,
      imageUrl: effectiveCover || undefined,
      descriptions: payload.description ? { fr: payload.description } : {},
      claims: {
        'wdt:P31': ['wd:Q47461344'],
        ...(legacySeriesUri ? { 'wdt:P179': [legacySeriesUri] } : {}),
        ...(legacyWorkSeriesNumber ? { 'wdt:P1545': [legacyWorkSeriesNumber] } : {})
      }
    });
    await upsertCatalogEntity(db, {
      uri: legacyEditionUri,
      entityType: 'edition',
      label: canonicalTitle,
      isbn13: payload.anchorIsbn13,
      workUri: legacyWorkUri,
      seriesUri: legacySeriesUri,
      seriesNumber: volumeLabel || undefined,
      authorUris: legacyAuthorUris,
      mainCategory: classification.mainCategory,
      subgenres: classification.subgenres,
      imageUrl: effectiveCover || undefined,
      descriptions: payload.description ? { fr: payload.description } : {},
      claims: {
        'wdt:P629': [legacyWorkUri],
        'wdt:P212': [payload.anchorIsbn13],
        'wdt:P1476': [canonicalTitle],
        ...(payload.publishDate ? { 'wdt:P577': [payload.publishDate] } : {}),
        ...(payload.pageCount ? { 'wdt:P1104': [payload.pageCount] } : {})
      }
    });
  } catch {
    // Non-bloquant si tables V2 absentes dans certains tests isolés
  }

  // Upsert du livre consolidé dans `books`
  if (existingBook) {
    await db
      .prepare(
        `UPDATE books SET
          canonical_title = ?, normalized_title = ?, series_id = ?, series_name = ?,
          volume_number = ?, volume_label = ?, is_hors_serie = ?, hors_serie_label = ?,
          is_integral = ?, integral_metadata_json = ?, parent_integrals_json = ?,
          authors_json = ?, known_isbns_json = ?, editions_catalog_json = ?,
          selected_cover_url = ?, main_category = ?, subgenres_json = ?,
          legacy_entity_uri = COALESCE(legacy_entity_uri, ?), updated_at = ?
         WHERE id = ?`
      )
      .bind(
        canonicalTitle,
        normTitle,
        seriesId,
        seriesName,
        volumeNumber,
        volumeLabel,
        isHorsSerie ? 1 : 0,
        horsSerieLabel,
        integralCheck.isIntegral ? 1 : 0,
        serializeIntegralMetadataDb(integralMeta),
        JSON.stringify(existingParentIntegrals),
        JSON.stringify(payload.authors),
        JSON.stringify(finalKnownIsbns),
        JSON.stringify(finalEditionsCatalog),
        effectiveCover,
        classification.mainCategory,
        JSON.stringify(classification.subgenres),
        legacyEditionUri,
        now,
        bookId
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO books
          (id, work_canonical_id, canonical_title, normalized_title, series_id, series_name,
           volume_number, volume_label, is_hors_serie, hors_serie_label, is_integral,
           integral_metadata_json, parent_integrals_json, authors_json, language,
           known_isbns_json, editions_catalog_json, selected_cover_url, main_category,
           subgenres_json, legacy_entity_uri, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fr', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_canonical_id) DO UPDATE SET
           canonical_title = excluded.canonical_title,
           normalized_title = excluded.normalized_title,
           series_id = COALESCE(excluded.series_id, books.series_id),
           series_name = COALESCE(excluded.series_name, books.series_name),
           volume_number = COALESCE(excluded.volume_number, books.volume_number),
           volume_label = COALESCE(excluded.volume_label, books.volume_label),
           is_hors_serie = excluded.is_hors_serie,
           hors_serie_label = excluded.hors_serie_label,
           is_integral = excluded.is_integral,
           integral_metadata_json = excluded.integral_metadata_json,
           parent_integrals_json = excluded.parent_integrals_json,
           authors_json = excluded.authors_json,
           known_isbns_json = excluded.known_isbns_json,
           editions_catalog_json = excluded.editions_catalog_json,
           selected_cover_url = COALESCE(excluded.selected_cover_url, books.selected_cover_url),
           main_category = excluded.main_category,
           subgenres_json = excluded.subgenres_json,
           updated_at = excluded.updated_at`
      )
      .bind(
        bookId,
        workCanonicalId,
        canonicalTitle,
        normTitle,
        seriesId,
        seriesName,
        volumeNumber,
        volumeLabel,
        isHorsSerie ? 1 : 0,
        horsSerieLabel,
        integralCheck.isIntegral ? 1 : 0,
        serializeIntegralMetadataDb(integralMeta),
        JSON.stringify(existingParentIntegrals),
        JSON.stringify(payload.authors),
        JSON.stringify(finalKnownIsbns),
        JSON.stringify(finalEditionsCatalog),
        effectiveCover,
        classification.mainCategory,
        JSON.stringify(classification.subgenres),
        legacyEditionUri,
        now,
        now
      )
      .run();
    const confirmedBook = await db
      .prepare('SELECT id FROM books WHERE work_canonical_id = ? LIMIT 1')
      .bind(workCanonicalId)
      .first<{ id: string }>();
    if (confirmedBook?.id) bookId = String(confirmedBook.id);
  }

  // Indexation O(1) de TOUS les ISBN FR sœurs vers `book_id`
  const idxStmts = finalKnownIsbns.map((kIsbn) =>
    db
      .prepare(
        `INSERT INTO book_isbn_index (isbn13, book_id, is_integral, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(isbn13) DO UPDATE SET book_id = excluded.book_id, is_integral = excluded.is_integral`
      )
      .bind(kIsbn, bookId, integralCheck.isIntegral ? 1 : 0, now)
  );
  if (idxStmts.length > 0) await db.batch(idxStmts);

  // Si ce livre remplace un squelette C5 périmé ou changé de format, migrer les liaisons bibliothèque pour ne jamais perdre l'utilisateur
  // GARDE CRITIQUE V4-01 : ne jamais supprimer `replaceSkeletonBookId` s'il s'agit d'un autre tome déjà consolidé/possédé ayant un titre distinct !
  if (options.replaceSkeletonBookId && options.replaceSkeletonBookId !== bookId) {
    try {
      const oldBookRow = await db
        .prepare('SELECT id, canonical_title, known_isbns_json FROM books WHERE id = ? LIMIT 1')
        .bind(options.replaceSkeletonBookId)
        .first<{ id: string; canonical_title: string; known_isbns_json: string }>();
      const oldIsbns = safeJsonParse<string[]>(oldBookRow?.known_isbns_json, []);
      const isDistinctConsolidatedWork =
        oldBookRow &&
        areDistinctSeriesWorkTitles(oldBookRow.canonical_title, canonicalTitle, seriesName) &&
        oldIsbns.some((i) => i !== payload.anchorIsbn13);

      if (isDistinctConsolidatedWork) {
        // Ne détacher que l'ISBN courant sans détruire l'autre tome !
        const remainingIsbns = oldIsbns.filter((i) => !finalKnownIsbns.includes(i));
        await db
          .prepare('UPDATE books SET known_isbns_json = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(remainingIsbns), now, options.replaceSkeletonBookId)
          .run();
      } else {
        const oldLinks = await db
          .prepare('SELECT library_id, is_owned, is_wished, source_channel, added_at FROM v4_library_books WHERE book_id = ?')
          .bind(options.replaceSkeletonBookId)
          .all<{ library_id: string; is_owned: number; is_wished: number; source_channel: string | null; added_at: string }>();
        for (const oldLink of oldLinks.results || []) {
          await db
            .prepare(
              `INSERT INTO v4_library_books (library_id, book_id, is_owned, is_wished, source_channel, selected_cover_url, added_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(library_id, book_id) DO UPDATE SET
                 is_owned = MAX(v4_library_books.is_owned, excluded.is_owned),
                 is_wished = MAX(v4_library_books.is_wished, excluded.is_wished),
                 selected_cover_url = COALESCE(excluded.selected_cover_url, v4_library_books.selected_cover_url),
                 updated_at = excluded.updated_at`
            )
            .bind(
              oldLink.library_id,
              bookId,
              oldLink.is_owned,
              oldLink.is_wished,
              oldLink.source_channel || options.sourceChannel,
              effectiveCover,
              oldLink.added_at || now,
              now
            )
            .run();
        }
        await db.prepare('DELETE FROM v4_library_books WHERE book_id = ?').bind(options.replaceSkeletonBookId).run();
        await db.prepare('UPDATE book_isbn_index SET book_id = ?, is_integral = ? WHERE book_id = ?').bind(bookId, integralCheck.isIntegral ? 1 : 0, options.replaceSkeletonBookId).run();
        await db.prepare('DELETE FROM books WHERE id = ?').bind(options.replaceSkeletonBookId).run();
      }
    } catch {
      // Non-bloquant en environnement mock minimal
    }
  }
  try {
    await db
      .prepare("UPDATE enrichment_queue SET book_id = ?, status = 'done', last_error = NULL, updated_at = ? WHERE isbn13 = ?")
      .bind(bookId, now, payload.anchorIsbn13)
      .run();
  } catch {
    // Non-bloquant
  }

  // Mise à jour v4_library_books + library_items si libraryId + action != preview
  if (options.libraryId && options.action && options.action !== 'preview') {
    await linkBookToLibrary(db, {
      libraryId: options.libraryId,
      bookId,
      legacyEntityUri: legacyEditionUri,
      isOwned: options.action === 'owned',
      isWished: options.action === 'wishlist',
      sourceChannel: options.sourceChannel,
      coverUrl: effectiveCover
    });
  }

  const savedRow = await db.prepare('SELECT * FROM books WHERE id = ? LIMIT 1').bind(bookId).first<Record<string, any>>();
  const record = savedRow ? mapBookRow(savedRow) : mapBookRow({
    id: bookId,
    work_canonical_id: workCanonicalId,
    canonical_title: canonicalTitle,
    normalized_title: normTitle,
    series_id: seriesId,
    series_name: seriesName,
    volume_number: volumeNumber,
    volume_label: volumeLabel,
    is_hors_serie: isHorsSerie ? 1 : 0,
    hors_serie_label: horsSerieLabel,
    is_integral: integralCheck.isIntegral ? 1 : 0,
    integral_metadata_json: serializeIntegralMetadataDb(integralMeta),
    parent_integrals_json: JSON.stringify(existingParentIntegrals),
    authors_json: JSON.stringify(payload.authors),
    language: 'fr',
    known_isbns_json: JSON.stringify(finalKnownIsbns),
    editions_catalog_json: JSON.stringify(finalEditionsCatalog),
    selected_cover_url: effectiveCover,
    main_category: classification.mainCategory,
    subgenres_json: JSON.stringify(classification.subgenres),
    legacy_entity_uri: legacyEditionUri,
    updated_at: now
  });

  tracer?.record(
    'C4',
    'consolidation',
    'ok',
    `Consolidé « ${record.canonicalTitle} » (${record.seriesName || 'One-shot'} ${record.volumeLabel ? `#${record.volumeLabel}` : record.isHorsSerie ? 'HS' : ''}) — ${record.knownIsbns.length} ISBN(s) indexé(s)`,
    {
      bookId: record.id,
      workCanonicalId: record.workCanonicalId,
      seriesName: record.seriesName,
      volumeNumber: record.volumeNumber,
      isHorsSerie: record.isHorsSerie,
      isIntegral: record.isIntegral,
      knownIsbnsCount: record.knownIsbns.length,
      hasCover: Boolean(record.selectedCoverUrl)
    },
    Date.now() - start
  );

  return record;
}

export async function linkBookToLibrary(
  db: DatabaseBinding,
  params: {
    libraryId: string;
    bookId: string;
    legacyEntityUri?: string | null;
    isOwned: boolean;
    isWished: boolean;
    wishedByUserId?: string | null;
    sourceChannel?: string;
    coverUrl?: string | null;
    /** true uniquement lorsque l'utilisateur a explicitement choisi une couverture (création / Photo IA / édition). */
    preferNewCover?: boolean;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const effectiveWishedBy = params.isWished && !params.isOwned ? params.wishedByUserId || null : null;
  const coverConflictExpr = params.preferNewCover
    ? 'COALESCE(excluded.selected_cover_url, v4_library_books.selected_cover_url)'
    : 'COALESCE(v4_library_books.selected_cover_url, excluded.selected_cover_url)';
  await db
    .prepare(
      `INSERT INTO v4_library_books
        (library_id, book_id, is_owned, is_wished, wished_by_user_id, source_channel, selected_cover_url, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, book_id) DO UPDATE SET
         is_owned = MAX(v4_library_books.is_owned, excluded.is_owned),
         is_wished = CASE WHEN excluded.is_owned = 1 THEN 0 ELSE excluded.is_wished END,
         wished_by_user_id = CASE
           WHEN excluded.is_owned = 1 THEN NULL
           WHEN excluded.is_wished = 1 THEN COALESCE(excluded.wished_by_user_id, v4_library_books.wished_by_user_id)
           ELSE NULL
         END,
         selected_cover_url = ${coverConflictExpr},
         updated_at = excluded.updated_at`
    )
    .bind(
      params.libraryId,
      params.bookId,
      params.isOwned ? 1 : 0,
      params.isWished ? 1 : 0,
      effectiveWishedBy,
      params.sourceChannel || null,
      params.coverUrl || null,
      now,
      now
    )
    .run();

  if (params.legacyEntityUri && (params.isOwned || params.isWished)) {
    const legacyStatus = params.isOwned ? 'owned' : 'wishlist';
    try {
      const existingLegacy = await db
        .prepare(
          'SELECT id FROM library_items WHERE library_id = ? AND (edition_id = ? OR work_id = ?) AND deleted_at IS NULL LIMIT 1'
        )
        .bind(params.libraryId, params.legacyEntityUri, params.legacyEntityUri)
        .first<{ id: string }>();

      if (existingLegacy?.id) {
        await db
          .prepare('UPDATE library_items SET ownership_status = ?, added_by_user_id = COALESCE(?, added_by_user_id), updated_at = ? WHERE id = ?')
          .bind(legacyStatus, effectiveWishedBy, now, existingLegacy.id)
          .run();
      } else {
        const itemId = `itm_${params.libraryId}_${params.bookId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        await db
          .prepare(
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, added_by_user_id, acquired_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               ownership_status = excluded.ownership_status,
               added_by_user_id = COALESCE(excluded.added_by_user_id, library_items.added_by_user_id),
               deleted_at = NULL,
               updated_at = excluded.updated_at`
          )
          .bind(
            itemId,
            params.libraryId,
            params.legacyEntityUri,
            params.legacyEntityUri,
            legacyStatus,
            effectiveWishedBy,
            params.isOwned ? now : null,
            now,
            now
          )
          .run();
      }
    } catch {
      // Ignore si table V2 library_items absente dans test unitaire isolé
    }
  }
}

