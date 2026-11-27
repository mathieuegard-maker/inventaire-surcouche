// src/server/repositories/user.repo.ts
// Repository SQL pur pour l'espace Compte / Utilisateur (zéro logique métier).

import type { DatabaseAdapter } from '../db/database.adapter';
import type { LocaleId, ThemeId } from '../../shared/types/domain.types';

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  is_admin: number;
  banned_at: string | null;
  theme: ThemeId;
  locale: LocaleId;
  gdpr_accepted_at: string;
  onboarding_notif_seen: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface PasswordResetRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
  used_at: string | null;
}

export interface UserAiUsageRow {
  user_id: string;
  month_key: string;
  month_used: number;
  total_used: number;
  updated_at: string;
}

export class UserRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  findById(id: string): UserRow | null {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  }

  findByUsername(username: string): UserRow | null {
    return this.db.get<UserRow>('SELECT * FROM users WHERE lower(username) = lower(?) LIMIT 1', [username]);
  }

  findByEmail(email: string): UserRow | null {
    return this.db.get<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1', [email]);
  }

  findByIdentifier(identifier: string): UserRow | null {
    return this.db.get<UserRow>(
      'SELECT * FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?) LIMIT 1',
      [identifier, identifier]
    );
  }

  createUser(params: {
    id: string;
    username: string;
    email: string;
    passwordHash: string;
    isAdmin: boolean;
    gdprAcceptedAt: string;
    now: string;
  }): void {
    this.db.run(
      `INSERT INTO users (id, username, email, password_hash, is_admin, theme, locale, gdpr_accepted_at, onboarding_notif_seen, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'editorial-light', 'fr', ?, 0, ?, ?)`,
      [
        params.id,
        params.username,
        params.email.toLowerCase(),
        params.passwordHash,
        params.isAdmin ? 1 : 0,
        params.gdprAcceptedAt,
        params.now,
        params.now
      ]
    );
  }

  updateUser(
    id: string,
    patch: Partial<{
      username: string;
      email: string;
      passwordHash: string;
      theme: ThemeId;
      locale: LocaleId;
      onboardingNotifSeen: boolean;
      bannedAt: string | null;
      updatedAt: string;
    }>
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];

    if (patch.username !== undefined) {
      sets.push('username = ?');
      values.push(patch.username);
    }
    if (patch.email !== undefined) {
      sets.push('email = ?');
      values.push(patch.email.toLowerCase());
    }
    if (patch.passwordHash !== undefined) {
      sets.push('password_hash = ?');
      values.push(patch.passwordHash);
    }
    if (patch.theme !== undefined) {
      sets.push('theme = ?');
      values.push(patch.theme);
    }
    if (patch.locale !== undefined) {
      sets.push('locale = ?');
      values.push(patch.locale);
    }
    if (patch.onboardingNotifSeen !== undefined) {
      sets.push('onboarding_notif_seen = ?');
      values.push(patch.onboardingNotifSeen ? 1 : 0);
    }
    if (patch.bannedAt !== undefined) {
      sets.push('banned_at = ?');
      values.push(patch.bannedAt);
    }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(patch.updatedAt ?? new Date().toISOString());
    values.push(id);

    this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  deleteUser(id: string): void {
    this.db.run('DELETE FROM users WHERE id = ?', [id]);
  }

  createSession(params: { tokenHash: string; userId: string; expiresAt: string; now: string }): void {
    this.db.run(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [params.tokenHash, params.userId, params.expiresAt, params.now]
    );
  }

  findSession(tokenHash: string): SessionRow | null {
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ? LIMIT 1', [tokenHash]);
  }

  deleteSession(tokenHash: string): void {
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  deleteAllUserSessions(userId: string): void {
    this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  createPasswordResetToken(params: { tokenHash: string; userId: string; expiresAt: string }): void {
    this.db.run('DELETE FROM password_reset_tokens WHERE user_id = ?', [params.userId]);
    this.db.run(
      'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)',
      [params.tokenHash, params.userId, params.expiresAt]
    );
  }

  findPasswordResetToken(tokenHash: string, userId: string): PasswordResetRow | null {
    return this.db.get<PasswordResetRow>(
      'SELECT * FROM password_reset_tokens WHERE token_hash = ? AND user_id = ? LIMIT 1',
      [tokenHash, userId]
    );
  }

  markPasswordResetUsed(tokenHash: string, now: string): void {
    this.db.run('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?', [now, tokenHash]);
  }

  listDefaultGenres(userId: string): string[] {
    const rows = this.db.all<{ genre_label: string }>(
      'SELECT genre_label FROM user_default_genres WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC, genre_label ASC',
      [userId]
    );
    return rows.map((r) => r.genre_label);
  }

  replaceDefaultGenres(userId: string, genres: readonly string[], now: string): void {
    this.db.run('DELETE FROM user_default_genres WHERE user_id = ?', [userId]);
    for (let i = 0; i < genres.length; i++) {
      const g = genres[i];
      this.db.run(
        `INSERT INTO user_default_genres (user_id, genre_label, sort_order, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, genre_label) DO UPDATE SET sort_order = excluded.sort_order`,
        [userId, g, i, now]
      );
    }
  }

  addDefaultGenre(userId: string, genre: string, now: string): void {
    const maxRow = this.db.get<{ max_order: number | null }>(
      'SELECT MAX(sort_order) AS max_order FROM user_default_genres WHERE user_id = ?',
      [userId]
    );
    const nextOrder = (maxRow?.max_order ?? -1) + 1;
    this.db.run(
      `INSERT INTO user_default_genres (user_id, genre_label, sort_order, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, genre_label) DO NOTHING`,
      [userId, genre, nextOrder, now]
    );
  }

  reorderDefaultGenres(userId: string, orderedGenres: readonly string[]): void {
    const existing = this.listDefaultGenres(userId);
    const existingByLower = new Map(existing.map((g) => [g.toLowerCase(), g]));
    const finalOrder: string[] = [];
    const seen = new Set<string>();

    for (const raw of orderedGenres) {
      const key = raw.trim().toLowerCase();
      const canonical = existingByLower.get(key);
      if (canonical && !seen.has(key)) {
        seen.add(key);
        finalOrder.push(canonical);
      }
    }
    for (const g of existing) {
      const key = g.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        finalOrder.push(g);
      }
    }

    this.db.transaction(() => {
      for (let i = 0; i < finalOrder.length; i++) {
        this.db.run(
          'UPDATE user_default_genres SET sort_order = ? WHERE user_id = ? AND genre_label = ?',
          [i, userId, finalOrder[i]]
        );
      }
    });
  }

  removeDefaultGenre(userId: string, genre: string): void {
    this.db.run('DELETE FROM user_default_genres WHERE user_id = ? AND lower(genre_label) = lower(?)', [
      userId,
      genre
    ]);
  }

  listGlobalDefaultGenres(): string[] {
    const rows = this.db.all<{ genre_label: string }>(
      'SELECT genre_label FROM app_default_genres ORDER BY sort_order ASC, created_at ASC, genre_label ASC'
    );
    return rows.map((r) => r.genre_label);
  }

  replaceGlobalDefaultGenres(genres: readonly string[], now: string): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const raw of genres) {
      const clean = raw.trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(clean);
    }

    this.db.transaction(() => {
      this.db.run('DELETE FROM app_default_genres');
      for (let i = 0; i < deduped.length; i++) {
        this.db.run(
          `INSERT INTO app_default_genres (genre_label, sort_order, created_at)
           VALUES (?, ?, ?)`,
          [deduped[i], i, now]
        );
      }
    });

    return this.listGlobalDefaultGenres();
  }

  getAiUsage(userId: string): UserAiUsageRow | null {
    return this.db.get<UserAiUsageRow>('SELECT * FROM user_ai_usage WHERE user_id = ? LIMIT 1', [userId]);
  }

  incrementAiUsage(userId: string, monthKey: string, now: string): UserAiUsageRow {
    const existing = this.getAiUsage(userId);
    if (!existing) {
      this.db.run(
        `INSERT INTO user_ai_usage (user_id, month_key, month_used, total_used, updated_at)
         VALUES (?, ?, 1, 1, ?)`,
        [userId, monthKey, now]
      );
    } else {
      const nextMonthUsed = existing.month_key === monthKey ? existing.month_used + 1 : 1;
      const nextTotal = existing.total_used + 1;
      this.db.run(
        `UPDATE user_ai_usage
         SET month_key = ?, month_used = ?, total_used = ?, updated_at = ?
         WHERE user_id = ?`,
        [monthKey, nextMonthUsed, nextTotal, now, userId]
      );
    }
    return this.getAiUsage(userId)!;
  }

  resetAiUsage(userId: string, monthKey: string, now: string): void {
    this.db.run(
      `INSERT INTO user_ai_usage (user_id, month_key, month_used, total_used, updated_at)
       VALUES (?, ?, 0, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET month_key = excluded.month_key, month_used = 0, updated_at = excluded.updated_at`,
      [userId, monthKey, now]
    );
  }
}
