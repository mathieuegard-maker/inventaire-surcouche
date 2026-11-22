// src/core/services/gateway/admin-actions.ts
// Domaine métier : Administration, supervision du catalogue, quotas IA et observabilité des logs.

import type { DatabaseBinding } from '../../adapters/storage-db.interface';
import { cleanSeriesName, normalizeTextKey } from '../../resolvers/bnf.resolver';
import { stripEditorialCollectionSuffixes } from '../../utils/series-matcher.util';
import { computeMonthlyAiQuota } from '../../utils/vision-prompt.util';
import { rehydrateAllCatalogEntitiesInD1 } from '../d1-gateway.service';
import { purgeOldPipelineLogs, queryPipelineLogs } from '../pipeline-logger.service';
import { runCentralizedSeriesReleaseSweep } from '../series-digest.service';
import { jsonResp, maskEmail, requireAdmin, type GatewayActionContext } from './gateway-context';

export interface AdminCatalogPatchInput {
  label?: string;
  image_url?: string | null;
  main_category?: string | null;
  subgenres?: string[];
  series_number?: string | null;
  series_name?: string | null;
  authors?: string[];
  publisher?: string | null;
  publication_date?: string | null;
}

async function resolveOrCreateV4SeriesForAdmin(
  db: DatabaseBinding,
  rawSeriesName: string,
  authors: string[],
  now: string
): Promise<{ id: string; canonicalName: string } | null> {
  const clean = rawSeriesName.trim();
  if (!clean) return null;
  const { coreKey, cleanDisplay } = stripEditorialCollectionSuffixes(cleanSeriesName(clean));
  const targetName = cleanDisplay || clean;
  const normKey = coreKey || normalizeTextKey(targetName);
  const existing = await db
    .prepare('SELECT id, canonical_name FROM v4_series WHERE normalized_core_key = ? OR LOWER(canonical_name) = ? LIMIT 1')
    .bind(normKey, targetName.toLowerCase())
    .first<{ id: string; canonical_name: string }>()
    .catch(() => null);
  if (existing?.id) {
    return { id: String(existing.id), canonicalName: String(existing.canonical_name) };
  }
  const newId = `ser_${normKey.replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 7)}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO v4_series
        (id, canonical_name, normalized_core_key, aliases_json, primary_authors_json, bnf_ensemble_ids_json, is_complete_expanded, known_volumes_count, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, '[]', 0, 1, ?, ?)`
    )
    .bind(newId, targetName, normKey, JSON.stringify(authors), now, now)
    .run()
    .catch(() => {});
  return { id: newId, canonicalName: targetName };
}

/**
 * Applique un patch partiel d'administration sur une fiche maître (`catalog_entities` + `books` V4).
 * Seuls les champs explicitement présents (différents de `undefined`) dans `patch` sont modifiés.
 */
async function applyAdminCatalogPatch(
  db: DatabaseBinding,
  targetUri: string,
  patch: AdminCatalogPatchInput,
  now: string
): Promise<{ updated: boolean; updatedV4: boolean }> {
  const existingCe = await db
    .prepare('SELECT label, image_url, main_category, series_uri, series_number, entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
    .bind(targetUri)
    .first<{
      label: string;
      image_url: string | null;
      main_category: string | null;
      series_uri: string | null;
      series_number: string | null;
      entity_json: string | null;
    }>();

  let parsedEntity: Record<string, any> = {};
  if (existingCe?.entity_json) {
    try {
      parsedEntity = JSON.parse(existingCe.entity_json);
    } catch {
      parsedEntity = {};
    }
  }

  const nextLabel = patch.label !== undefined && patch.label.trim() ? patch.label.trim() : existingCe?.label;
  const nextImageUrl = patch.image_url !== undefined ? (patch.image_url?.trim() || null) : existingCe?.image_url ?? null;
  const nextMainCategory = patch.main_category !== undefined ? (patch.main_category?.trim() || null) : existingCe?.main_category ?? null;
  const nextSeriesNumber = patch.series_number !== undefined ? (patch.series_number?.trim() || null) : existingCe?.series_number ?? null;

  let resolvedSeries: { id: string; canonicalName: string } | null = null;
  if (patch.series_name !== undefined && patch.series_name?.trim()) {
    resolvedSeries = await resolveOrCreateV4SeriesForAdmin(
      db,
      patch.series_name,
      patch.authors || (Array.isArray(parsedEntity.authors) ? parsedEntity.authors : []),
      now
    );
  }
  const nextSeriesUri =
    patch.series_name !== undefined
      ? resolvedSeries?.id ?? null
      : existingCe?.series_uri ?? null;

  if (nextLabel) parsedEntity.label = nextLabel;
  if (patch.publisher !== undefined) parsedEntity.publisher = patch.publisher?.trim() || null;
  if (patch.publication_date !== undefined) parsedEntity.publishDate = patch.publication_date?.trim() || null;
  if (patch.authors !== undefined) parsedEntity.authors = patch.authors;
  if (patch.subgenres !== undefined) parsedEntity.genres = patch.subgenres;
  if (patch.series_name !== undefined) {
    parsedEntity.series = resolvedSeries?.canonicalName ?? null;
  }

  if (existingCe) {
    await db
      .prepare(
        `UPDATE catalog_entities
         SET label = ?,
             image_url = ?,
             main_category = ?,
             series_uri = ?,
             series_number = ?,
             entity_json = ?,
             updated_at = ?
         WHERE uri = ?`
      )
      .bind(
        nextLabel || existingCe.label,
        nextImageUrl,
        nextMainCategory,
        nextSeriesUri,
        nextSeriesNumber,
        JSON.stringify(parsedEntity),
        now,
        targetUri
      )
      .run();
  }

  // Synchroniser également la table maître V4 `books` (colonnes réelles du schéma V4 + `editions_catalog_json`)
  const rawIsbn = targetUri.startsWith('isbn:') ? targetUri.slice(5).replace(/[^0-9X]/gi, '') : '';
  const v4Row = await db
    .prepare(
      rawIsbn
        ? `SELECT b.id, b.canonical_title, b.selected_cover_url, b.main_category, b.subgenres_json,
                  b.series_id, b.series_name, b.volume_label, b.volume_number, b.authors_json, b.editions_catalog_json
           FROM books b
           WHERE b.legacy_entity_uri = ?
              OR EXISTS (SELECT 1 FROM book_isbn_index bi WHERE bi.book_id = b.id AND bi.isbn13 = ?)
           LIMIT 1`
        : `SELECT id, canonical_title, selected_cover_url, main_category, subgenres_json,
                  series_id, series_name, volume_label, volume_number, authors_json, editions_catalog_json
           FROM books WHERE legacy_entity_uri = ? OR id = ? LIMIT 1`
    )
    .bind(targetUri, rawIsbn || targetUri.replace(/^(?:v4:|book:)/, ''))
    .first<{
      id: string;
      canonical_title: string;
      selected_cover_url: string | null;
      main_category: string;
      subgenres_json: string | null;
      series_id: string | null;
      series_name: string | null;
      volume_label: string | null;
      volume_number: number | null;
      authors_json: string | null;
      editions_catalog_json: string | null;
    }>()
    .catch(() => null);

  if (v4Row?.id) {
    const v4Title = patch.label !== undefined && patch.label.trim() ? patch.label.trim() : v4Row.canonical_title;
    const v4Cover = patch.image_url !== undefined ? (patch.image_url?.trim() || null) : v4Row.selected_cover_url;
    const v4MainCat = patch.main_category !== undefined ? (patch.main_category?.trim() || 'Autre') : v4Row.main_category;
    const v4SubgenresJson =
      patch.subgenres !== undefined ? JSON.stringify(patch.subgenres) : (v4Row.subgenres_json || '[]');
    const v4AuthorsJson =
      patch.authors !== undefined ? JSON.stringify(patch.authors) : (v4Row.authors_json || '[]');
    const v4SeriesId =
      patch.series_name !== undefined ? (resolvedSeries?.id ?? null) : v4Row.series_id;
    const v4SeriesName =
      patch.series_name !== undefined ? (resolvedSeries?.canonicalName ?? null) : v4Row.series_name;

    let v4VolLabel = v4Row.volume_label;
    let v4VolNum = v4Row.volume_number;
    if (patch.series_number !== undefined) {
      const cleanNum = patch.series_number?.trim() || null;
      v4VolLabel = cleanNum;
      v4VolNum = cleanNum && /^\d+$/.test(cleanNum) ? parseInt(cleanNum, 10) : null;
    }

    // Mettre à jour `publisher` et `publicationYear` dans `editions_catalog_json`
    let editionsCatalog: Array<Record<string, any>> = [];
    if (v4Row.editions_catalog_json) {
      try {
        const parsed = JSON.parse(v4Row.editions_catalog_json);
        if (Array.isArray(parsed)) editionsCatalog = parsed;
      } catch {
        editionsCatalog = [];
      }
    }
    if (patch.publisher !== undefined || patch.publication_date !== undefined) {
      const cleanPub = patch.publisher !== undefined ? (patch.publisher?.trim() || undefined) : undefined;
      const cleanYear = patch.publication_date !== undefined ? (patch.publication_date?.trim() || undefined) : undefined;
      if (editionsCatalog.length === 0) {
        editionsCatalog.push({
          isbn13: rawIsbn || targetUri,
          ...(cleanPub !== undefined ? { publisher: cleanPub } : {}),
          ...(cleanYear !== undefined ? { publicationYear: cleanYear } : {})
        });
      } else {
        editionsCatalog = editionsCatalog.map((ed) => ({
          ...ed,
          ...(patch.publisher !== undefined ? { publisher: cleanPub } : {}),
          ...(patch.publication_date !== undefined ? { publicationYear: cleanYear } : {})
        }));
      }
    }

    await db
      .prepare(
        `UPDATE books
         SET canonical_title = ?,
             selected_cover_url = ?,
             main_category = ?,
             subgenres_json = ?,
             series_id = ?,
             series_name = ?,
             volume_label = ?,
             volume_number = ?,
             authors_json = ?,
             editions_catalog_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(
        v4Title,
        v4Cover,
        v4MainCat,
        v4SubgenresJson,
        v4SeriesId,
        v4SeriesName,
        v4VolLabel,
        v4VolNum,
        v4AuthorsJson,
        JSON.stringify(editionsCatalog),
        now,
        v4Row.id
      )
      .run();
  }

  return { updated: Boolean(existingCe || v4Row?.id), updatedV4: Boolean(v4Row?.id) };
}

export async function handleAdminGatewayAction(
  ctx: GatewayActionContext
): Promise<Response | null> {
  const { action, db, request, url, body, now } = ctx;

  switch (action) {
    case 'admin-overview': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const currentMonthKey = now.slice(0, 7);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [
        usersAgg,
        recentUsersRow,
        libsRow,
        notifRows,
        catalogTypeRows,
        coversAgg,
        aiAgg,
        seriesAgg,
        alertsAgg
      ] = await Promise.all([
        db.prepare('SELECT COUNT(*) as total FROM users').first<{ total: number }>(),
        db
          .prepare('SELECT COUNT(*) as cnt FROM users WHERE created_at >= ?')
          .bind(sevenDaysAgo)
          .first<{ cnt: number }>(),
        db.prepare('SELECT COUNT(*) as total FROM libraries').first<{ total: number }>(),
        db
          .prepare(
            `SELECT digest_frequency, digest_channel, COUNT(*) as cnt
             FROM user_notification_prefs
             GROUP BY digest_frequency, digest_channel`
          )
          .all<{ digest_frequency: string; digest_channel: string; cnt: number }>(),
        db
          .prepare(
            `SELECT entity_type, COUNT(*) as cnt
             FROM catalog_entities
             GROUP BY entity_type`
          )
          .all<{ entity_type: string; cnt: number }>(),
        db
          .prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(byte_size), 0) as bytes FROM catalog_covers')
          .first<{ cnt: number; bytes: number }>(),
        db
          .prepare(
            `SELECT COALESCE(SUM(total_used), 0) as totalAll,
                    COALESCE(SUM(CASE WHEN month_key = ? THEN month_used ELSE 0 END), 0) as totalMonth
             FROM user_ai_usage`
          )
          .bind(currentMonthKey)
          .first<{ totalAll: number; totalMonth: number }>(),
        db
          .prepare(
            `SELECT COUNT(*) as totalSeries,
                    SUM(CASE WHEN series_checked_at IS NOT NULL THEN 1 ELSE 0 END) as checkedSeries
             FROM catalog_entities WHERE entity_type = 'serie'`
          )
          .first<{ totalSeries: number; checkedSeries: number }>(),
        db
          .prepare('SELECT COUNT(*) as cnt FROM series_release_alerts WHERE dismissed = 0')
          .first<{ cnt: number }>()
      ]);

      const totalUsers = usersAgg?.total || 0;
      const catalogByType: Record<string, number> = {};
      for (const r of catalogTypeRows.results || []) {
        catalogByType[r.entity_type || 'unknown'] = r.cnt || 0;
      }

      let activeNotifUsers = 0;
      for (const n of notifRows.results || []) {
        if (n.digest_frequency && n.digest_frequency !== 'off') {
          activeNotifUsers += n.cnt || 0;
        }
      }

      return jsonResp({
        users: {
          total: totalUsers,
          recent7d: recentUsersRow?.cnt || 0,
          totalLibraries: libsRow?.total || 0,
          activeNotifUsers
        },
        catalog: {
          editions: catalogByType.edition || 0,
          works: catalogByType.work || 0,
          series: catalogByType.serie || 0,
          authors: catalogByType.human || 0,
          coversCount: coversAgg?.cnt || 0,
          coversBytes: coversAgg?.bytes || 0
        },
        ai: {
          monthKey: currentMonthKey,
          monthUsed: aiAgg?.totalMonth || 0,
          allTimeUsed: aiAgg?.totalAll || 0,
          monthlyQuotaPerUser: computeMonthlyAiQuota(totalUsers)
        },
        releases: {
          totalSeries: seriesAgg?.totalSeries || 0,
          checkedSeries: seriesAgg?.checkedSeries || 0,
          activeAlerts: alertsAgg?.cnt || 0
        }
      });
    }

    case 'admin-catalog-list': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }

      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const entityType = (url.searchParams.get('type') || 'edition').trim();
      const filterMode = (url.searchParams.get('filter') || 'all').trim();
      const page = Math.max(1, Math.trunc(Number(url.searchParams.get('page') || 1)));
      const pageSize = Math.min(60, Math.max(10, Math.trunc(Number(url.searchParams.get('pageSize') || 24))));
      const offset = (page - 1) * pageSize;

      const conditions: string[] = [];
      const bindings: unknown[] = [];

      if (entityType !== 'all') {
        conditions.push('entity_type = ?');
        bindings.push(entityType);
      }
      if (q) {
        conditions.push('(LOWER(label) LIKE ? OR LOWER(uri) LIKE ?)');
        bindings.push(`%${q}%`, `%${q}%`);
      }
      if (filterMode === 'no_cover') {
        conditions.push("(image_url IS NULL OR image_url = '')");
      } else if (filterMode === 'no_series') {
        conditions.push("(series_uri IS NULL OR series_uri = '')");
      }

      const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRow = await db
        .prepare(`SELECT COUNT(*) as total FROM catalog_entities ${whereSql}`)
        .bind(...bindings)
        .first<{ total: number }>();

      const rows = await db
        .prepare(
          `SELECT uri, entity_type, label, image_url, main_category, series_uri, series_number, entity_json, updated_at
           FROM catalog_entities
           ${whereSql}
           ORDER BY updated_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(...bindings, pageSize, offset)
        .all<{
          uri: string;
          entity_type: string;
          label: string;
          image_url: string | null;
          main_category: string | null;
          series_uri: string | null;
          series_number: string | null;
          entity_json: string | null;
          updated_at: string;
        }>();

      const items = (rows.results || []).map((row) => {
        let publisher: string | null = null;
        let publication_date: string | null = null;
        let series_name: string | null = null;
        let authors: string[] = [];
        if (row.entity_json) {
          try {
            const parsed = JSON.parse(row.entity_json) as {
              claims?: Record<string, unknown[]>;
              publisher?: string;
              publishDate?: string;
              series?: string;
              authors?: string[];
            };
            publisher = parsed.publisher || null;
            const rawDate = parsed.publishDate || parsed.claims?.['wdt:P577']?.[0];
            if (typeof rawDate === 'string') publication_date = rawDate;
            if (typeof parsed.series === 'string' && parsed.series.trim()) series_name = parsed.series.trim();
            if (Array.isArray(parsed.authors)) {
              authors = parsed.authors.map((a) => String(a || '').trim()).filter(Boolean);
            }
          } catch {
            // Ignorer un JSON malformé
          }
        }
        return {
          uri: row.uri,
          entity_type: row.entity_type,
          label: row.label,
          image_url: row.image_url,
          main_category: row.main_category,
          series_uri: row.series_uri,
          series_name,
          series_number: row.series_number,
          authors,
          publisher,
          publication_date,
          updated_at: row.updated_at
        };
      });

      return jsonResp({
        items,
        total: countRow?.total || 0,
        page,
        pageSize
      });
    }

    case 'admin-users-list': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const currentMonthKey = now.slice(0, 7);
      const rows = await db
        .prepare(
          `SELECT u.id, u.display_name, u.recovery_email, u.is_admin, u.created_at,
                  COALESCE(CASE WHEN ai.month_key = ? THEN ai.month_used ELSE 0 END, 0) as ai_month_used,
                  COALESCE(np.digest_frequency, 'off') as digest_frequency,
                  COALESCE(np.digest_channel, 'push') as digest_channel
           FROM users u
           LEFT JOIN user_ai_usage ai ON ai.user_id = u.id
           LEFT JOIN user_notification_prefs np ON np.user_id = u.id
           ORDER BY u.created_at DESC`
        )
        .bind(currentMonthKey)
        .all<{
          id: string;
          display_name: string;
          recovery_email: string | null;
          is_admin: number;
          created_at: string;
          ai_month_used: number;
          digest_frequency: string;
          digest_channel: string;
        }>();

      return jsonResp({
        users: (rows.results || []).map((r) => ({
          id: r.id,
          displayName: r.display_name,
          hasRecoveryEmail: Boolean(r.recovery_email),
          maskedEmail: r.recovery_email ? maskEmail(r.recovery_email) : null,
          isAdmin: r.is_admin === 1,
          createdAt: r.created_at,
          aiMonthUsed: r.ai_month_used,
          digestFrequency: r.digest_frequency,
          digestChannel: r.digest_channel
        }))
      });
    }

    case 'admin-reset-user-ai-quota': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const targetUserId = String(body?.targetUserId || '').trim();
      if (!targetUserId) {
        return jsonResp({ error: 'targetUserId requis.' }, 400);
      }
      const currentMonthKey = now.slice(0, 7);
      await db
        .prepare(`UPDATE user_ai_usage SET month_used = 0, month_key = ?, updated_at = ? WHERE user_id = ?`)
        .bind(currentMonthKey, now, targetUserId)
        .run();
      return jsonResp({ ok: true });
    }

    case 'admin-rehydrate-catalog': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const offset = Math.max(0, Number(body?.offset ?? 0));
      const limit = Math.min(25, Math.max(1, Number(body?.limit ?? 20)));
      const res = await rehydrateAllCatalogEntitiesInD1(db, { offset, limit });
      return jsonResp({ ok: true, ...res });
    }

    case 'admin-run-release-sweep': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const res = await runCentralizedSeriesReleaseSweep(db, { limit: 6, staleDays: 3 });
      return jsonResp({ ok: true, ...res });
    }

    case 'admin-pipeline-logs': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const status = (url.searchParams.get('status') || 'all').trim();
      const layer = (url.searchParams.get('layer') || 'all').trim();
      const q = (url.searchParams.get('q') || '').trim();
      const limit = Math.min(200, Math.max(20, Math.trunc(Number(url.searchParams.get('limit') || 120))));
      const traces = await queryPipelineLogs(db, { status, layer, q, limit });
      return jsonResp({ traces });
    }

    case 'admin-pipeline-logs-purge': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const res = await purgeOldPipelineLogs(db);
      return jsonResp({ ok: true, ...res });
    }

    case 'admin-catalog-update': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const targetUri = String(body?.uri || '').trim();
      const label = String(body?.label || '').trim();
      if (!targetUri || !label) {
        return jsonResp({ error: 'uri et label requis.' }, 400);
      }
      const patch: AdminCatalogPatchInput = {
        label,
        ...(body?.image_url !== undefined ? { image_url: body.image_url ? String(body.image_url) : null } : {}),
        ...(body?.main_category !== undefined ? { main_category: body.main_category ? String(body.main_category) : null } : {}),
        ...(Array.isArray(body?.subgenres)
          ? { subgenres: body.subgenres.map((s: unknown) => String(s || '').trim()).filter(Boolean) }
          : {}),
        ...(body?.series_number !== undefined ? { series_number: body.series_number ? String(body.series_number) : null } : {}),
        ...(body?.series_name !== undefined ? { series_name: body.series_name ? String(body.series_name) : null } : {}),
        ...(Array.isArray(body?.authors)
          ? { authors: body.authors.map((a: unknown) => String(a || '').trim()).filter(Boolean) }
          : {}),
        ...(body?.publisher !== undefined ? { publisher: body.publisher ? String(body.publisher) : null } : {}),
        ...(body?.publication_date !== undefined ? { publication_date: body.publication_date ? String(body.publication_date) : null } : {})
      };

      const res = await applyAdminCatalogPatch(db, targetUri, patch, now);
      return jsonResp({ ok: true, uri: targetUri, updatedV4: res.updatedV4 });
    }

    case 'admin-catalog-bulk-update': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const rawUris = Array.isArray(body?.uris) ? body.uris : [];
      const uris: string[] = Array.from(
        new Set(rawUris.map((u: unknown) => String(u || '').trim()).filter(Boolean))
      ).slice(0, 200);
      if (uris.length === 0) {
        return jsonResp({ error: 'Au moins une œuvre (uris) doit être sélectionnée.' }, 400);
      }

      const rawPatch = (body?.patch && typeof body.patch === 'object' ? body.patch : {}) as Record<string, any>;
      const patch: AdminCatalogPatchInput = {};
      if (rawPatch.publisher !== undefined) {
        patch.publisher = rawPatch.publisher ? String(rawPatch.publisher).trim() : null;
      }
      if (rawPatch.main_category !== undefined) {
        patch.main_category = rawPatch.main_category ? String(rawPatch.main_category).trim() : null;
      }
      if (rawPatch.series_name !== undefined) {
        patch.series_name = rawPatch.series_name ? String(rawPatch.series_name).trim() : null;
      }
      if (rawPatch.publication_date !== undefined) {
        patch.publication_date = rawPatch.publication_date ? String(rawPatch.publication_date).trim() : null;
      }
      if (Array.isArray(rawPatch.authors)) {
        patch.authors = rawPatch.authors.map((a: unknown) => String(a || '').trim()).filter(Boolean);
      }
      if (Array.isArray(rawPatch.subgenres)) {
        patch.subgenres = rawPatch.subgenres.map((s: unknown) => String(s || '').trim()).filter(Boolean);
      }

      if (Object.keys(patch).length === 0) {
        return jsonResp({ error: 'Aucun champ à modifier dans patch.' }, 400);
      }

      let updatedCount = 0;
      let updatedV4Count = 0;
      for (const targetUri of uris) {
        const res = await applyAdminCatalogPatch(db, targetUri, patch, now);
        if (res.updated) updatedCount++;
        if (res.updatedV4) updatedV4Count++;
      }

      return jsonResp({
        ok: true,
        requestedCount: uris.length,
        updatedCount,
        updatedV4Count
      });
    }

    case 'rehydrate-catalog': {
      const admin = await requireAdmin(db, request);
      if (!admin) {
        return jsonResp({ error: 'Accès administrateur requis.' }, 403);
      }
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 6);
      const result = await rehydrateAllCatalogEntitiesInD1(db, { offset, limit });
      return jsonResp({ ok: true, ...result });
    }

    default:
      return null;
  }
}
