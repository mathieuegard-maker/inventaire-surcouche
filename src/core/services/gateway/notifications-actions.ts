// src/core/services/gateway/notifications-actions.ts
// Domaine métier : Préférences de notifications, digests et abonnements Web Push.

import { resolveAuthSession } from '../d1-gateway.service';
import { jsonResp, type GatewayActionContext } from './gateway-context';

export async function handleNotificationsGatewayAction(
  ctx: GatewayActionContext
): Promise<Response | null> {
  const { action, db, env, request, url, body, now } = ctx;

  switch (action) {
    case 'notif-prefs-get': {
      const auth = await resolveAuthSession(db, request, url.searchParams.get('uri'));
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }
      const pref = await db
        .prepare(
          `SELECT digest_frequency, digest_hour, digest_weekday, digest_day_of_month, digest_timezone, digest_channel, last_notified_at
           FROM user_notification_prefs WHERE user_id = ? LIMIT 1`
        )
        .bind(auth.userId)
        .first<{
          digest_frequency: string;
          digest_hour: number;
          digest_weekday: number;
          digest_day_of_month: number;
          digest_timezone: string;
          digest_channel: string;
          last_notified_at: string | null;
        }>();

      const subCountRow = await db
        .prepare('SELECT COUNT(*) as cnt FROM user_push_subscriptions WHERE user_id = ?')
        .bind(auth.userId)
        .first<{ cnt: number }>();

      return jsonResp({
        digestFrequency: pref?.digest_frequency || 'off',
        digestHour: pref?.digest_hour ?? 9,
        digestWeekday: pref?.digest_weekday ?? 6,
        digestDayOfMonth: pref?.digest_day_of_month ?? 1,
        digestTimezone: pref?.digest_timezone || 'Europe/Paris',
        digestChannel: pref?.digest_channel || 'push',
        lastNotifiedAt: pref?.last_notified_at || null,
        hasPushSubscription: (subCountRow?.cnt || 0) > 0,
        vapidPublicKey: env?.VAPID_PUBLIC_KEY || null
      });
    }

    case 'notif-prefs-save': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }
      const freq = ['off', 'daily', 'weekly', 'monthly'].includes(body?.digestFrequency)
        ? String(body?.digestFrequency)
        : 'off';
      const hour = Math.min(Math.max(Math.trunc(Number(body?.digestHour ?? 9)), 0), 23);
      const weekday = Math.min(Math.max(Math.trunc(Number(body?.digestWeekday ?? 6)), 0), 6);
      const dayOfMonth = Math.min(Math.max(Math.trunc(Number(body?.digestDayOfMonth ?? 1)), 1), 28);
      const timezone = String(body?.digestTimezone || 'Europe/Paris').trim() || 'Europe/Paris';
      const channel = ['push', 'email', 'both'].includes(body?.digestChannel)
        ? String(body?.digestChannel)
        : 'push';

      await db
        .prepare(
          `INSERT INTO user_notification_prefs (
             user_id, digest_frequency, digest_hour, digest_weekday, digest_day_of_month,
             digest_timezone, digest_channel, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             digest_frequency = excluded.digest_frequency,
             digest_hour = excluded.digest_hour,
             digest_weekday = excluded.digest_weekday,
             digest_day_of_month = excluded.digest_day_of_month,
             digest_timezone = excluded.digest_timezone,
             digest_channel = excluded.digest_channel,
             updated_at = excluded.updated_at`
        )
        .bind(auth.userId, freq, hour, weekday, dayOfMonth, timezone, channel, now)
        .run();

      return jsonResp({
        ok: true,
        digestFrequency: freq,
        digestHour: hour,
        digestWeekday: weekday,
        digestDayOfMonth: dayOfMonth,
        digestTimezone: timezone,
        digestChannel: channel
      });
    }

    case 'push-subscribe': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }
      const endpoint = String(body?.subscription?.endpoint || '').trim();
      const p256dh = String(body?.subscription?.keys?.p256dh || '').trim();
      const authKey = String(body?.subscription?.keys?.auth || '').trim();
      if (!endpoint || !p256dh || !authKey) {
        return jsonResp({ error: 'Abonnement Push invalide.' }, 400);
      }
      const subId = `psub_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const ua = request.headers.get('User-Agent') || null;
      await db
        .prepare(
          `INSERT INTO user_push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             user_id = excluded.user_id,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             user_agent = excluded.user_agent,
             updated_at = excluded.updated_at`
        )
        .bind(subId, auth.userId, endpoint, p256dh, authKey, ua, now, now)
        .run();

      return jsonResp({ ok: true });
    }

    case 'push-unsubscribe': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }
      const endpoint = String(body?.endpoint || '').trim();
      if (endpoint) {
        await db
          .prepare('DELETE FROM user_push_subscriptions WHERE user_id = ? AND endpoint = ?')
          .bind(auth.userId, endpoint)
          .run();
      } else {
        await db
          .prepare('DELETE FROM user_push_subscriptions WHERE user_id = ?')
          .bind(auth.userId)
          .run();
      }
      return jsonResp({ ok: true });
    }

    default:
      return null;
  }
}
