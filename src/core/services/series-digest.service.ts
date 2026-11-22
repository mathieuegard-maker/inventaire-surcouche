// src/core/services/series-digest.service.ts
// Balayage centralisé des sorties de séries (uniquement pour les séries avec >= 1 tome possédé)
// et distribution personnalisée des digests (Push PWA et/ou E-mail) par utilisateur.

import type { AppBackendEnv, DatabaseBinding } from '../adapters/storage-db.interface';
import { expandSeriesVolumesInD1 } from './d1-gateway.service';
import { getV4SeriesBooks } from './v4-pipeline.service';
import { sendWebPushNotification } from './web-push.service';

export interface NotificationPrefRow {
  user_id: string;
  digest_frequency: 'off' | 'daily' | 'weekly' | 'monthly';
  digest_hour: number;
  digest_weekday: number;
  digest_day_of_month: number;
  digest_timezone: string;
  digest_channel: 'push' | 'email' | 'both';
  last_notified_at: string | null;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export function getLocalDateParts(date: Date, timeZone: string): {
  dateKey: string;
  hour: number;
  weekday: number;
  dayOfMonth: number;
} {
  let safeTz = timeZone || 'Europe/Paris';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: safeTz }).format(date);
  } catch {
    safeTz = 'Europe/Paris';
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hour12: false
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const rawHour = Number(get('hour'));
  const hour = rawHour === 24 ? 0 : rawHour;
  const weekday = WEEKDAY_MAP[get('weekday')] ?? 0;

  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    weekday,
    dayOfMonth: Number(day)
  };
}

export function shouldSendDigestNow(pref: NotificationPrefRow, nowDate: Date): boolean {
  if (!pref || pref.digest_frequency === 'off') return false;

  const local = getLocalDateParts(nowDate, pref.digest_timezone || 'Europe/Paris');
  if (local.hour !== Number(pref.digest_hour)) return false;

  if (pref.digest_frequency === 'weekly' && local.weekday !== Number(pref.digest_weekday)) {
    return false;
  }
  if (pref.digest_frequency === 'monthly' && local.dayOfMonth !== Number(pref.digest_day_of_month)) {
    return false;
  }

  if (pref.last_notified_at) {
    const lastDate = new Date(pref.last_notified_at);
    if (!Number.isNaN(lastDate.getTime())) {
      const lastLocal = getLocalDateParts(lastDate, pref.digest_timezone || 'Europe/Paris');
      if (lastLocal.dateKey === local.dateKey) {
        return false;
      }
    }
  }

  return true;
}

export async function runCentralizedSeriesReleaseSweep(
  db: DatabaseBinding,
  options?: { limit?: number; staleDays?: number; delayMs?: number }
): Promise<{ checkedCount: number; alertsCreated: number }> {
  const limit = Math.min(Math.max(Number(options?.limit ?? 6), 1), 500);
  const staleDays = Math.min(Math.max(Number(options?.staleDays ?? 3), 1), 30);
  const delayMs = Math.max(0, Number(options?.delayMs ?? 0));
  const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // Sélectionne uniquement les séries pour lesquelles au moins une bibliothèque possède activement >= 1 tome
  const staleSeries = await db
    .prepare(
      `SELECT DISTINCT s.uri, s.label
       FROM library_items li
       JOIN catalog_entities ce ON (ce.uri = li.edition_id OR ce.uri = li.work_id)
       JOIN catalog_entities s ON s.uri = ce.series_uri
       WHERE li.ownership_status = 'owned'
         AND li.deleted_at IS NULL
         AND ce.series_uri IS NOT NULL
         AND s.entity_type = 'serie'
         AND (s.series_checked_at IS NULL OR s.series_checked_at < ?)
       ORDER BY s.series_checked_at IS NOT NULL ASC, s.series_checked_at ASC
       LIMIT ?`
    )
    .bind(staleCutoff, limit)
    .all<{ uri: string; label: string }>();

  let checkedCount = 0;
  let alertsCreated = 0;

  for (const s of staleSeries.results || []) {
    checkedCount++;
    try {
      const expandRes = await expandSeriesVolumesInD1(db, s.uri, s.label);
      if (expandRes.wasAlreadyExpanded && expandRes.addedVolumes.length > 0) {
        // Distribue uniquement aux bibliothèques qui possèdent au moins un tome de cette série
        const owningLibs = await db
          .prepare(
            `SELECT DISTINCT li.library_id
             FROM library_items li
             JOIN catalog_entities ce ON (ce.uri = li.edition_id OR ce.uri = li.work_id)
             WHERE li.ownership_status = 'owned'
               AND li.deleted_at IS NULL
               AND ce.series_uri = ?`
          )
          .bind(s.uri)
          .all<{ library_id: string }>();

        for (const lib of owningLibs.results || []) {
          for (const vol of expandRes.addedVolumes) {
            const alertId = `${lib.library_id}:${vol.workUri}`;
            await db
              .prepare(
                `INSERT OR IGNORE INTO series_release_alerts (
                   id, library_id, series_uri, series_title, volume_uri, volume_title,
                   series_number, isbn13, cover_url, detected_at, dismissed
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
              )
              .bind(
                alertId,
                lib.library_id,
                s.uri,
                s.label,
                vol.editionUri || vol.workUri,
                vol.title,
                vol.seriesNumber || null,
                vol.isbn13 || null,
                vol.coverUrl || null,
                now
              )
              .run();
            alertsCreated++;
          }
        }
      }
    } catch (err) {
      console.warn(`[SERIES SWEEP] Erreur sur ${s.uri}:`, err);
    }
    if (delayMs > 0 && checkedCount < (staleSeries.results?.length || 0)) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Passe complémentaire V4 : séries suivies via `v4_library_books` + `v4_series`
  const remainingLimit = Math.max(0, limit - checkedCount);
  if (remainingLimit > 0) {
    try {
      const v4StaleSeries = await db
        .prepare(
          `SELECT DISTINCT s.id, s.canonical_name
           FROM v4_library_books lb
           JOIN books b ON b.id = lb.book_id
           JOIN v4_series s ON s.id = b.series_id
           WHERE lb.is_owned = 1
             AND (s.updated_at IS NULL OR s.updated_at < ?)
           ORDER BY s.updated_at ASC
           LIMIT ?`
        )
        .bind(staleCutoff, remainingLimit)
        .all<{ id: string; canonical_name: string }>();

      for (const s of v4StaleSeries.results || []) {
        checkedCount++;
        try {
          const beforeRows = await db
            .prepare('SELECT id FROM books WHERE series_id = ?')
            .bind(s.id)
            .all<{ id: string }>();
          const beforeIds = new Set((beforeRows.results || []).map((r) => r.id));

          await db
            .prepare('UPDATE v4_series SET is_complete_expanded = 0, updated_at = ? WHERE id = ?')
            .bind(now, s.id)
            .run();

          const expanded = await getV4SeriesBooks(db, { seriesId: s.id, libraryId: null });
          const newBooks = (expanded.books || []).filter((entry) => !beforeIds.has(entry.book.id));

          if (beforeIds.size > 0 && newBooks.length > 0) {
            const owningLibs = await db
              .prepare(
                `SELECT DISTINCT lb.library_id
                 FROM v4_library_books lb
                 JOIN books b ON b.id = lb.book_id
                 WHERE lb.is_owned = 1 AND b.series_id = ?`
              )
              .bind(s.id)
              .all<{ library_id: string }>();

            for (const lib of owningLibs.results || []) {
              for (const entry of newBooks) {
                const b = entry.book;
                const isbn13 = b.knownIsbns?.[0] || null;
                const volUri = b.legacyEntityUri || (isbn13 ? `isbn:${isbn13}` : `v4:${b.id}`);
                const alertId = `${lib.library_id}:${b.id}`;
                await db
                  .prepare(
                    `INSERT OR IGNORE INTO series_release_alerts (
                       id, library_id, series_uri, series_title, volume_uri, volume_title,
                       series_number, isbn13, cover_url, detected_at, dismissed
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
                  )
                  .bind(
                    alertId,
                    lib.library_id,
                    s.id,
                    s.canonical_name,
                    volUri,
                    b.canonicalTitle,
                    b.volumeLabel || (b.volumeNumber != null ? String(b.volumeNumber) : null),
                    isbn13,
                    b.selectedCoverUrl || null,
                    now
                  )
                  .run();
                alertsCreated++;
              }
            }
          }
        } catch (err) {
          console.warn(`[SERIES SWEEP V4] Erreur sur ${s.id}:`, err);
        }
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } catch {
      // Non-bloquant si tables V4 absentes dans un test unitaire minimal
    }
  }

  return { checkedCount, alertsCreated };
}

export async function runHourlyDigestDispatch(
  db: DatabaseBinding,
  env: AppBackendEnv,
  nowDate = new Date()
): Promise<{ usersNotified: number }> {
  const nowIso = nowDate.toISOString();

  const prefRows = await db
    .prepare(
      `SELECT p.user_id, p.digest_frequency, p.digest_hour, p.digest_weekday,
              p.digest_day_of_month, p.digest_timezone, p.digest_channel, p.last_notified_at,
              u.display_name, u.recovery_email, lm.library_id
       FROM user_notification_prefs p
       JOIN users u ON u.id = p.user_id
       JOIN library_members lm ON lm.user_id = p.user_id
       WHERE p.digest_frequency != 'off'`
    )
    .all<
      NotificationPrefRow & {
        display_name: string;
        recovery_email: string | null;
        library_id: string;
      }
    >();

  let usersNotified = 0;

  for (const row of prefRows.results || []) {
    if (!shouldSendDigestNow(row, nowDate)) continue;

    const sinceCutoff = row.last_notified_at || '';
    const alertsRes = await db
      .prepare(
        `SELECT a.series_title, a.volume_title, a.series_number
         FROM series_release_alerts a
         WHERE a.library_id = ?
           AND a.dismissed = 0
           AND (? = '' OR a.detected_at > ?)
           AND NOT EXISTS (
             SELECT 1 FROM library_items li
             WHERE li.library_id = a.library_id
               AND li.deleted_at IS NULL
               AND (li.edition_id = a.volume_uri OR li.work_id = a.volume_uri OR (a.isbn13 IS NOT NULL AND li.edition_id = ('isbn:' || a.isbn13)))
           )
         ORDER BY a.detected_at DESC
         LIMIT 20`
      )
      .bind(row.library_id, sinceCutoff, sinceCutoff)
      .all<{ series_title: string; volume_title: string; series_number: string | null }>();

    const alerts = alertsRes.results || [];
    if (alerts.length === 0) continue;

    let delivered = false;
    const summaryTitles = alerts
      .slice(0, 3)
      .map((a) => `${a.series_title}${a.series_number ? ` #${a.series_number}` : ''}`)
      .join(', ');
    const moreSuffix = alerts.length > 3 ? ` (+${alerts.length - 3} autres)` : '';
    const bodyText = `${alerts.length} nouveau${alerts.length > 1 ? 'x' : ''} tome${alerts.length > 1 ? 's' : ''} : ${summaryTitles}${moreSuffix}`;

    if (
      (row.digest_channel === 'push' || row.digest_channel === 'both') &&
      env.VAPID_PUBLIC_KEY &&
      env.VAPID_PRIVATE_JWK
    ) {
      const subs = await db
        .prepare('SELECT id, endpoint, p256dh, auth FROM user_push_subscriptions WHERE user_id = ?')
        .bind(row.user_id)
        .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();

      for (const sub of subs.results || []) {
        try {
          const pushRes = await sendWebPushNotification({
            endpoint: sub.endpoint,
            p256dh: sub.p256dh,
            auth: sub.auth,
            payload: {
              title: 'Biblio Collection — Nouveautés',
              body: bodyText,
              url: '/releases'
            },
            vapidPublicKey: env.VAPID_PUBLIC_KEY,
            vapidPrivateJwk: env.VAPID_PRIVATE_JWK,
            vapidSubject: env.VAPID_SUBJECT
          });
          if (pushRes.ok) delivered = true;
          if (pushRes.gone) {
            await db.prepare('DELETE FROM user_push_subscriptions WHERE id = ?').bind(sub.id).run();
          }
        } catch (err) {
          console.warn('[DIGEST PUSH] Échec envoi push:', err);
        }
      }
    }

    if (
      (row.digest_channel === 'email' || row.digest_channel === 'both') &&
      env.RESEND_API_KEY &&
      row.recovery_email
    ) {
      try {
        const itemsHtml = alerts
          .map(
            (a) =>
              `<li><strong>${a.series_title}</strong>${a.series_number ? ` — Tome ${a.series_number}` : ''} : ${a.volume_title}</li>`
          )
          .join('');
        const mailFrom = env.MAIL_FROM || 'Biblio Collection <onboarding@resend.dev>';
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: mailFrom,
            to: [row.recovery_email],
            subject: `Biblio Collection — ${alerts.length} nouveauté${alerts.length > 1 ? 's' : ''} détectée${alerts.length > 1 ? 's' : ''}`,
            html: `<p>Bonjour ${row.display_name},</p><p>Voici les nouveaux tomes détectés dans vos séries suivies :</p><ul>${itemsHtml}</ul><p>Ouvrez l'application dans <strong>Nouveautés</strong> pour les ajouter à votre wishlist.</p>`
          })
        });
        if (emailRes.ok) delivered = true;
      } catch (err) {
        console.warn('[DIGEST EMAIL] Échec envoi email:', err);
      }
    }

    if (delivered) {
      usersNotified++;
      await db
        .prepare('UPDATE user_notification_prefs SET last_notified_at = ? WHERE user_id = ?')
        .bind(nowIso, row.user_id)
        .run();
    }
  }

  return { usersNotified };
}
