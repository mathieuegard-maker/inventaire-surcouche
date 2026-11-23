// src/server/repositories/notification.repo.ts
// Repository SQL pur pour user_notification_prefs, user_push_subscriptions et series_release_alerts.

import type { DatabaseAdapter } from '../db/database.adapter';
import type { NotificationChannel, NotificationFrequency } from '../../shared/types/domain.types';

export interface NotificationPrefsRow {
  user_id: string;
  frequency: NotificationFrequency;
  day_of_week: number;
  day_of_month: number;
  hour: number;
  timezone: string;
  channel: NotificationChannel;
  last_notified_at: string | null;
  updated_at: string;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export interface ReleaseAlertRow {
  id: string;
  library_id: string;
  series_id: string;
  book_id: string;
  detected_at: string;
  dismissed_at: string | null;
}

export class NotificationRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ==================== PREFS ====================

  getPrefs(userId: string): NotificationPrefsRow | null {
    return this.db.get<NotificationPrefsRow>(
      'SELECT * FROM user_notification_prefs WHERE user_id = ? LIMIT 1',
      [userId]
    );
  }

  upsertPrefs(input: {
    userId: string;
    frequency: NotificationFrequency;
    dayOfWeek: number;
    dayOfMonth: number;
    hour: number;
    timezone: string;
    channel: NotificationChannel;
    now: string;
  }): NotificationPrefsRow {
    this.db.run(
      `INSERT INTO user_notification_prefs (
         user_id, frequency, day_of_week, day_of_month, hour, timezone, channel, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         frequency = excluded.frequency,
         day_of_week = excluded.day_of_week,
         day_of_month = excluded.day_of_month,
         hour = excluded.hour,
         timezone = excluded.timezone,
         channel = excluded.channel,
         updated_at = excluded.updated_at`,
      [
        input.userId,
        input.frequency,
        input.dayOfWeek,
        input.dayOfMonth,
        input.hour,
        input.timezone,
        input.channel,
        input.now
      ]
    );
    return this.getPrefs(input.userId)!;
  }

  listEnabledPrefsWithUsers(): Array<NotificationPrefsRow & { email: string; username: string; library_id: string }> {
    return this.db.all<NotificationPrefsRow & { email: string; username: string; library_id: string }>(
      `SELECT p.*, u.email, u.username, lm.library_id
       FROM user_notification_prefs p
       JOIN users u ON u.id = p.user_id
       JOIN library_members lm ON lm.user_id = u.id
       WHERE p.frequency != 'off'`
    );
  }

  markNotified(userId: string, now: string): void {
    this.db.run('UPDATE user_notification_prefs SET last_notified_at = ? WHERE user_id = ?', [now, userId]);
  }

  // ==================== PUSH SUBSCRIPTIONS ====================

  listPushSubscriptions(userId: string): PushSubscriptionRow[] {
    return this.db.all<PushSubscriptionRow>(
      'SELECT * FROM user_push_subscriptions WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
  }

  upsertPushSubscription(input: {
    id: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    now: string;
  }): void {
    this.db.run(
      `INSERT INTO user_push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth`,
      [input.id, input.userId, input.endpoint, input.p256dh, input.auth, input.now]
    );
  }

  deletePushSubscription(userId: string, endpoint?: string): void {
    if (endpoint) {
      this.db.run('DELETE FROM user_push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint]);
    } else {
      this.db.run('DELETE FROM user_push_subscriptions WHERE user_id = ?', [userId]);
    }
  }

  // ==================== RELEASE ALERTS ====================

  listActiveAlerts(libraryId: string): ReleaseAlertRow[] {
    return this.db.all<ReleaseAlertRow>(
      `SELECT * FROM series_release_alerts
       WHERE library_id = ? AND dismissed_at IS NULL
       ORDER BY detected_at DESC`,
      [libraryId]
    );
  }

  createAlertIfAbsent(input: {
    id: string;
    libraryId: string;
    seriesId: string;
    bookId: string;
    detectedAt: string;
  }): boolean {
    const res = this.db.run(
      `INSERT OR IGNORE INTO series_release_alerts (id, library_id, series_id, book_id, detected_at, dismissed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [input.id, input.libraryId, input.seriesId, input.bookId, input.detectedAt]
    );
    return res.changes > 0;
  }

  dismissAlert(libraryId: string, alertId: string, now: string): boolean {
    const res = this.db.run(
      'UPDATE series_release_alerts SET dismissed_at = ? WHERE library_id = ? AND id = ? AND dismissed_at IS NULL',
      [now, libraryId, alertId]
    );
    return res.changes > 0;
  }

  dismissAlertsByBook(libraryId: string, bookId: string, now: string): void {
    this.db.run(
      'UPDATE series_release_alerts SET dismissed_at = ? WHERE library_id = ? AND book_id = ? AND dismissed_at IS NULL',
      [now, libraryId, bookId]
    );
  }

  dismissAllAlerts(libraryId: string, now: string): number {
    return this.db.run(
      'UPDATE series_release_alerts SET dismissed_at = ? WHERE library_id = ? AND dismissed_at IS NULL',
      [now, libraryId]
    ).changes;
  }

  listAllLibraryIds(): string[] {
    return this.db.all<{ id: string }>('SELECT id FROM libraries').map((r) => r.id);
  }
}
