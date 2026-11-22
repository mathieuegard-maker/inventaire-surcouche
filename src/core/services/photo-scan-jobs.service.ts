// src/core/services/photo-scan-jobs.service.ts
// Traitement Photo IA (Gemini Vision OCR + Canal 3 BnF) en tâche de fond côté serveur,
// strictement isolé par utilisateur/foyer, avec reprise automatique au redémarrage.

import type { AppBackendEnv, DatabaseBinding } from '../adapters/storage-db.interface';
import {
  buildVisionPrompt,
  computeMonthlyAiQuota,
  parseJsonArraySafe,
  PREFERRED_GEMINI_MODELS,
  VISION_OCR_RESPONSE_SCHEMA
} from '../utils/vision-prompt.util';
import { imageUtil } from '../utils/image.util';
import { isbnUtil } from '../utils/isbn.util';
import { isMetaIntegral } from '../bibliographic/work-identity';
import { normalizeTextKey } from '../resolvers/bnf.resolver';
import { resolveBookHintsCanal3 } from './canal3-resolver.service';
import { PipelineTracer } from './pipeline-logger.service';
import { checkBookIndexLayer2 } from './v4-pipeline.service';
import type { RecognizedBookCandidate } from './byok-vision.service';
import type {
  PhotoBatchResolutionResult,
  PhotoResolutionOption,
  ResolvedPhotoItem
} from './photo-book-resolution.service';

export type ServerPhotoJobStatus = 'pending' | 'ai_running' | 'resolving' | 'done' | 'error';

export interface ServerPhotoScanJob {
  id: string;
  userId: string;
  libraryId: string;
  mode: 'cover' | 'shelf';
  status: ServerPhotoJobStatus;
  imageDataUrl: string;
  candidatesCount: number;
  externalLookupsCount: number;
  result?: PhotoBatchResolutionResult;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

const activeJobIds = new Set<string>();

function mapRowToJob(row: Record<string, any>): ServerPhotoScanJob {
  let parsedResult: PhotoBatchResolutionResult | undefined;
  if (row.result_json) {
    try {
      parsedResult = JSON.parse(String(row.result_json)) as PhotoBatchResolutionResult;
    } catch {
      parsedResult = undefined;
    }
  }
  return {
    id: String(row.id),
    userId: String(row.user_id),
    libraryId: String(row.library_id),
    mode: row.mode === 'cover' ? 'cover' : 'shelf',
    status: (row.status as ServerPhotoJobStatus) || 'pending',
    imageDataUrl: String(row.image_data_url || ''),
    candidatesCount: Number(row.candidates_count || 0),
    externalLookupsCount: Number(row.progress_done || 0),
    result: parsedResult,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    createdAt: Date.parse(String(row.created_at || '')) || Date.now(),
    updatedAt: Date.parse(String(row.updated_at || '')) || Date.now()
  };
}

function extractBase64AndMime(dataUrl: string, fallbackMime = 'image/webp'): { base64: string; mimeType: string } {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (match) {
    return { mimeType: match[1], base64: match[2] };
  }
  return { mimeType: fallbackMime, base64: dataUrl.trim() };
}

async function runGeminiVisionOcrForJob(
  db: DatabaseBinding,
  env: AppBackendEnv,
  params: { userId: string; mode: 'cover' | 'shelf'; imageBase64: string; mimeType: string }
): Promise<RecognizedBookCandidate[]> {
  const geminiKey = (env.GEMINI_API_KEY || '').trim();
  if (!geminiKey) {
    throw new Error('Clé API Gemini non configurée sur le serveur.');
  }

  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const [usageRow, userCountRow] = await Promise.all([
    db
      .prepare('SELECT total_used, month_key, month_used FROM ai_vision_usage WHERE user_id = ? LIMIT 1')
      .bind(params.userId)
      .first<{ total_used: number; month_key: string; month_used: number }>(),
    db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>()
  ]);

  const monthlyQuota = computeMonthlyAiQuota(userCountRow?.cnt || 1);
  const totalUsed = usageRow?.total_used || 0;
  const monthUsed = usageRow?.month_key === currentMonthKey ? usageRow.month_used : 0;
  if (monthUsed >= monthlyQuota) {
    throw new Error(`Quota mensuel d'analyses IA atteint (${monthlyQuota} photos ce mois-ci).`);
  }

  const tracer = new PipelineTracer({
    userId: params.userId,
    sourceChannel: 'canal_4_ai_photo'
  });
  const start = Date.now();
  const prompt = buildVisionPrompt(params.mode);
  const candidateModels = PREFERRED_GEMINI_MODELS.slice(0, 6);
  let rawText: string | null = null;
  let usedModelId: string | null = null;
  let lastStatus = 0;
  let lastBody = '';
  const attempts: Array<{ model: string; round: number; status: number; durationMs: number; error?: string }> = [];

  for (let round = 1; round <= 2 && rawText === null; round++) {
    if (round > 1) {
      await new Promise((r) => setTimeout(r, 850));
    }
    for (const modelId of candidateModels) {
      const attStart = Date.now();
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), 18000);
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: abortCtrl.signal,
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    { inline_data: { mime_type: params.mimeType, data: params.imageBase64 } }
                  ]
                }
              ],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: VISION_OCR_RESPONSE_SCHEMA
              }
            })
          }
        );

        if (res.ok) {
          const json = (await res.json()) as any;
          rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
          usedModelId = modelId;
          attempts.push({ model: modelId, round, status: res.status, durationMs: Date.now() - attStart });
          break;
        }
        lastStatus = res.status;
        lastBody = await res.text().catch(() => '');
        attempts.push({
          model: modelId,
          round,
          status: lastStatus,
          durationMs: Date.now() - attStart,
          error: lastBody.slice(0, 220)
        });
        if (lastStatus !== 404 && lastStatus !== 429 && lastStatus < 500) {
          round = 99;
          break;
        }
      } catch (err: unknown) {
        lastStatus = 502;
        lastBody = err instanceof Error ? err.message : 'Erreur réseau';
        attempts.push({
          model: modelId,
          round,
          status: 502,
          durationMs: Date.now() - attStart,
          error: lastBody.slice(0, 220)
        });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  if (rawText === null) {
    tracer.record('C1', 'vision_ocr_job', 'error', `Échec OCR serveur (${lastStatus})`, { attempts }, Date.now() - start);
    await tracer.flush(db).catch(() => {});
    throw new Error(`Service IA temporairement indisponible (HTTP ${lastStatus || 503}).`);
  }

  const parsed = parseJsonArraySafe<Record<string, any>>(rawText);
  const candidates: RecognizedBookCandidate[] = parsed
    .map((c, idx) => {
      const cleanTitle = String(c.titleHint || c.title || c.rawText || '').trim();
      const rawIsbn = String(c.isbn || '').trim();
      const normalizedIsbn = rawIsbn && isbnUtil.isValidFormat(rawIsbn)
        ? (isbnUtil.normalize(rawIsbn).length === 10
            ? isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn))
            : isbnUtil.normalize(rawIsbn))
        : undefined;
      return {
        spineIndex: Number.isFinite(Number(c.spineIndex)) ? Number(c.spineIndex) : idx + 1,
        rawSpineText: String(c.rawText || c.titleHint || '').trim() || undefined,
        title: cleanTitle,
        volumeNumber: String(c.volumeNumber || '').trim() || undefined,
        author: String(c.authorHint || c.author || '').trim() || undefined,
        isbn: normalizedIsbn,
        confidence: 'medium' as const
      };
    })
    .filter((c) => Boolean(c.title || c.isbn || c.rawSpineText));

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ai_vision_usage (user_id, total_used, month_key, month_used, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         total_used = excluded.total_used,
         month_key = excluded.month_key,
         month_used = excluded.month_used,
         updated_at = excluded.updated_at`
    )
    .bind(params.userId, totalUsed + 1, currentMonthKey, monthUsed + 1, now)
    .run()
    .catch(() => {});

  tracer.record(
    'C1',
    'vision_ocr_job',
    'ok',
    `OCR serveur (${params.mode}, ${usedModelId || '?'}) : ${candidates.length} tranche(s)`,
    { modelUsed: usedModelId, candidatesCount: candidates.length, attempts },
    Date.now() - start
  );
  await tracer.flush(db).catch(() => {});

  return candidates;
}

export async function processPhotoScanJob(
  db: DatabaseBinding,
  env: AppBackendEnv,
  jobId: string
): Promise<void> {
  if (activeJobIds.has(jobId)) return;
  activeJobIds.add(jobId);

  try {
    const row = await db
      .prepare('SELECT * FROM photo_scan_jobs WHERE id = ? LIMIT 1')
      .bind(jobId)
      .first<Record<string, any>>();
    if (!row) return;

    const job = mapRowToJob(row);
    const { base64, mimeType } = extractBase64AndMime(job.imageDataUrl, String(row.mime_type || 'image/webp'));

    await db
      .prepare("UPDATE photo_scan_jobs SET status = 'ai_running', error_message = NULL, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), jobId)
      .run();

    const candidates = await runGeminiVisionOcrForJob(db, env, {
      userId: job.userId,
      mode: job.mode,
      imageBase64: base64,
      mimeType
    });

    await db
      .prepare(
        "UPDATE photo_scan_jobs SET status = 'resolving', candidates_count = ?, progress_done = 0, updated_at = ? WHERE id = ?"
      )
      .bind(candidates.length, new Date().toISOString(), jobId)
      .run();

    const detectedItems: ResolvedPhotoItem[] = [];
    const seriesNamesSet = new Map<string, string>();
    let doneCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const itemId = `${jobId}_item_${i + 1}`;
      try {
        const resolved = await resolveBookHintsCanal3(
          db,
          {
            title: cand.title || undefined,
            series: cand.series || undefined,
            volumeNumber: cand.volumeNumber || undefined,
            author: cand.author || undefined,
            publisher: cand.publisher || undefined,
            rawSpineText: cand.rawSpineText || undefined
          },
          {
            aiConfidence: cand.confidence,
            sourceChannel: 'canal_4_ai_photo',
            userId: job.userId,
            skipLocalD1: false
          }
        );

        const isbn13 = cand.isbn || resolved.isbn13;
        const meta = resolved.meta;
        const alternatives: PhotoResolutionOption[] = resolved.alternatives || [];

        if (isbn13 && meta) {
          const l2 = await checkBookIndexLayer2(db, isbn13, job.libraryId).catch(() => null);
          const alreadyOwned = Boolean(
            l2 &&
              (l2.status === 'ALREADY_OWNED' ||
                l2.status === 'INCLUDED_IN_INTEGRAL' ||
                l2.status === 'FULL_INTEGRAL_OWNED')
          );
          const itemIsIntegral = isMetaIntegral(meta);
          const seriesDisplay = meta.series || cand.series || undefined;
          if (seriesDisplay) {
            const sk = normalizeTextKey(seriesDisplay);
            if (sk && !seriesNamesSet.has(sk)) seriesNamesSet.set(sk, seriesDisplay);
          }

          detectedItems.push({
            id: itemId,
            sourceKind: 'detected',
            rawCandidate: cand,
            status: resolved.isDoubt ? 'doubt' : 'resolved',
            isbn13,
            title: meta.title || cand.title || 'Titre inconnu',
            authors: meta.authors?.length ? meta.authors : cand.author ? [cand.author] : [],
            coverUrl: meta.coverUrl || imageUtil.buildCoverCandidates(isbn13)[0],
            coverFallbackUrls: imageUtil.buildCoverCandidates(isbn13, [meta.coverUrl]),
            series: seriesDisplay,
            seriesNumber: itemIsIntegral ? undefined : meta.seriesNumber || cand.volumeNumber || undefined,
            isIntegral: itemIsIntegral,
            publisher: meta.publisher || cand.publisher,
            publishDate: meta.publishDate,
            alreadyOwned,
            alreadyWished: false,
            selected: !alreadyOwned && !resolved.isDoubt,
            sourcesCount: resolved.sourcesCount || 1,
            alternatives
          });
        } else {
          detectedItems.push({
            id: itemId,
            sourceKind: 'detected',
            rawCandidate: cand,
            status: 'unresolved',
            title: cand.title || cand.rawSpineText || 'Ouvrage non identifié',
            authors: cand.author ? [cand.author] : [],
            series: cand.series,
            seriesNumber: cand.volumeNumber,
            isIntegral: false,
            alreadyOwned: false,
            alreadyWished: false,
            selected: false,
            alternatives,
            failureReason: 'Aucune correspondance BnF / catalogue trouvée automatiquement.'
          });
        }
      } catch (itemErr: unknown) {
        detectedItems.push({
          id: itemId,
          sourceKind: 'detected',
          rawCandidate: cand,
          status: 'unresolved',
          title: cand.title || cand.rawSpineText || 'Ouvrage non identifié',
          authors: cand.author ? [cand.author] : [],
          series: cand.series,
          seriesNumber: cand.volumeNumber,
          isIntegral: false,
          alreadyOwned: false,
          alreadyWished: false,
          selected: false,
          alternatives: [],
          failureReason: itemErr instanceof Error ? itemErr.message : 'Erreur de résolution'
        });
      }

      doneCount++;
      await db
        .prepare('UPDATE photo_scan_jobs SET progress_done = ?, updated_at = ? WHERE id = ?')
        .bind(doneCount, new Date().toISOString(), jobId)
        .run()
        .catch(() => {});
    }

    const result: PhotoBatchResolutionResult = {
      detectedItems,
      seriesExtraItems: [],
      detectedSeriesNames: Array.from(seriesNamesSet.values())
    };

    await db
      .prepare(
        "UPDATE photo_scan_jobs SET status = 'done', candidates_count = ?, progress_done = ?, result_json = ?, error_message = NULL, updated_at = ? WHERE id = ?"
      )
      .bind(candidates.length, doneCount, JSON.stringify(result), new Date().toISOString(), jobId)
      .run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erreur lors du traitement de la photo.';
    await db
      .prepare("UPDATE photo_scan_jobs SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?")
      .bind(msg, new Date().toISOString(), jobId)
      .run()
      .catch(() => {});
  } finally {
    activeJobIds.delete(jobId);
  }
}

export async function createPhotoScanJob(
  db: DatabaseBinding,
  env: AppBackendEnv,
  params: {
    userId: string;
    libraryId: string;
    mode: 'cover' | 'shelf';
    imageDataUrl: string;
    mimeType?: string;
  }
): Promise<ServerPhotoScanJob> {
  const now = new Date().toISOString();
  const id = `pjob_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const { mimeType } = extractBase64AndMime(params.imageDataUrl, params.mimeType || 'image/webp');

  await db
    .prepare(
      `INSERT INTO photo_scan_jobs
        (id, user_id, library_id, mode, status, image_data_url, mime_type, candidates_count, progress_done, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, 0, ?, ?)`
    )
    .bind(id, params.userId, params.libraryId, params.mode, params.imageDataUrl, mimeType, now, now)
    .run();

  // Lancer immédiatement en tâche de fond côté serveur sans bloquer la réponse HTTP
  void processPhotoScanJob(db, env, id);

  return {
    id,
    userId: params.userId,
    libraryId: params.libraryId,
    mode: params.mode,
    status: 'pending',
    imageDataUrl: params.imageDataUrl,
    candidatesCount: 0,
    externalLookupsCount: 0,
    createdAt: Date.parse(now),
    updatedAt: Date.parse(now)
  };
}

export async function listUserPhotoScanJobs(
  db: DatabaseBinding,
  userId: string
): Promise<ServerPhotoScanJob[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM photo_scan_jobs
       WHERE user_id = ?
       ORDER BY created_at ASC
       LIMIT 30`
    )
    .bind(userId)
    .all<Record<string, any>>();
  return (rows.results || []).map(mapRowToJob);
}

export async function deleteUserPhotoScanJob(
  db: DatabaseBinding,
  userId: string,
  jobId: string
): Promise<void> {
  await db
    .prepare('DELETE FROM photo_scan_jobs WHERE id = ? AND user_id = ?')
    .bind(jobId, userId)
    .run();
}

export async function clearUserPhotoScanJobs(db: DatabaseBinding, userId: string): Promise<void> {
  await db.prepare('DELETE FROM photo_scan_jobs WHERE user_id = ?').bind(userId).run();
}

export async function retryUserFailedPhotoScanJobs(
  db: DatabaseBinding,
  env: AppBackendEnv,
  userId: string
): Promise<number> {
  const failedRows = await db
    .prepare("SELECT id FROM photo_scan_jobs WHERE user_id = ? AND status = 'error'")
    .bind(userId)
    .all<{ id: string }>();
  const ids = (failedRows.results || []).map((r) => String(r.id));
  for (const id of ids) {
    await db
      .prepare("UPDATE photo_scan_jobs SET status = 'pending', error_message = NULL, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
    void processPhotoScanJob(db, env, id);
  }
  return ids.length;
}

export async function resumePendingPhotoScanJobs(
  db: DatabaseBinding,
  env: AppBackendEnv
): Promise<number> {
  const rows = await db
    .prepare("SELECT id FROM photo_scan_jobs WHERE status IN ('pending', 'ai_running', 'resolving') ORDER BY created_at ASC LIMIT 20")
    .all<{ id: string }>()
    .catch(() => ({ results: [] as Array<{ id: string }> }));

  const ids = (rows.results || []).map((r) => String(r.id));
  for (const id of ids) {
    void processPhotoScanJob(db, env, id);
  }
  return ids.length;
}
