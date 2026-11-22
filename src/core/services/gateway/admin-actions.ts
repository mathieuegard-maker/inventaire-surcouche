// src/core/services/gateway/admin-actions.ts
// Domaine métier : Administration, supervision du catalogue, quotas IA et observabilité des logs.

import { computeMonthlyAiQuota } from '../../utils/vision-prompt.util';
import { rehydrateAllCatalogEntitiesInD1 } from '../d1-gateway.service';
import { purgeOldPipelineLogs, queryPipelineLogs } from '../pipeline-logger.service';
import { runCentralizedSeriesReleaseSweep } from '../series-digest.service';
import { jsonResp, maskEmail, requireAdmin, type GatewayActionContext } from './gateway-context';

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
        if (row.entity_json) {
          try {
            const parsed = JSON.parse(row.entity_json) as {
              claims?: Record<string, unknown[]>;
              publisher?: string;
              publishDate?: string;
            };
            publisher = parsed.publisher || null;
            const rawDate = parsed.publishDate || parsed.claims?.['wdt:P577']?.[0];
            if (typeof rawDate === 'string') publication_date = rawDate;
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
          series_number: row.series_number,
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
      const imageUrl = body?.image_url !== undefined ? String(body.image_url || '').trim() || null : undefined;
      const mainCategory = body?.main_category !== undefined ? String(body.main_category || '').trim() || null : undefined;
      const seriesNumber = body?.series_number !== undefined ? String(body.series_number || '').trim() || null : undefined;
      const publisher = body?.publisher !== undefined ? String(body.publisher || '').trim() || null : undefined;
      const publicationDate = body?.publication_date !== undefined ? String(body.publication_date || '').trim() || null : undefined;

      // 1. Mettre à jour `catalog_entities` (socle V2)
      const existingCe = await db
        .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
        .bind(targetUri)
        .first<{ entity_json: string | null }>();
      let parsedEntity: Record<string, any> = {};
      if (existingCe?.entity_json) {
        try {
          parsedEntity = JSON.parse(existingCe.entity_json);
        } catch {
          parsedEntity = {};
        }
      }
      parsedEntity.label = label;
      if (publisher !== undefined) parsedEntity.publisher = publisher;
      if (publicationDate !== undefined) parsedEntity.publishDate = publicationDate;

      await db
        .prepare(
          `UPDATE catalog_entities
           SET label = ?,
               image_url = COALESCE(?, image_url),
               main_category = COALESCE(?, main_category),
               series_number = COALESCE(?, series_number),
               entity_json = ?,
               updated_at = ?
           WHERE uri = ?`
        )
        .bind(
          label,
          imageUrl === undefined ? null : imageUrl,
          mainCategory === undefined ? null : mainCategory,
          seriesNumber === undefined ? null : seriesNumber,
          JSON.stringify(parsedEntity),
          now,
          targetUri
        )
        .run();

      // 2. Synchroniser également la table maître V4 `books` si l'ouvrage y existe
      const rawIsbn = targetUri.startsWith('isbn:') ? targetUri.slice(5).replace(/[^0-9X]/gi, '') : '';
      const v4Row = await db
        .prepare(
          rawIsbn
            ? `SELECT b.id FROM books b
               WHERE b.legacy_entity_uri = ?
                  OR EXISTS (SELECT 1 FROM book_isbn_index bi WHERE bi.book_id = b.id AND bi.isbn13 = ?)
               LIMIT 1`
            : 'SELECT id FROM books WHERE legacy_entity_uri = ? OR id = ? LIMIT 1'
        )
        .bind(targetUri, rawIsbn || targetUri.replace(/^(?:v4:|book:)/, ''))
        .first<{ id: string }>()
        .catch(() => null);

      if (v4Row?.id) {
        const volNum = seriesNumber && /^\d+$/.test(seriesNumber) ? parseInt(seriesNumber, 10) : null;
        await db
          .prepare(
            `UPDATE books
             SET canonical_title = ?,
                 selected_cover_url = COALESCE(?, selected_cover_url),
                 main_category = COALESCE(?, main_category),
                 volume_label = COALESCE(?, volume_label),
                 volume_number = COALESCE(?, volume_number),
                 publisher = COALESCE(?, publisher),
                 publication_year = COALESCE(?, publication_year),
                 updated_at = ?
             WHERE id = ?`
          )
          .bind(
            label,
            imageUrl === undefined ? null : imageUrl,
            mainCategory === undefined ? null : mainCategory,
            seriesNumber === undefined ? null : seriesNumber,
            volNum,
            publisher === undefined ? null : publisher,
            publicationDate === undefined ? null : publicationDate,
            now,
            v4Row.id
          )
          .run()
          .catch(() => {});
      }

      return jsonResp({ ok: true, uri: targetUri, updatedV4: Boolean(v4Row?.id) });
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
