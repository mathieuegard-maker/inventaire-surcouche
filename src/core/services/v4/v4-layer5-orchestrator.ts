// src/core/services/v4/v4-layer5-orchestrator.ts
// Couche 5 V4 : Expansion de série en squelettes + file enrichment_queue, workers CRON et orchestrateur d'ingestion.

import type { DatabaseBinding } from '../../adapters/storage-db.interface';
import {
  cleanTitle,
  isFrancophoneBookIsbn13,
  normalizeSeriesNumber,
  normalizeTextKey,
  parseSeriesFromTitle
} from '../../resolvers/bnf.resolver';
import {
  areDistinctSeriesWorkTitles,
  fetchCanonicalSeriesIndex,
  resolveCanonicalVolumeNumber
} from '../../resolvers/series-canonical.resolver';
import { matchesSeriesFallbackCandidate } from '../../bibliographic/work-identity';
import { isbnUtil } from '../../utils/isbn.util';
import { stripEditorialCollectionSuffixes } from '../../utils/series-matcher.util';
import { generateTraceId, PipelineTracer } from '../pipeline-logger.service';
import { checkBookIndexLayer2 } from './v4-layer2-index';
import { discoverMultiSourceLayer3, extractMarcRecordMetadata } from './v4-layer3-discovery';
import { consolidateBookLayer4, linkBookToLibrary } from './v4-layer4-consolidation';
import {
  extractAuthorLastNameForBnfCql,
  fetchWithTimeoutAndRetry,
  isStrictFrenchLanguage,
  normalizeIsbnWithPressFallback,
  safeJsonParse,
  type IngestBatchResult,
  type IngestSingleResult,
  type Layer2CheckResult,
  type SourceChannel,
  type StagingPayload,
  type UserIngestHint,
  type V4BookRecord
} from './v4-shared';

// ============================================================================
// COUCHE 5 : SQUELETTE RAPIDE DE SÉRIE (5A) + FILE `enrichment_queue` (5B)
// ============================================================================

export async function enqueueOrExpandSeriesLayer5(
  db: DatabaseBinding,
  book: V4BookRecord,
  tracer?: PipelineTracer,
  options?: { force?: boolean }
): Promise<number> {
  if (!book.seriesId || !book.seriesName) return 0;
  const start = Date.now();
  const now = new Date().toISOString();

  const sRow = await db
    .prepare('SELECT * FROM v4_series WHERE id = ? LIMIT 1')
    .bind(book.seriesId)
    .first<Record<string, any>>();
  if (!sRow) return 0;
  if (!options?.force && Number(sRow.is_complete_expanded) === 1) return 0;

  const rawEnsembleIds = safeJsonParse<string[]>(sRow.bnf_ensemble_ids_json, []);
  // Ne conserver que les notices bibliographiques d'ensemble 460$3 (commençant par 3 ou 4, et non les autorités P268 commençant par 1)
  const validEnsembleIds = new Set<string>(
    rawEnsembleIds
      .map((id) => String(id).replace(/\D/g, ''))
      .filter((id) => /^[34]\d{6,}$/.test(id))
  );
  const seriesWdIndex = sRow.wikidata_qid
    ? await fetchCanonicalSeriesIndex(String(sRow.wikidata_qid)).catch(() => null)
    : null;
  const targetCoreKey = String(sRow.normalized_core_key || stripEditorialCollectionSuffixes(book.seriesName).coreKey);
  const expectedAuthors = Array.from(
    new Set([...(book.authors || []), ...safeJsonParse<string[]>(sRow.primary_authors_json, [])].filter(Boolean))
  );
  const discoveredByWorkKey = new Map<
    string,
    {
      title: string;
      volumeNumber?: number;
      isbn13: string;
      coverUrl?: string;
      isIntegral?: boolean;
      authors?: string[];
      score: number;
    }
  >();

  const registerCandidateFromRecord = (rec: string, isFromEns2Bib: boolean) => {
    const cand = extractMarcRecordMetadata(rec);
    if (!cand || !cand.isbn13 || !isStrictFrenchLanguage(cand.language)) return;
    if (!isFrancophoneBookIsbn13(cand.isbn13)) return;
    if (cand.bnfEnsembleId && /^[34]\d{6,}$/.test(cand.bnfEnsembleId)) {
      const candCore = cand.seriesRaw ? stripEditorialCollectionSuffixes(cand.seriesRaw).coreKey : '';
      if (isFromEns2Bib || (candCore && (candCore === targetCoreKey || candCore.includes(targetCoreKey) || targetCoreKey.includes(candCore)))) {
        validEnsembleIds.add(cand.bnfEnsembleId);
      }
    }

    if (
      !isFromEns2Bib &&
      !matchesSeriesFallbackCandidate({
        candSeriesRaw: cand.seriesRaw,
        candTitle: cand.title,
        candAuthors: cand.authors,
        candVolumeNumber: cand.volumeNumber,
        candIsIntegral: cand._isIntegral,
        targetCoreKey,
        expectedAuthors
      })
    ) {
      return;
    }

    const isIntSkel = Boolean(cand._isIntegral);
    let cleanSkelTitle = cleanTitle(isIntSkel ? cand.title : parseSeriesFromTitle(cand.title).title || cand.title);
    if (cleanSkelTitle && book.seriesName && !isIntSkel) {
      const escapedSeries = book.seriesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = cleanSkelTitle.replace(new RegExp(`^${escapedSeries}\\s*[-:–]\\s*`, 'i'), '').trim();
      if (stripped.length >= 3) cleanSkelTitle = stripped;
    }

    const resolvedSkelVol = !isIntSkel
      ? resolveCanonicalVolumeNumber({
          canonicalSeriesIndex: seriesWdIndex,
          sisterEditions: [cand],
          rawTitles: [cleanSkelTitle, cand.title],
          seriesName: book.seriesName || undefined
        }).volumeNumber
      : '';
    const vNum =
      !isIntSkel && resolvedSkelVol && /^\d+$/.test(resolvedSkelVol)
        ? parseInt(resolvedSkelVol, 10)
        : undefined;

    let candScore = 0;
    if (cand.coverUrl) candScore += 25;
    if (cand.isbn13.startsWith('9782') || cand.isbn13.startsWith('97910')) candScore += 15;
    if (cand.publishDate && /^\d{4}$/.test(cand.publishDate)) {
      candScore += Math.min(35, Math.max(0, (parseInt(cand.publishDate, 10) - 1950) * 0.4));
    }

    const baseKey = isIntSkel
      ? `int:${normalizeTextKey(cleanSkelTitle)}`
      : vNum !== undefined
        ? `vol:${vNum}`
        : `title:${normalizeTextKey(cleanSkelTitle)}`;
    const existing = discoveredByWorkKey.get(baseKey);
    if (
      existing &&
      vNum !== undefined &&
      areDistinctSeriesWorkTitles(existing.title, cleanSkelTitle, book.seriesName)
    ) {
      const altKey = `${baseKey}:${normalizeTextKey(cleanSkelTitle).slice(0, 32)}`;
      const altExisting = discoveredByWorkKey.get(altKey);
      if (!altExisting || candScore > altExisting.score) {
        discoveredByWorkKey.set(altKey, {
          title: cleanSkelTitle,
          volumeNumber: vNum,
          isbn13: cand.isbn13,
          coverUrl: cand.coverUrl || altExisting?.coverUrl,
          isIntegral: isIntSkel,
          authors: cand.authors?.length ? cand.authors : altExisting?.authors,
          score: candScore
        });
      }
      return;
    }

    if (!existing || candScore > existing.score) {
      discoveredByWorkKey.set(baseKey, {
        title: cleanSkelTitle,
        volumeNumber: vNum,
        isbn13: cand.isbn13,
        coverUrl: cand.coverUrl || existing?.coverUrl,
        isIntegral: isIntSkel,
        authors: cand.authors?.length ? cand.authors : existing?.authors,
        score: candScore
      });
    } else if (!existing.coverUrl && cand.coverUrl) {
      existing.coverUrl = cand.coverUrl;
    }
  };

  // Phase 5A-1 : Requête BnF `bib.ens2bib` si un ensemble bibliographique 460$3 valide est connu
  if (validEnsembleIds.size > 0) {
    try {
      const ensQuery = Array.from(validEnsembleIds)
        .slice(0, 4)
        .map((id) => `bib.ens2bib any "${id}"`)
        .join(' or ');
      const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(`(${ensQuery}) and (bib.doctype all "a")`)}&recordSchema=intermarcxchange&maximumRecords=45&startRecord=1`;
      const res = await fetchWithTimeoutAndRetry(bnfUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
      if (res.ok) {
        const xml = await res.text();
        for (const rec of xml.split('<srw:record>').slice(1)) {
          registerCandidateFromRecord(rec, true);
        }
      }
    } catch {
      // Non-bloquant
    }
  }

  // Phase 5A-2 : Repli/complément automatique BnF SRU :
  // - si `ens2bib` a retourné < 3 tomes (Astérix sans 460$3), requête avec puis sans auteur ;
  // - ou si < 30 tomes ET auteur connu : passe ciblée `(Série + Auteur)` pour récupérer les tomes récents oubliés du 460$3
  //   (ex: Animal Jack T.11 « Nuit sans sommeil » catalogué en 295$a / 295$v sans 460$3).
  if (discoveredByWorkKey.size < 30) {
    const cleanSeriesQuery = book.seriesName.replace(/["()]/g, ' ').trim();
    const primaryAuthors = safeJsonParse<string[]>(sRow.primary_authors_json, []);
    const firstAuthorLast = extractAuthorLastNameForBnfCql(book.authors[0] || primaryAuthors[0]);
    const prevEnsCount = validEnsembleIds.size;

    const runSeriesFallbackCql = async (cql: string) => {
      try {
        const sruUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=45&startRecord=1`;
        const res = await fetchWithTimeoutAndRetry(sruUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
        if (!res.ok) return;
        const xml = await res.text();
        for (const rec of xml.split('<srw:record>').slice(1)) {
          registerCandidateFromRecord(rec, false);
        }
      } catch {
        // Non-bloquant
      }
    };

    if (cleanSeriesQuery.length >= 2) {
      if (firstAuthorLast) {
        await runSeriesFallbackCql(
          `(bib.anywhere all "${cleanSeriesQuery}") and (bib.author all "${firstAuthorLast}") and (bib.doctype all "a")`
        );
      }
      if (discoveredByWorkKey.size < 3) {
        await runSeriesFallbackCql(`(bib.anywhere all "${cleanSeriesQuery}") and (bib.doctype all "a")`);
      }
      // Si la passe de repli a permis de découvrir de vrais 460$3 (ensemble bibliographique), aspirer tous les tomes rattachés !
      if (validEnsembleIds.size > prevEnsCount && discoveredByWorkKey.size < 18) {
        try {
          const ensQuery = Array.from(validEnsembleIds)
            .slice(0, 4)
            .map((id) => `bib.ens2bib any "${id}"`)
            .join(' or ');
          const bnfUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(`(${ensQuery}) and (bib.doctype all "a")`)}&recordSchema=intermarcxchange&maximumRecords=50&startRecord=1`;
          const res = await fetchWithTimeoutAndRetry(bnfUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
          if (res.ok) {
            const xml = await res.text();
            for (const rec of xml.split('<srw:record>').slice(1)) {
              registerCandidateFromRecord(rec, true);
            }
          }
        } catch {
          // Non-bloquant
        }
      }
    }
  }

  const discoveredSkeleton = Array.from(discoveredByWorkKey.values());
  let queuedCount = 0;
  for (const skel of discoveredSkeleton) {
    if (!skel.isbn13) continue;
    const already = await db
      .prepare('SELECT book_id FROM book_isbn_index WHERE isbn13 = ? LIMIT 1')
      .bind(skel.isbn13)
      .first<{ book_id: string }>();
    if (already) continue;

    // Squelette léger immédiat dans books + book_isbn_index puis enrichissement complet mis en queue pour le CRON
    let skelCanonId = skel.isIntegral
      ? `integral:${sRow.normalized_core_key}:${skel.isbn13}`
      : skel.volumeNumber
        ? `series:${sRow.normalized_core_key}:vol:${skel.volumeNumber}`
        : `work:${normalizeTextKey(skel.title)}:${skel.isbn13}`;

    // Vérifier si un tome existe déjà sur cette clé canonique (ou ce numéro de tome dans la série)
    let existingWork = await db
      .prepare('SELECT id, canonical_title, known_isbns_json FROM books WHERE work_canonical_id = ? LIMIT 1')
      .bind(skelCanonId)
      .first<{ id: string; canonical_title: string; known_isbns_json: string }>();
    if (!existingWork && !skel.isIntegral && skel.volumeNumber) {
      existingWork = await db
        .prepare('SELECT id, canonical_title, known_isbns_json FROM books WHERE series_id = ? AND volume_number = ? AND is_integral = 0 LIMIT 1')
        .bind(book.seriesId, skel.volumeNumber)
        .first<{ id: string; canonical_title: string; known_isbns_json: string }>();
    }

    if (existingWork) {
      if (
        !skel.isIntegral &&
        areDistinctSeriesWorkTitles(existingWork.canonical_title, skel.title, book.seriesName)
      ) {
        // Deux albums distincts portant le même numéro dans des éditions différentes : créer une clé séparée sans écraser le tome existant
        skelCanonId = `series:${sRow.normalized_core_key}:vol:${skel.volumeNumber}:${normalizeTextKey(skel.title).slice(0, 40)}`;
        existingWork = await db
          .prepare('SELECT id, canonical_title, known_isbns_json FROM books WHERE work_canonical_id = ? LIMIT 1')
          .bind(skelCanonId)
          .first<{ id: string; canonical_title: string; known_isbns_json: string }>();
      }
    }

    if (existingWork?.id) {
      // Le tome existe déjà dans `books` : indexer cet ISBN supplémentaire sur l'œuvre existante SANS l'envoyer en replaceSkeletonBookId !
      const prevIsbns = safeJsonParse<string[]>(existingWork.known_isbns_json, []);
      if (!prevIsbns.includes(skel.isbn13)) {
        prevIsbns.push(skel.isbn13);
        await db
          .prepare('UPDATE books SET known_isbns_json = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(prevIsbns), now, existingWork.id)
          .run();
      }
      await db
        .prepare('INSERT OR IGNORE INTO book_isbn_index (isbn13, book_id, is_integral, created_at) VALUES (?, ?, ?, ?)')
        .bind(skel.isbn13, existingWork.id, skel.isIntegral ? 1 : 0, now)
        .run();
      continue;
    }

    const skelBookId = `bk_${generateTraceId('').replace(/^_/, '')}_${Math.random().toString(36).slice(2, 6)}`;
    const skelVolLabel = skel.isIntegral ? 'Intégrale' : skel.volumeNumber ? String(skel.volumeNumber) : null;

    await db
      .prepare(
        `INSERT OR IGNORE INTO books
          (id, work_canonical_id, canonical_title, normalized_title, series_id, series_name,
           volume_number, volume_label, is_hors_serie, is_integral, authors_json, language,
           known_isbns_json, editions_catalog_json, selected_cover_url, main_category, subgenres_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fr', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        skelBookId,
        skelCanonId,
        skel.title,
        normalizeTextKey(skel.title),
        book.seriesId,
        book.seriesName,
        skel.isIntegral ? null : skel.volumeNumber ?? null,
        skelVolLabel,
        skel.isIntegral || skel.volumeNumber ? 0 : 1,
        skel.isIntegral ? 1 : 0,
        JSON.stringify(skel.authors?.length ? skel.authors : book.authors),
        JSON.stringify([skel.isbn13]),
        JSON.stringify([{ isbn13: skel.isbn13, coverUrl: skel.coverUrl }]),
        skel.coverUrl || null,
        book.mainCategory,
        JSON.stringify(book.subgenres),
        now,
        now
      )
      .run();

    const insertedOrExisting = await db
      .prepare('SELECT id FROM books WHERE work_canonical_id = ? LIMIT 1')
      .bind(skelCanonId)
      .first<{ id: string }>();

    if (insertedOrExisting?.id) {
      await db
        .prepare('INSERT OR IGNORE INTO book_isbn_index (isbn13, book_id, is_integral, created_at) VALUES (?, ?, ?, ?)')
        .bind(skel.isbn13, insertedOrExisting.id, skel.isIntegral ? 1 : 0, now)
        .run();

      if (insertedOrExisting.id === skelBookId) {
        await db
          .prepare(
            `INSERT INTO enrichment_queue (book_id, isbn13, series_id, priority, status, attempts, created_at, updated_at)
             VALUES (?, ?, ?, 5, 'pending', 0, ?, ?)
             ON CONFLICT(isbn13) DO NOTHING`
          )
          .bind(insertedOrExisting.id, skel.isbn13, book.seriesId, now, now)
          .run();
        queuedCount++;
      }
    }
  }

  const totalCountRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM books WHERE series_id = ?')
    .bind(book.seriesId)
    .first<{ cnt: number }>();
  const finalSeriesCount = Number(totalCountRow?.cnt || 0);
  const markExpanded = discoveredSkeleton.length > 0 || finalSeriesCount > 1 ? 1 : 0;

  await db
    .prepare(
      `UPDATE v4_series
       SET is_complete_expanded = ?,
           bnf_ensemble_ids_json = ?,
           known_volumes_count = ?,
           series_checked_at = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      markExpanded,
      JSON.stringify(Array.from(validEnsembleIds)),
      finalSeriesCount,
      now,
      now,
      book.seriesId
    )
    .run();

  tracer?.record(
    'C5',
    'series_skeleton_and_queue',
    'ok',
    `Squelette série « ${book.seriesName} » : ${discoveredSkeleton.length} tome(s) détecté(s), ${queuedCount} mis en file enrichment_queue (total série: ${finalSeriesCount})`,
    { seriesId: book.seriesId, discovered: discoveredSkeleton.length, queuedCount, finalSeriesCount },
    Date.now() - start
  );
  return queuedCount;
}

/**
 * Phase 5B exécutée par `workers/release-cron` : dépile N éléments de `enrichment_queue`
 * en arrière-plan (Couche 3 + Couche 4 complète) sans saturer les sous-requêtes Cloudflare.
 */
export async function drainEnrichmentQueueBatch(
  db: DatabaseBinding,
  limit = 3
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const safeLimit = Math.min(8, Math.max(1, Math.trunc(limit)));
  const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await db
    .prepare(
      `UPDATE enrichment_queue
       SET status = CASE WHEN attempts >= 3 THEN 'error' ELSE 'pending' END,
           last_error = COALESCE(last_error, 'Timeout processing > 15m')
       WHERE status = 'processing' AND updated_at < ?`
    )
    .bind(staleCutoff)
    .run()
    .catch(() => {});

  const pending = await db
    .prepare(
      `SELECT id, book_id, isbn13, attempts
       FROM enrichment_queue
       WHERE status = 'pending' AND attempts < 3
       ORDER BY priority DESC, id ASC
       LIMIT ?`
    )
    .bind(safeLimit)
    .all<{ id: number; book_id: string | null; isbn13: string; attempts: number }>();

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const row of pending.results || []) {
    processed++;
    const now = new Date().toISOString();
    const tracer = new PipelineTracer({ sourceChannel: 'cron_enrichment' });
    await db
      .prepare("UPDATE enrichment_queue SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();

    try {
      const staging = await discoverMultiSourceLayer3(row.isbn13, tracer);
      if (!staging) {
        await db
          .prepare("UPDATE enrichment_queue SET status = CASE WHEN attempts >= 3 THEN 'error' ELSE 'pending' END, last_error = ?, updated_at = ? WHERE id = ?")
          .bind('Aucune donnée C3', new Date().toISOString(), row.id)
          .run();
        failed++;
      } else {
        await consolidateBookLayer4(db, staging, {
          sourceChannel: 'canal_1_barcode',
          action: 'preview',
          tracer,
          replaceSkeletonBookId: row.book_id || undefined
        });
        await db
          .prepare("UPDATE enrichment_queue SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
          .bind(new Date().toISOString(), row.id)
          .run();
        succeeded++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur C5';
      await db
        .prepare("UPDATE enrichment_queue SET status = CASE WHEN attempts >= 3 THEN 'error' ELSE 'pending' END, last_error = ?, updated_at = ? WHERE id = ?")
        .bind(msg.slice(0, 300), new Date().toISOString(), row.id)
        .run();
      tracer.record('CRON', 'enrichment_queue_item', 'error', msg, { isbn13: row.isbn13 });
      failed++;
    } finally {
      await tracer.flush(db);
    }
  }

  return { processed, succeeded, failed };
}

/**
 * Passe CRON silencieuse : redécouvre de nouveaux ISBN d'éditions sœurs FR ou intégrales
 * pour les livres existants dans `books` et les indexe dans `book_isbn_index` / `parent_integrals`
 * sans créer de bruit dans les notifications.
 */
export async function runSilentEditionDiscoveryPass(
  db: DatabaseBinding,
  limitOrOptions: number | { limit?: number; delayMs?: number; staleDays?: number } = 2
): Promise<{ checkedBooks: number; newIsbnsIndexed: number }> {
  const opts = typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 2)));
  const delayMs = Math.max(0, Math.trunc(opts.delayMs ?? 0));
  const staleCutoff =
    typeof opts.staleDays === 'number' && opts.staleDays > 0
      ? new Date(Date.now() - opts.staleDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const candidates = staleCutoff
    ? await db
        .prepare(
          `SELECT id, canonical_title, authors_json, known_isbns_json, series_id, volume_number, is_integral
           FROM books
           WHERE updated_at IS NULL OR updated_at < ?
           ORDER BY updated_at ASC
           LIMIT ?`
        )
        .bind(staleCutoff, safeLimit)
        .all<Record<string, any>>()
    : await db
        .prepare(
          `SELECT id, canonical_title, authors_json, known_isbns_json, series_id, volume_number, is_integral
           FROM books
           ORDER BY updated_at ASC
           LIMIT ?`
        )
        .bind(safeLimit)
        .all<Record<string, any>>();

  let checkedBooks = 0;
  let newIsbnsIndexed = 0;
  const now = new Date().toISOString();

  for (const row of candidates.results || []) {
    checkedBooks++;
    const title = String(row.canonical_title || '').replace(/["()]/g, ' ').trim();
    const authors = safeJsonParse<string[]>(row.authors_json, []);
    const firstAuthorLast = extractAuthorLastNameForBnfCql(authors[0]);
    if (title.length < 3) {
      await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
      continue;
    }

    try {
      const cql = firstAuthorLast
        ? `(bib.title all "${title}") and (bib.author all "${firstAuthorLast}") and (bib.doctype all "a")`
        : `(bib.title all "${title}") and (bib.doctype all "a")`;
      const sruUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=10&startRecord=1`;
      const res = await fetchWithTimeoutAndRetry(sruUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
      if (!res.ok) {
        await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
        continue;
      }
      const xml = await res.text();
      const existingIsbns = new Set(safeJsonParse<string[]>(row.known_isbns_json, []));
      const added: string[] = [];
      const rowIsIntegral = Number(row.is_integral) === 1;
      const rowVolStr = row.volume_number !== null && row.volume_number !== undefined ? String(row.volume_number) : '';

      for (const rec of xml.split('<srw:record>').slice(1)) {
        const cand = extractMarcRecordMetadata(rec);
        if (!cand?.isbn13 || !isStrictFrenchLanguage(cand.language)) continue;
        if (!isbnUtil.isValidBookBarcode(cand.isbn13) || !isFrancophoneBookIsbn13(cand.isbn13) || existingIsbns.has(cand.isbn13)) continue;
        if (Boolean(cand._isIntegral) !== rowIsIntegral) continue;
        const candVol = normalizeSeriesNumber(cand.volumeNumber || parseSeriesFromTitle(cand.title).seriesNumber || '');
        if (rowVolStr && candVol && candVol !== rowVolStr) continue;
        if (normalizeTextKey(cand.title) !== normalizeTextKey(row.canonical_title)) continue;
        existingIsbns.add(cand.isbn13);
        added.push(cand.isbn13);
      }

      if (added.length > 0) {
        await db
          .prepare('UPDATE books SET known_isbns_json = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(Array.from(existingIsbns)), now, row.id)
          .run();
        const stmts = added.map((isbn13) =>
          db
            .prepare(
              'INSERT OR IGNORE INTO book_isbn_index (isbn13, book_id, is_integral, created_at) VALUES (?, ?, ?, ?)'
            )
            .bind(isbn13, row.id, rowIsIntegral ? 1 : 0, now)
        );
        await db.batch(stmts);
        newIsbnsIndexed += added.length;
      } else if (!staleCutoff) {
        await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run();
      }
    } catch {
      if (!staleCutoff) {
        await db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').bind(now, row.id).run().catch(() => {});
      }
    }
    if (delayMs > 0 && checkedBooks < (candidates.results?.length || 0)) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { checkedBooks, newIsbnsIndexed };
}

// ============================================================================
// ORCHESTRATEUR D'INGESTION UNIFIÉ (COUCHES 2 -> 5 SUR CONTRAT PIVOT C1)
// ============================================================================

export async function runV4IngestionPipeline(
  db: DatabaseBinding,
  params: {
    isbns: string[];
    sourceChannel: SourceChannel;
    libraryId?: string | null;
    userId?: string | null;
    action?: 'owned' | 'wishlist' | 'preview';
    traceId?: string;
    hints?: Record<string, UserIngestHint>;
  }
): Promise<IngestBatchResult> {
  const tracer = new PipelineTracer({
    traceId: params.traceId,
    userId: params.userId,
    sourceChannel: params.sourceChannel
  });

  const cleanInputs = Array.from(new Set(params.isbns.map((s) => String(s || '').trim()).filter(Boolean)));
  tracer.record('C1', 'pivot_received', 'ok', `Réception ${cleanInputs.length} ISBN(s) depuis ${params.sourceChannel}`, {
    isbns: cleanInputs,
    action: params.action || 'preview'
  });

  const results: IngestSingleResult[] = [];
  let subrequestBudgetUsed = 0;

  for (const rawInput of cleanInputs) {
    const norm = normalizeIsbnWithPressFallback(rawInput);
    if (norm.isbn13Candidates.length === 0) {
      tracer.record('C1', 'isbn_validation', 'warn', `Format ISBN invalide ignoré : ${rawInput}`, { rawInput });
      results.push({
        inputIsbn: rawInput,
        normalizedIsbn13: null,
        layer2Status: 'FULL_MISS',
        book: null,
        ownedIntegralMatches: [],
        includedOwnedWorkIds: [],
        error: 'Format ISBN invalide'
      });
      continue;
    }

    // 1. Tester les candidats en Couche 2 (index O(1))
    let resolvedL2: Layer2CheckResult | null = null;
    let activeIsbn13 = norm.isbn13Candidates[0];
    let staleSkeletonBookId: string | undefined;
    const rawUserHint = params.hints?.[rawInput] || params.hints?.[activeIsbn13];
    for (const cand of norm.isbn13Candidates) {
      const candHint = params.hints?.[cand] || rawUserHint;
      const l2 = await checkBookIndexLayer2(db, cand, params.libraryId, tracer, { userHint: candHint });
      if (l2.staleSkeletonBookId) staleSkeletonBookId = l2.staleSkeletonBookId;
      if (l2.status !== 'FULL_MISS') {
        resolvedL2 = l2;
        activeIsbn13 = cand;
        break;
      }
    }

    if (resolvedL2 && resolvedL2.book) {
      const activeHint = params.hints?.[activeIsbn13] || rawUserHint;
      const userChosenCover = activeHint?.coverUrl?.trim() || null;
      // Lier à la bibliothèque si nouvel ajout demandé et pas déjà intégralement couvert/possédé
      if (
        params.libraryId &&
        params.action &&
        params.action !== 'preview' &&
        (resolvedL2.status === 'LOCAL_UNOWNED' ||
          resolvedL2.status === 'SERVER_CATALOG_HIT' ||
          (params.action === 'owned' && resolvedL2.status === 'PARTIAL_INTEGRAL_OWNED'))
      ) {
        await linkBookToLibrary(db, {
          libraryId: params.libraryId,
          bookId: resolvedL2.book.id,
          legacyEntityUri: resolvedL2.book.legacyEntityUri,
          isOwned: params.action === 'owned',
          isWished: params.action === 'wishlist',
          wishedByUserId: params.action === 'wishlist' ? params.userId || null : null,
          sourceChannel: params.sourceChannel,
          coverUrl: userChosenCover || resolvedL2.book.selectedCoverUrl,
          preferNewCover: Boolean(userChosenCover)
        });
        if (userChosenCover) {
          resolvedL2.book = { ...resolvedL2.book, selectedCoverUrl: userChosenCover };
        }
      }

      // Si la série du livre n'a pas encore été étendue en Couche 5, l'étendre même sur un HIT Couche 2 !
      if (resolvedL2.book.seriesId && subrequestBudgetUsed <= 2) {
        await enqueueOrExpandSeriesLayer5(db, resolvedL2.book, tracer).catch(() => 0);
      }

      results.push({
        inputIsbn: rawInput,
        normalizedIsbn13: activeIsbn13,
        pressEanExtrapolatedFrom: norm.isPressEan ? norm.cleanRaw : undefined,
        layer2Status: resolvedL2.status,
        book: resolvedL2.book,
        ownedIntegralMatches: resolvedL2.ownedIntegralMatches,
        includedOwnedWorkIds: resolvedL2.includedOwnedWorkIds
      });
      continue;
    }

    // 2. FULL_MISS -> Si lot important (>3 miss dans la même requête HTTP), empiler au-delà pour respecter la limite de sous-requêtes Workers
    if (subrequestBudgetUsed >= 3) {
      await db
        .prepare(
          `INSERT INTO enrichment_queue (book_id, isbn13, series_id, priority, status, attempts, created_at, updated_at)
           VALUES (NULL, ?, NULL, 10, 'pending', 0, ?, ?)
           ON CONFLICT(isbn13) DO UPDATE SET priority = 10, status = 'pending', updated_at = excluded.updated_at`
        )
        .bind(activeIsbn13, new Date().toISOString(), new Date().toISOString())
        .run();
      tracer.record('C5', 'deferred_ingest', 'warn', `Lot volumineux : ISBN ${activeIsbn13} mis en file prioritaire`, {
        isbn13: activeIsbn13
      });
      results.push({
        inputIsbn: rawInput,
        normalizedIsbn13: activeIsbn13,
        pressEanExtrapolatedFrom: norm.isPressEan ? norm.cleanRaw : undefined,
        layer2Status: 'FULL_MISS',
        book: null,
        ownedIntegralMatches: [],
        includedOwnedWorkIds: []
      });
      continue;
    }

    subrequestBudgetUsed++;
    let staging: StagingPayload | null = null;
    for (const cand of norm.isbn13Candidates) {
      staging = await discoverMultiSourceLayer3(cand, tracer);
      if (staging) {
        activeIsbn13 = cand;
        break;
      }
    }

    if (!staging) {
      results.push({
        inputIsbn: rawInput,
        normalizedIsbn13: activeIsbn13,
        pressEanExtrapolatedFrom: norm.isPressEan ? norm.cleanRaw : undefined,
        layer2Status: 'FULL_MISS',
        book: null,
        ownedIntegralMatches: [],
        includedOwnedWorkIds: [],
        error: 'Livre introuvable dans BnF, Inventaire.io, Wikidata, Google Books et OpenLibrary.'
      });
      continue;
    }

    // Consolider d'abord en mode preview pour que postCheck puisse détecter INCLUDED_IN_INTEGRAL / PARTIAL_INTEGRAL_OWNED avant liaison bibliothèque
    const activePostHint = params.hints?.[activeIsbn13] || rawUserHint;
    const userChosenPostCover = activePostHint?.coverUrl?.trim() || null;
    let consolidated = await consolidateBookLayer4(db, staging, {
      sourceChannel: params.sourceChannel,
      libraryId: params.libraryId,
      action: 'preview',
      tracer,
      userHint: activePostHint,
      replaceSkeletonBookId: staleSkeletonBookId
    });

    // Re-vérifier Couche 2 après consolidation pour remonter d'éventuelles détections bidirectionnelles (intégrale trouvée a posteriori)
    const postCheck = params.libraryId
      ? await checkBookIndexLayer2(db, activeIsbn13, params.libraryId)
      : null;

    if (
      params.libraryId &&
      params.action &&
      params.action !== 'preview' &&
      (!postCheck ||
        postCheck.status === 'LOCAL_UNOWNED' ||
        postCheck.status === 'SERVER_CATALOG_HIT' ||
        (params.action === 'owned' && postCheck.status === 'PARTIAL_INTEGRAL_OWNED'))
    ) {
      await linkBookToLibrary(db, {
        libraryId: params.libraryId,
        bookId: consolidated.id,
        legacyEntityUri: consolidated.legacyEntityUri,
        isOwned: params.action === 'owned',
        isWished: params.action === 'wishlist',
        wishedByUserId: params.action === 'wishlist' ? params.userId || null : null,
        sourceChannel: params.sourceChannel,
        coverUrl: userChosenPostCover || consolidated.selectedCoverUrl,
        preferNewCover: Boolean(userChosenPostCover)
      });
      if (userChosenPostCover) {
        consolidated = { ...consolidated, selectedCoverUrl: userChosenPostCover };
      }
    }

    // Couche 5 : Squelette rapide + file d'attente (strictement limité au 1er miss de la requête pour éviter la limite de 50 sous-requêtes Workers)
    let queuedCount = 0;
    if (subrequestBudgetUsed <= 1) {
      queuedCount = await enqueueOrExpandSeriesLayer5(db, consolidated, tracer);
    }

    results.push({
      inputIsbn: rawInput,
      normalizedIsbn13: activeIsbn13,
      pressEanExtrapolatedFrom: norm.isPressEan ? norm.cleanRaw : undefined,
      layer2Status:
        postCheck?.status === 'INCLUDED_IN_INTEGRAL' ||
        postCheck?.status === 'PARTIAL_INTEGRAL_OWNED' ||
        postCheck?.status === 'FULL_INTEGRAL_OWNED'
          ? postCheck.status
          : 'FULL_MISS',
      book: consolidated,
      ownedIntegralMatches: postCheck?.ownedIntegralMatches || [],
      includedOwnedWorkIds: postCheck?.includedOwnedWorkIds || [],
      seriesExpandedQueued: queuedCount
    });
  }

  await tracer.flush(db);

  return {
    traceId: tracer.traceId,
    sourceChannel: params.sourceChannel,
    results
  };
}

