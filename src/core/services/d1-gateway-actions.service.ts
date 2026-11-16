// src/core/services/d1-gateway-actions.service.ts
// Actions complètes du Gateway D1 (KISS, DRY, SOLID) :
// Authentification, Foyer & Partage, Inventaire, Wishlist, Prêts, Catalogue, Séries/Hors-séries, Statuts de lecture.

import type { AppBackendEnv, DatabaseBinding } from '../adapters/storage-db.interface';
import { normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import { classifyBookMetadata } from '../utils/category-classifier.util';
import { isbnUtil } from '../utils/isbn.util';
import {
  buildVisionPrompt,
  computeMonthlyAiQuota,
  PREFERRED_GEMINI_MODELS
} from '../utils/vision-prompt.util';
import {
  expandSeriesVolumesInD1,
  rehydrateAllCatalogEntitiesInD1,
  resolveAndStoreIsbnInD1,
  resolveAuthSession,
  resolveBestCoverUrl,
  upsertCatalogEntity
} from './d1-gateway.service';
import { runCentralizedSeriesReleaseSweep } from './series-digest.service';

async function requireAdmin(
  db: DatabaseBinding,
  request: Request
) {
  // Exige obligatoirement un cookie de session authentifié (pas de repli par URI de bibliothèque)
  const auth = await resolveAuthSession(db, request, null);
  if (!auth) return null;
  const row = await db
    .prepare('SELECT is_admin FROM users WHERE id = ? LIMIT 1')
    .bind(auth.userId)
    .first<{ is_admin?: number }>();
  return row?.is_admin === 1 ? auth : null;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateShortCode(len = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

function generateNumericCode(len = 6): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => String(b % 10))
    .join('');
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function jsonResp(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function extractShareToken(raw: string): string {
  const trimmed = String(raw || '').trim();
  const match = /((?:PUB|FAM)-[A-Z0-9]{4,12})/i.exec(trimmed);
  return (match ? match[1] : trimmed).toUpperCase();
}

async function addFriendConnectionForUser(
  db: DatabaseBinding,
  userId: string,
  rawToken: string
): Promise<{ ok: boolean; error?: string; friend?: Record<string, unknown> }> {
  const shareToken = extractShareToken(rawToken);
  if (!shareToken) return { ok: false, error: 'Code ou lien ami requis.' };

  const tokenRow = await db
    .prepare(
      `SELECT s.token, s.library_id, l.name as library_name, u.display_name as owner_name
       FROM share_tokens s
       JOIN libraries l ON l.id = s.library_id
       LEFT JOIN users u ON u.id = l.owner_user_id
       WHERE UPPER(s.token) = ? AND s.token_type = 'public_collection_readonly'
       LIMIT 1`
    )
    .bind(shareToken)
    .first<{ token: string; library_id: string; library_name: string; owner_name: string | null }>();

  if (!tokenRow) {
    return { ok: false, error: 'Lien ou code Vitrine Amis introuvable.' };
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO friend_connections (user_id, target_library_id, share_token, display_label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(userId, tokenRow.library_id, tokenRow.token, tokenRow.library_name, now)
    .run();

  return {
    ok: true,
    friend: {
      libraryId: tokenRow.library_id,
      libraryName: tokenRow.library_name,
      ownerName: tokenRow.owner_name || tokenRow.library_name,
      shareToken: tokenRow.token
    }
  };
}

async function getOrCreateShareTokens(
  db: DatabaseBinding,
  libraryId: string,
  userId: string
): Promise<{ inviteCode: string; publicReadonlyToken: string }> {
  const now = new Date().toISOString();
  const existing = await db
    .prepare('SELECT token, token_type FROM share_tokens WHERE library_id = ?')
    .bind(libraryId)
    .all<{ token: string; token_type: string }>();

  let inviteCode = existing.results.find((r) => r.token_type === 'invite_member')?.token;
  let publicReadonlyToken = existing.results.find(
    (r) => r.token_type === 'public_collection_readonly'
  )?.token;

  if (!inviteCode) {
    inviteCode = `FAM-${generateShortCode(6)}`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO share_tokens (token, library_id, token_type, target_role, label, created_by_user_id, created_at)
         VALUES (?, ?, 'invite_member', 'editor', 'Invitation Famille', ?, ?)`
      )
      .bind(inviteCode, libraryId, userId, now)
      .run();
  }

  if (!publicReadonlyToken) {
    publicReadonlyToken = `PUB-${generateShortCode(8)}`;
    await db
      .prepare(
        `INSERT OR IGNORE INTO share_tokens (token, library_id, token_type, target_role, label, created_by_user_id, created_at)
         VALUES (?, ?, 'public_collection_readonly', 'viewer', 'Lien Public Amis', ?, ?)`
      )
      .bind(publicReadonlyToken, libraryId, userId, now)
      .run();
  }

  return { inviteCode, publicReadonlyToken };
}

export async function handleD1GatewayAction(
  action: string,
  request: Request,
  env: AppBackendEnv,
  body: Record<string, any> | null
): Promise<Response | null> {
  const db = env.DB;
  if (!db) return null;

  const url = new URL(request.url);
  const now = new Date().toISOString();

  switch (action) {
    // ========================================================================
    // 1. AUTHENTIFICATION AUTONOME & GESTION FOYER / BIBLIOTHÈQUE PARTAGÉE
    // ========================================================================
    case 'auth-login':
    case 'auth-register': {
      const rawUsername = String(body?.username || '').trim();
      const rawPassword = String(body?.password || '');
      const rawRecoveryEmail = String(body?.recoveryEmail || '').trim().toLowerCase();
      const inviteCode = String(body?.inviteCode || '').trim().toUpperCase();
      const mode = body?.mode || (action === 'auth-register' ? 'register' : 'auto');

      if (!rawUsername || !rawPassword) {
        return jsonResp({ error: 'Identifiant et mot de passe requis.' }, 400);
      }

      const emailKey = rawUsername.toLowerCase();
      const passHash = await sha256Hex(`biblio_salt_v2:${rawPassword}`);

      let userRow = await db
        .prepare('SELECT id, email, display_name, password_hash, recovery_email, is_admin FROM users WHERE email = ? LIMIT 1')
        .bind(emailKey)
        .first<{
          id: string;
          email: string;
          display_name: string;
          password_hash: string;
          recovery_email?: string | null;
          is_admin?: number;
        }>();

      if (userRow) {
        if (mode === 'register') {
          return jsonResp({ error: 'Cet identifiant existe déjà. Connectez-vous.' }, 409);
        }
        if (userRow.password_hash !== passHash) {
          return jsonResp({ error: 'Mot de passe incorrect.' }, 401);
        }
      } else {
        if (mode === 'login') {
          return jsonResp({ error: 'Aucun compte trouvé avec cet identifiant.' }, 401);
        }
        if (!rawRecoveryEmail || !isValidEmail(rawRecoveryEmail)) {
          return jsonResp(
            { error: 'Une adresse e-mail valide est obligatoire pour créer un compte (nécessaire pour la récupération du mot de passe).' },
            400
          );
        }
        const existingEmailUser = await db
          .prepare('SELECT id FROM users WHERE LOWER(recovery_email) = ? LIMIT 1')
          .bind(rawRecoveryEmail)
          .first<{ id: string }>();
        if (existingEmailUser) {
          return jsonResp({ error: 'Cette adresse e-mail est déjà associée à un autre compte.' }, 409);
        }

        // Création automatique du compte utilisateur
        const userId = `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        await db
          .prepare(
            'INSERT INTO users (id, email, display_name, password_hash, recovery_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(userId, emailKey, rawUsername, passHash, rawRecoveryEmail, now, now)
          .run();

        userRow = {
          id: userId,
          email: emailKey,
          display_name: rawUsername,
          password_hash: passHash,
          recovery_email: rawRecoveryEmail
        };
      }

      // Vérifie si un code d'invitation famille a été fourni
      let targetLibraryId: string | null = null;
      if (inviteCode) {
        const tokenRow = await db
          .prepare(
            "SELECT library_id, target_role FROM share_tokens WHERE UPPER(token) = ? AND token_type = 'invite_member' LIMIT 1"
          )
          .bind(inviteCode)
          .first<{ library_id: string; target_role: string }>();
        if (tokenRow?.library_id) {
          targetLibraryId = tokenRow.library_id;
          await db
            .prepare(
              'INSERT OR REPLACE INTO library_members (library_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
            )
            .bind(targetLibraryId, userRow.id, tokenRow.target_role || 'editor', now)
            .run();
        }
      }

      // Récupère ou crée la bibliothèque du foyer de l'utilisateur
      if (!targetLibraryId) {
        const memberRow = await db
          .prepare('SELECT library_id FROM library_members WHERE user_id = ? LIMIT 1')
          .bind(userRow.id)
          .first<{ library_id: string }>();

        if (memberRow?.library_id) {
          targetLibraryId = memberRow.library_id;
        } else {
          targetLibraryId = `lib_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
          const libName = `Bibliothèque de ${userRow.display_name}`;
          await db
            .prepare(
              'INSERT INTO libraries (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(targetLibraryId, libName, userRow.id, now, now)
            .run();
          await db
            .prepare(
              'INSERT INTO library_members (library_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
            )
            .bind(targetLibraryId, userRow.id, 'owner', now)
            .run();
        }
      }

      // Création de la session
      const rawSessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
      const tokenHash = await sha256Hex(rawSessionToken);
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

      await db
        .prepare(
          'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
        )
        .bind(tokenHash, userRow.id, expiresAt, now)
        .run();

      // Si l'utilisateur arrive depuis un QR code "Vitrine Amis", on mémorise cet ami sur son compte
      // sans jamais mélanger sa collection personnelle avec celle de son ami
      const friendToken = String(body?.friendToken || '').trim();
      let followedFriend: Record<string, unknown> | undefined;
      if (friendToken) {
        const res = await addFriendConnectionForUser(db, userRow.id, friendToken);
        if (res.ok && res.friend) {
          followedFriend = res.friend;
        }
      }

      const tokens = await getOrCreateShareTokens(db, targetLibraryId, userRow.id);
      const isHttps = url.protocol === 'https:';
      const cookieStr = `biblio_session=${rawSessionToken}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${isHttps ? '; Secure' : ''}`;

      return jsonResp(
        {
          uri: `user:${targetLibraryId}`,
          id: userRow.id,
          username: userRow.display_name,
          recoveryEmail: userRow.recovery_email || null,
          isAdmin: Boolean(userRow.is_admin),
          libraryId: targetLibraryId,
          sessionToken: rawSessionToken,
          inviteCode: tokens.inviteCode,
          publicReadonlyToken: tokens.publicReadonlyToken,
          ...(followedFriend ? { followedFriend } : {})
        },
        200,
        { 'Set-Cookie': cookieStr }
      );
    }

    case 'user-get': {
      const auth = await resolveAuthSession(db, request, url.searchParams.get('uri'));
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }
      const userDetails = await db
        .prepare('SELECT recovery_email, is_admin FROM users WHERE id = ? LIMIT 1')
        .bind(auth.userId)
        .first<{ recovery_email?: string | null; is_admin?: number }>();
      const tokens = await getOrCreateShareTokens(db, auth.libraryId, auth.userId);
      const members = await db
        .prepare(
          `SELECT u.display_name as username, lm.role, lm.joined_at
           FROM library_members lm
           JOIN users u ON u.id = lm.user_id
           WHERE lm.library_id = ?`
        )
        .bind(auth.libraryId)
        .all<{ username: string; role: string; joined_at: string }>();

      return jsonResp({
        uri: `user:${auth.libraryId}`,
        id: auth.userId,
        username: auth.username,
        recoveryEmail: userDetails?.recovery_email || null,
        isAdmin: Boolean(userDetails?.is_admin),
        libraryId: auth.libraryId,
        libraryName: auth.libraryName,
        role: auth.role,
        inviteCode: tokens.inviteCode,
        publicReadonlyToken: tokens.publicReadonlyToken,
        members: members.results || []
      });
    }

    case 'profile-update': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }

      const newUsername = String(body?.username || '').trim();
      const newRecoveryEmail = String(body?.recoveryEmail || '').trim().toLowerCase();
      const currentPassword = String(body?.currentPassword || '');
      const newPassword = String(body?.newPassword || '');

      if (!newUsername) {
        return jsonResp({ error: "Le nom d'utilisateur est obligatoire." }, 400);
      }
      if (!newRecoveryEmail || !isValidEmail(newRecoveryEmail)) {
        return jsonResp({ error: 'Une adresse e-mail de récupération valide est obligatoire.' }, 400);
      }

      const newEmailKey = newUsername.toLowerCase();
      const conflictUsername = await db
        .prepare('SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1')
        .bind(newEmailKey, auth.userId)
        .first<{ id: string }>();
      if (conflictUsername) {
        return jsonResp({ error: "Ce nom d'utilisateur est déjà utilisé par un autre compte." }, 409);
      }

      const conflictEmail = await db
        .prepare('SELECT id FROM users WHERE LOWER(recovery_email) = ? AND id != ? LIMIT 1')
        .bind(newRecoveryEmail, auth.userId)
        .first<{ id: string }>();
      if (conflictEmail) {
        return jsonResp({ error: 'Cette adresse e-mail est déjà associée à un autre compte.' }, 409);
      }

      let nextPassHash: string | null = null;
      if (newPassword) {
        if (newPassword.length < 4) {
          return jsonResp({ error: 'Le nouveau mot de passe doit contenir au moins 4 caractères.' }, 400);
        }
        const existingUser = await db
          .prepare('SELECT password_hash FROM users WHERE id = ? LIMIT 1')
          .bind(auth.userId)
          .first<{ password_hash: string }>();
        const currentHash = await sha256Hex(`biblio_salt_v2:${currentPassword}`);
        if (!existingUser || existingUser.password_hash !== currentHash) {
          return jsonResp({ error: 'Le mot de passe actuel est incorrect.' }, 401);
        }
        nextPassHash = await sha256Hex(`biblio_salt_v2:${newPassword}`);
      }

      if (nextPassHash) {
        await db
          .prepare(
            'UPDATE users SET email = ?, display_name = ?, recovery_email = ?, password_hash = ?, updated_at = ? WHERE id = ?'
          )
          .bind(newEmailKey, newUsername, newRecoveryEmail, nextPassHash, now, auth.userId)
          .run();
      } else {
        await db
          .prepare(
            'UPDATE users SET email = ?, display_name = ?, recovery_email = ?, updated_at = ? WHERE id = ?'
          )
          .bind(newEmailKey, newUsername, newRecoveryEmail, now, auth.userId)
          .run();
      }

      return jsonResp({
        ok: true,
        username: newUsername,
        recoveryEmail: newRecoveryEmail
      });
    }

    case 'auth-forgot-password': {
      const identifier = String(body?.identifier || '').trim().toLowerCase();
      if (!identifier) {
        return jsonResp({ error: "Veuillez saisir votre nom d'utilisateur ou adresse e-mail." }, 400);
      }

      const userRow = await db
        .prepare(
          'SELECT id, display_name, recovery_email FROM users WHERE email = ? OR LOWER(recovery_email) = ? LIMIT 1'
        )
        .bind(identifier, identifier)
        .first<{ id: string; display_name: string; recovery_email?: string | null }>();

      if (!userRow) {
        return jsonResp({ error: 'Aucun compte trouvé avec cet identifiant ou cette adresse e-mail.' }, 404);
      }

      if (!userRow.recovery_email || !isValidEmail(userRow.recovery_email)) {
        return jsonResp(
          {
            error:
              "Aucune adresse e-mail de récupération n'est enregistrée sur ce compte. Connectez-vous et ajoutez-la dans votre page Profil."
          },
          400
        );
      }

      const code = generateNumericCode(6);
      const tokenHash = await sha256Hex(`biblio_reset_v2:${code}`);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      await db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(userRow.id).run();
      await db
        .prepare(
          'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)'
        )
        .bind(tokenHash, userRow.id, expiresAt, now)
        .run();

      const resendApiKey = env?.RESEND_API_KEY;
      if (!resendApiKey) {
        return jsonResp(
          {
            error:
              "L'envoi d'e-mails de récupération n'est pas encore configuré sur le serveur (variable RESEND_API_KEY manquante dans Cloudflare Pages)."
          },
          503
        );
      }

      const mailFrom = env?.MAIL_FROM || 'Biblio Collection <onboarding@resend.dev>';
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: mailFrom,
          to: [userRow.recovery_email],
          subject: 'Biblio Collection — Code de réinitialisation de mot de passe',
          html: `<p>Bonjour ${userRow.display_name},</p><p>Voici votre code de réinitialisation (valable 15 minutes) :</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${code}</p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>`
        })
      });

      if (!emailRes.ok) {
        return jsonResp(
          { error: "Impossible d'envoyer l'e-mail de récupération pour le moment." },
          502
        );
      }

      return jsonResp({
        ok: true,
        maskedEmail: maskEmail(userRow.recovery_email)
      });
    }

    case 'auth-reset-password': {
      const identifier = String(body?.identifier || '').trim().toLowerCase();
      const code = String(body?.code || '').trim();
      const newPassword = String(body?.newPassword || '');

      if (!identifier || !code || !newPassword) {
        return jsonResp({ error: 'Identifiant, code et nouveau mot de passe requis.' }, 400);
      }
      if (newPassword.length < 4) {
        return jsonResp({ error: 'Le nouveau mot de passe doit contenir au moins 4 caractères.' }, 400);
      }

      const userRow = await db
        .prepare(
          'SELECT id FROM users WHERE email = ? OR LOWER(recovery_email) = ? LIMIT 1'
        )
        .bind(identifier, identifier)
        .first<{ id: string }>();

      if (!userRow) {
        return jsonResp({ error: 'Compte introuvable.' }, 404);
      }

      const tokenHash = await sha256Hex(`biblio_reset_v2:${code}`);
      const tokenRow = await db
        .prepare(
          'SELECT token_hash, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ? AND user_id = ? LIMIT 1'
        )
        .bind(tokenHash, userRow.id)
        .first<{ token_hash: string; expires_at: string; used_at: string | null }>();

      if (!tokenRow || tokenRow.used_at || tokenRow.expires_at <= now) {
        return jsonResp({ error: 'Code invalide ou expiré.' }, 400);
      }

      const nextPassHash = await sha256Hex(`biblio_salt_v2:${newPassword}`);
      await db
        .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .bind(nextPassHash, now, userRow.id)
        .run();

      await db
        .prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?')
        .bind(now, tokenHash)
        .run();

      await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userRow.id).run();

      return jsonResp({ ok: true });
    }

    case 'auth-logout': {
      const cookieHeader = request.headers.get('Cookie') || '';
      const match = /(?:^|;\s*)biblio_session=([^;]+)/.exec(cookieHeader);
      if (match?.[1]) {
        const tokenHash = await sha256Hex(match[1]);
        await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
      }
      const isHttps = url.protocol === 'https:';
      const clearCookie = `biblio_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${isHttps ? '; Secure' : ''}`;
      return jsonResp({ ok: true }, 200, { 'Set-Cookie': clearCookie });
    }

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

    case 'vision-status': {
      const auth = await resolveAuthSession(db, request, url.searchParams.get('uri'));
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }
      const currentMonthKey = now.slice(0, 7);
      const [usageRow, userCountRow] = await Promise.all([
        db
          .prepare('SELECT total_used, month_key, month_used FROM user_ai_usage WHERE user_id = ? LIMIT 1')
          .bind(auth.userId)
          .first<{ total_used: number; month_key: string; month_used: number }>(),
        db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>()
      ]);

      const monthlyQuota = computeMonthlyAiQuota(userCountRow?.cnt || 1);
      const totalUsed = usageRow?.total_used || 0;
      const monthUsed = usageRow?.month_key === currentMonthKey ? usageRow.month_used : 0;
      const remainingQuota = Math.max(0, monthlyQuota - monthUsed);

      return jsonResp({
        serverAvailable: Boolean(env?.GEMINI_API_KEY),
        totalUsed,
        monthUsed,
        monthlyQuota,
        remainingQuota
      });
    }

    case 'vision-analyze': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) {
        return jsonResp({ error: 'Session invalide' }, 401);
      }
      const geminiKey = env?.GEMINI_API_KEY;
      if (!geminiKey) {
        return jsonResp({ error: 'Service de reconnaissance IA temporairement indisponible.' }, 503);
      }

      const imageBase64 = String(body?.imageBase64 || '').trim();
      const mimeType = String(body?.mimeType || 'image/webp').trim();
      const mode = body?.mode === 'cover' ? 'cover' : 'shelf';
      if (!imageBase64) {
        return jsonResp({ error: 'Image manquante.' }, 400);
      }

      const currentMonthKey = now.slice(0, 7);
      const [usageRow, userCountRow] = await Promise.all([
        db
          .prepare('SELECT total_used, month_key, month_used FROM user_ai_usage WHERE user_id = ? LIMIT 1')
          .bind(auth.userId)
          .first<{ total_used: number; month_key: string; month_used: number }>(),
        db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>()
      ]);

      const monthlyQuota = computeMonthlyAiQuota(userCountRow?.cnt || 1);
      const totalUsed = usageRow?.total_used || 0;
      const monthUsed = usageRow?.month_key === currentMonthKey ? usageRow.month_used : 0;

      if (monthUsed >= monthlyQuota) {
        return jsonResp(
          {
            error: `Quota mensuel d'analyses IA atteint (${monthlyQuota} photos ce mois-ci). Il sera renouvelé le mois prochain.`
          },
          429
        );
      }

      const prompt = buildVisionPrompt(mode);
      let rawText: string | null = null;
      let lastStatus = 0;
      let lastBody = '';

      for (const modelId of PREFERRED_GEMINI_MODELS.slice(0, 4)) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: imageBase64 } }
                  ]
                }
              ],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json'
              }
            })
          }
        );

        if (res.ok) {
          const json = (await res.json()) as any;
          rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
          break;
        }
        lastStatus = res.status;
        lastBody = await res.text().catch(() => '');
        if (lastStatus !== 404 && lastStatus !== 429 && lastStatus < 500) {
          break;
        }
      }

      if (rawText === null) {
        return jsonResp(
          {
            error:
              lastStatus === 429
                ? 'Serveur IA temporairement saturé (quota gratuit). Réessayez dans un instant ou utilisez votre clé personnelle.'
                : `Erreur API Gemini serveur (${lastStatus}): ${lastBody.slice(0, 140)}`
          },
          lastStatus === 429 ? 429 : 502
        );
      }

      const nextTotal = totalUsed + 1;
      const nextMonthUsed = monthUsed + 1;
      await db
        .prepare(
          `INSERT INTO user_ai_usage (user_id, total_used, month_key, month_used, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             total_used = excluded.total_used,
             month_key = excluded.month_key,
             month_used = excluded.month_used,
             updated_at = excluded.updated_at`
        )
        .bind(auth.userId, nextTotal, currentMonthKey, nextMonthUsed, now)
        .run();

      const remainingQuota = Math.max(0, monthlyQuota - nextMonthUsed);

      return jsonResp({ text: rawText, monthlyQuota, remainingQuota });
    }

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
          `SELECT uri, entity_type, label, image_url, main_category, series_uri, series_number, publisher, publication_date, updated_at
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
          publisher: string | null;
          publication_date: string | null;
          updated_at: string;
        }>();

      return jsonResp({
        items: rows.results || [],
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
        .prepare(
          `UPDATE user_ai_usage SET month_used = 0, month_key = ?, updated_at = ? WHERE user_id = ?`
        )
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

    case 'family-join': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      const inviteCode = String(body?.inviteCode || '').trim().toUpperCase();
      if (!auth || !inviteCode) {
        return jsonResp({ error: 'Code famille requis' }, 400);
      }
      const tokenRow = await db
        .prepare(
          "SELECT library_id, target_role FROM share_tokens WHERE UPPER(token) = ? AND token_type = 'invite_member' LIMIT 1"
        )
        .bind(inviteCode)
        .first<{ library_id: string; target_role: string }>();

      if (!tokenRow?.library_id) {
        return jsonResp({ error: 'Code famille introuvable ou expiré.' }, 404);
      }

      // Bascule l'utilisateur sur la bibliothèque partagée
      await db
        .prepare('DELETE FROM library_members WHERE user_id = ?')
        .bind(auth.userId)
        .run();
      await db
        .prepare(
          'INSERT INTO library_members (library_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
        )
        .bind(tokenRow.library_id, auth.userId, tokenRow.target_role || 'editor', now)
        .run();

      const tokens = await getOrCreateShareTokens(db, tokenRow.library_id, auth.userId);
      return jsonResp({
        ok: true,
        uri: `user:${tokenRow.library_id}`,
        libraryId: tokenRow.library_id,
        inviteCode: tokens.inviteCode,
        publicReadonlyToken: tokens.publicReadonlyToken
      });
    }

    case 'public-share-get': {
      const shareToken = extractShareToken(String(url.searchParams.get('token') || ''));
      if (!shareToken) return jsonResp({ error: 'Jeton requis' }, 400);

      const tokenRow = await db
        .prepare(
          `SELECT s.library_id, s.token_type, s.token, l.name as library_name, u.display_name as owner_name
           FROM share_tokens s
           JOIN libraries l ON l.id = s.library_id
           LEFT JOIN users u ON u.id = l.owner_user_id
           WHERE UPPER(s.token) = ? LIMIT 1`
        )
        .bind(shareToken)
        .first<{ library_id: string; token_type: string; token: string; library_name: string; owner_name: string | null }>();

      if (!tokenRow) return jsonResp({ error: 'Lien de partage invalide' }, 404);

      const items = await db
        .prepare(
          `SELECT li.edition_id, li.work_id, li.ownership_status, li.location,
                  ce.label as title, ce.series_uri, se.label as series_name,
                  ce.series_number, ce.sort_order, ce.image_url, ce.main_category,
                  (SELECT COUNT(*) FROM loans ln WHERE ln.library_item_id = li.id AND ln.returned_at IS NULL AND ln.deleted_at IS NULL) as is_lent
           FROM library_items li
           LEFT JOIN catalog_entities ce ON ce.uri = COALESCE(li.edition_id, li.work_id)
           LEFT JOIN catalog_entities se ON se.uri = ce.series_uri
           WHERE li.library_id = ? AND li.deleted_at IS NULL
           ORDER BY COALESCE(se.label, ce.label) ASC, ce.sort_order ASC, ce.label ASC`
        )
        .bind(tokenRow.library_id)
        .all();

      return jsonResp({
        libraryId: tokenRow.library_id,
        libraryName: tokenRow.library_name,
        ownerName: tokenRow.owner_name || tokenRow.library_name,
        token: tokenRow.token,
        tokenType: tokenRow.token_type,
        items: items.results || []
      });
    }

    case 'friends-list': {
      const auth = await resolveAuthSession(db, request, url.searchParams.get('uri'));
      if (!auth) return jsonResp({ error: 'Session invalide' }, 401);

      const rows = await db
        .prepare(
          `SELECT fc.target_library_id as libraryId,
                  COALESCE(fc.display_label, l.name) as libraryName,
                  u.display_name as ownerName,
                  fc.share_token as shareToken,
                  fc.created_at as createdAt,
                  (SELECT COUNT(*) FROM library_items li WHERE li.library_id = fc.target_library_id AND li.ownership_status = 'owned' AND li.deleted_at IS NULL) as ownedCount,
                  (SELECT COUNT(*) FROM library_items li WHERE li.library_id = fc.target_library_id AND li.ownership_status = 'wishlist' AND li.deleted_at IS NULL) as wishlistCount
           FROM friend_connections fc
           JOIN libraries l ON l.id = fc.target_library_id
           LEFT JOIN users u ON u.id = l.owner_user_id
           WHERE fc.user_id = ?
           ORDER BY fc.created_at DESC`
        )
        .bind(auth.userId)
        .all();

      return jsonResp({ friends: rows.results || [] });
    }

    case 'friends-add': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) return jsonResp({ error: 'Session invalide' }, 401);
      const token = String(body?.token || body?.shareToken || '');
      const result = await addFriendConnectionForUser(db, auth.userId, token);
      if (!result.ok) {
        return jsonResp({ error: result.error || 'Code ami invalide.' }, 400);
      }
      return jsonResp(result);
    }

    case 'friends-remove': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth) return jsonResp({ error: 'Session invalide' }, 401);
      const targetLibraryId = String(body?.targetLibraryId || '').trim();
      if (targetLibraryId) {
        await db
          .prepare('DELETE FROM friend_connections WHERE user_id = ? AND target_library_id = ?')
          .bind(auth.userId, targetLibraryId)
          .run();
      }
      return jsonResp({ ok: true });
    }

    case 'loan-contacts-list': {
      const auth = await resolveAuthSession(db, request, url.searchParams.get('uri'));
      if (!auth) return jsonResp({ contacts: [] });

      const contactMap = new Map<string, { name: string; source: 'friend_share' | 'borrower' }>();
      const isPlaceholderContact = (name: string) => {
        const low = name.toLowerCase();
        return (
          low === 'prêt' ||
          low === 'pret' ||
          low === 'prêts' ||
          low === 'prets' ||
          low === 'ami' ||
          low === 'inconnu' ||
          low.startsWith('inconnu (') ||
          low === auth.username.toLowerCase()
        );
      };
      const addContact = (rawName: string | null | undefined, source: 'friend_share' | 'borrower') => {
        const clean = String(rawName || '').trim();
        if (!clean || isPlaceholderContact(clean)) return;
        const key = clean.toLowerCase();
        const existing = contactMap.get(key);
        if (!existing || (source === 'friend_share' && existing.source !== 'friend_share')) {
          contactMap.set(key, { name: clean, source });
        }
      };

      // 1. Amis connus par partage (bibliothèques suivies + personnes qui suivent ma bibliothèque)
      const followedOwners = await db
        .prepare(
          `SELECT u.display_name as name
           FROM friend_connections fc
           JOIN libraries l ON l.id = fc.target_library_id
           JOIN users u ON u.id = l.owner_user_id
           WHERE fc.user_id = ?`
        )
        .bind(auth.userId)
        .all<{ name: string }>();
      for (const r of followedOwners.results || []) addContact(r.name, 'friend_share');

      const followers = await db
        .prepare(
          `SELECT u.display_name as name
           FROM friend_connections fc
           JOIN users u ON u.id = fc.user_id
           WHERE fc.target_library_id = ?`
        )
        .bind(auth.libraryId)
        .all<{ name: string }>();
      for (const r of followers.results || []) addContact(r.name, 'friend_share');

      // 2. Personnes déjà enregistrées dans le carnet ou sur d'anciens prêts
      const savedContacts = await db
        .prepare('SELECT name, source FROM borrower_contacts WHERE library_id = ? ORDER BY name ASC')
        .bind(auth.libraryId)
        .all<{ name: string; source: 'friend_share' | 'borrower' }>();
      for (const r of savedContacts.results || []) {
        addContact(r.name, r.source === 'friend_share' ? 'friend_share' : 'borrower');
      }

      const prevLoans = await db
        .prepare('SELECT DISTINCT borrower_name FROM loans WHERE library_id = ? AND deleted_at IS NULL')
        .bind(auth.libraryId)
        .all<{ borrower_name: string }>();
      for (const r of prevLoans.results || []) addContact(r.borrower_name, 'borrower');

      const contacts = Array.from(contactMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name, 'fr')
      );
      return jsonResp({ contacts });
    }

    // ========================================================================
    // 2. INVENTAIRE (COLLECTION DU FOYER) DANS D1
    // ========================================================================
    case 'inventory-list': {
      const userUri = url.searchParams.get('uri');
      const auth = await resolveAuthSession(db, request, userUri);
      const libraryId =
        auth?.libraryId ||
        (userUri?.startsWith('user:') ? userUri.slice(5) : userUri) ||
        'lib_default';

      const rows = await db
        .prepare(
          `SELECT id, COALESCE(edition_id, work_id) as entity, ownership_status, location, condition, created_at
           FROM library_items
           WHERE library_id = ? AND ownership_status = 'owned' AND deleted_at IS NULL`
        )
        .bind(libraryId)
        .all<{ id: string; entity: string; ownership_status: string; location: string; created_at: string }>();

      const items = (rows.results || []).map((r) => ({
        _id: r.id,
        id: r.id,
        entity: r.entity,
        location: r.location,
        created: r.created_at
      }));

      return jsonResp({ items });
    }

    case 'inventory-add': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      const libraryId = auth?.libraryId || 'lib_default';
      const entityUri = String(body?.uri || '').trim();
      if (!entityUri) return jsonResp({ error: 'URI requise' }, 400);

      const existing = await db
        .prepare(
          "SELECT id FROM library_items WHERE library_id = ? AND (edition_id = ? OR work_id = ?) AND ownership_status = 'owned' AND deleted_at IS NULL LIMIT 1"
        )
        .bind(libraryId, entityUri, entityUri)
        .first<{ id: string }>();

      const itemId = existing?.id || `itm_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      if (!existing) {
        await db
          .prepare(
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, acquired_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'owned', ?, ?, ?)`
          )
          .bind(itemId, libraryId, entityUri, entityUri, now, now, now)
          .run();
      }

      return jsonResp({ item: { _id: itemId, entity: entityUri }, _id: itemId });
    }

    case 'inventory-bulk': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      const libraryId = auth?.libraryId || 'lib_default';
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];
      if (!uris.length) return jsonResp({ error: 'Tableau uris requis' }, 400);

      const addedItems: Array<{ uri: string; itemId: string }> = [];

      for (const rawUri of uris) {
        const entityUri = String(rawUri || '').trim();
        if (!entityUri) continue;
        const existing = await db
          .prepare(
            "SELECT id FROM library_items WHERE library_id = ? AND (edition_id = ? OR work_id = ?) AND ownership_status = 'owned' AND deleted_at IS NULL LIMIT 1"
          )
          .bind(libraryId, entityUri, entityUri)
          .first<{ id: string }>();

        if (existing?.id) {
          addedItems.push({ uri: entityUri, itemId: existing.id });
          continue;
        }

        const itemId = `itm_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        await db
          .prepare(
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, acquired_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'owned', ?, ?, ?)`
          )
          .bind(itemId, libraryId, entityUri, entityUri, now, now, now)
          .run();
        addedItems.push({ uri: entityUri, itemId });
      }

      return jsonResp({
        success: true,
        added: addedItems.length,
        addedItems,
        errors: []
      });
    }

    case 'inventory-delete': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      const libraryId = auth?.libraryId || 'lib_default';
      const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];

      for (const id of ids) {
        await db
          .prepare('DELETE FROM library_items WHERE id = ? AND library_id = ?')
          .bind(id, libraryId)
          .run();
      }
      for (const u of uris) {
        await db
          .prepare(
            'DELETE FROM library_items WHERE library_id = ? AND (edition_id = ? OR work_id = ?)'
          )
          .bind(libraryId, u, u)
          .run();
      }
      return jsonResp({ ok: true });
    }

    // ========================================================================
    // 3. WISHLIST DANS D1
    // ========================================================================
    case 'lists-by-creator': {
      const userIdParam = url.searchParams.get('userId') || '';
      const auth = await resolveAuthSession(db, request, `user:${userIdParam}`);
      const libraryId = auth?.libraryId || userIdParam || 'lib_default';
      return jsonResp({
        lists: [{ _id: `wish_${libraryId}`, name: 'Wishlist', type: 'work' }]
      });
    }

    case 'lists-create': {
      const auth = await resolveAuthSession(db, request, null);
      const libraryId = auth?.libraryId || 'lib_default';
      return jsonResp({ list: { _id: `wish_${libraryId}`, name: 'Wishlist' } });
    }

    case 'lists-get': {
      const listId = url.searchParams.get('id') || '';
      const libraryId = listId.startsWith('wish_') ? listId.slice(5) : listId || 'lib_default';
      const rows = await db
        .prepare(
          "SELECT DISTINCT COALESCE(edition_id, work_id) as uri FROM library_items WHERE library_id = ? AND ownership_status = 'wishlist' AND deleted_at IS NULL"
        )
        .bind(libraryId)
        .all<{ uri: string }>();

      const elements = (rows.results || []).map((r) => ({ uri: r.uri, element: r.uri }));
      return jsonResp({ list: { _id: listId, elements }, elements });
    }

    case 'lists-add-elements': {
      const listId = String(body?.id || '');
      const auth = await resolveAuthSession(db, request, null);
      const libraryId =
        (listId.startsWith('wish_') ? listId.slice(5) : '') || auth?.libraryId || 'lib_default';
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];

      await db.prepare('PRAGMA foreign_keys = OFF').run();
      for (const u of uris) {
        const entityUri = String(u || '').trim();
        if (!entityUri) continue;
        // Évite toute duplication dans library_items pour un même ouvrage
        await db
          .prepare(
            "DELETE FROM library_items WHERE library_id = ? AND ownership_status = 'wishlist' AND (edition_id = ? OR work_id = ?)"
          )
          .bind(libraryId, entityUri, entityUri)
          .run();
        const itemId = `wishitm_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
        await db
          .prepare(
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'wishlist', ?, ?)`
          )
          .bind(itemId, libraryId, entityUri, entityUri, now, now)
          .run();
      }
      return jsonResp({ ok: true });
    }

    case 'lists-remove-elements': {
      const listId = String(body?.id || '');
      const auth = await resolveAuthSession(db, request, null);
      const libraryId =
        (listId.startsWith('wish_') ? listId.slice(5) : '') || auth?.libraryId || 'lib_default';
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];

      for (const u of uris) {
        await db
          .prepare(
            "DELETE FROM library_items WHERE library_id = ? AND ownership_status = 'wishlist' AND (edition_id = ? OR work_id = ?)"
          )
          .bind(libraryId, u, u)
          .run();
      }
      return jsonResp({ ok: true });
    }

    // ========================================================================
    // 4. PRÊTS (SHELVES / LOANS) DANS D1
    // ========================================================================
    case 'shelves': {
      const subPath = url.searchParams.get('path') || '';
      const ownersParam = url.searchParams.get('owners') || '';
      const auth = await resolveAuthSession(db, request, ownersParam);
      const libraryId =
        auth?.libraryId ||
        (ownersParam.startsWith('user:') ? ownersParam.slice(5) : ownersParam) ||
        'lib_default';

      if (subPath === 'by-owners') {
        const rows = await db
          .prepare(
            'SELECT id, library_item_id, borrower_name, loaned_at, notes FROM loans WHERE library_id = ? AND returned_at IS NULL AND deleted_at IS NULL'
          )
          .bind(libraryId)
          .all<{
            id: string;
            library_item_id: string;
            borrower_name: string;
            loaned_at: string;
            notes: string;
          }>();

        const shelves: Record<string, any> = {};
        for (const r of rows.results || []) {
          shelves[r.id] = {
            _id: r.id,
            name: `Prêts - ${r.borrower_name}`,
            description: r.notes || String(new Date(r.loaned_at).getTime()),
            items: [r.library_item_id]
          };
        }
        return jsonResp({ shelves });
      }

      if (subPath === 'by-ids') {
        const ids = (url.searchParams.get('ids') || '').split('|').filter(Boolean);
        const shelves: Record<string, any> = {};
        for (const id of ids) {
          const r = await db
            .prepare('SELECT id, library_item_id, borrower_name, loaned_at, notes FROM loans WHERE id = ? LIMIT 1')
            .bind(id)
            .first<{
              id: string;
              library_item_id: string;
              borrower_name: string;
              loaned_at: string;
              notes: string;
            }>();
          if (r) {
            shelves[r.id] = {
              _id: r.id,
              name: `Prêts - ${r.borrower_name}`,
              description: r.notes || String(new Date(r.loaned_at).getTime()),
              items: [r.library_item_id]
            };
          }
        }
        return jsonResp({ shelves });
      }

      if (!subPath && request.method === 'POST') {
        const rawName = String(body?.name || '');
        const borrowerName = rawName.replace(/^Prêts?\s*[-:]?\s*/i, '').trim();
        const effectiveBorrower = borrowerName || 'Inconnu';
        const description = String(body?.description || Date.now());
        const items: string[] = Array.isArray(body?.items) ? body.items : [];
        const itemRef = items[0] || '';
        const loanId = `loan_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

        await db.prepare('PRAGMA foreign_keys = OFF').run();
        await db
          .prepare(
            `INSERT INTO loans (id, library_id, library_item_id, borrower_name, loaned_at, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(loanId, libraryId, itemRef, effectiveBorrower, now, description, now, now)
          .run();

        // N'enregistre le contact que s'il s'agit d'un vrai nom (pas d'un libellé générique)
        if (
          effectiveBorrower.toLowerCase() !== 'inconnu' &&
          effectiveBorrower.toLowerCase() !== 'ami' &&
          !/^prêts?$/i.test(effectiveBorrower)
        ) {
          const contactId = `cnt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
          await db
            .prepare(
              `INSERT OR IGNORE INTO borrower_contacts (id, library_id, name, source, created_at)
               VALUES (?, ?, ?, 'manual', ?)`
            )
            .bind(contactId, libraryId, effectiveBorrower, now)
            .run();
        }

        return jsonResp({
          shelf: { _id: loanId, name: `Prêts - ${effectiveBorrower}`, description, items }
        });
      }

      if (subPath === 'add-items') {
        const loanId = String(body?.id || '');
        const items: string[] = Array.isArray(body?.items) ? body.items : [];
        if (loanId && items[0]) {
          await db
            .prepare('UPDATE loans SET library_item_id = ?, updated_at = ? WHERE id = ?')
            .bind(items[0], now, loanId)
            .run();
        }
        return jsonResp({ ok: true });
      }

      if (subPath === 'remove-items' || subPath === 'delete') {
        const loanId = String(body?.id || (Array.isArray(body?.ids) ? body.ids[0] : '') || '');
        if (loanId) {
          await db
            .prepare('UPDATE loans SET returned_at = ?, updated_at = ? WHERE id = ?')
            .bind(now, now, loanId)
            .run();
        }
        return jsonResp({ ok: true });
      }

      return jsonResp({ shelves: {} });
    }

    // ========================================================================
    // 5. CATALOGUE COMMUN, ENTITÉS, RECHERCHE & SÉRIES DANS D1
    // ========================================================================
    case 'rehydrate-catalog': {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 6);
      const result = await rehydrateAllCatalogEntitiesInD1(db, { offset, limit });
      return jsonResp({ ok: true, ...result });
    }

    case 'entities-by-uris': {
      const rawUris = (url.searchParams.get('uris') || '')
        .split('|')
        .map((u) => u.trim())
        .filter(Boolean);
      const relatives = (url.searchParams.get('relatives') || '').includes('P629');
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const attributesParam = url.searchParams.get('attributes') || '';
      const wantsImage = !attributesParam || attributesParam.includes('image');

      const entities: Record<string, any> = {};

      for (const requestedUri of rawUris) {
        let row = await db
          .prepare('SELECT uri, isbn13, work_uri, image_url, entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(requestedUri)
          .first<{ uri: string; isbn13: string | null; work_uri: string | null; image_url: string | null; entity_json: string }>();

        const hasBrokenArkCover = Boolean(row?.image_url && row.image_url.includes('idArk='));

        // Si on cherche par ISBN et qu'il n'est pas encore dans D1 (ou si refresh=1 / couverture idArk cassée), auto-résolution !
        if ((!row || forceRefresh || hasBrokenArkCover) && (requestedUri.startsWith('isbn:') || row?.isbn13)) {
          const rawIsbn = requestedUri.startsWith('isbn:') ? requestedUri.slice(5) : (row?.isbn13 || '');
          const normIsbn13 = isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn)) || isbnUtil.normalize(rawIsbn);
          if (!row) {
            row = await db
              .prepare('SELECT uri, isbn13, work_uri, image_url, entity_json FROM catalog_entities WHERE isbn13 = ? OR uri = ? LIMIT 1')
              .bind(normIsbn13, `isbn:${normIsbn13}`)
              .first<{ uri: string; isbn13: string | null; work_uri: string | null; image_url: string | null; entity_json: string }>();
          }

          if (!row || forceRefresh || (row.image_url && row.image_url.includes('idArk='))) {
            if (row?.image_url && row.image_url.includes('idArk=')) {
              await db
                .prepare("UPDATE catalog_entities SET image_url = NULL WHERE uri = ? OR uri = ?")
                .bind(row.uri, row.work_uri || '')
                .run();
            }
            const autoResolved = await resolveAndStoreIsbnInD1(db, normIsbn13);
            if (autoResolved) {
              entities[requestedUri] = autoResolved;
              const workUri = (autoResolved.claims as any)?.['wdt:P629']?.[0];
              if (relatives && workUri) {
                const wRow = await db
                  .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
                  .bind(workUri)
                  .first<{ entity_json: string }>();
                if (wRow) entities[workUri] = JSON.parse(wRow.entity_json);
              }
              continue;
            }
          }
        }

        if (row) {
          const parsed = JSON.parse(row.entity_json);
          if (
            !row.image_url &&
            wantsImage &&
            (requestedUri.startsWith('isbn:') || row.isbn13)
          ) {
            const rawIsbn = row.isbn13 || (requestedUri.startsWith('isbn:') ? requestedUri.slice(5) : '');
            const normIsbn13 = isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn)) || isbnUtil.normalize(rawIsbn);
            if (normIsbn13.length === 13) {
              const repairedCover = await resolveBestCoverUrl(normIsbn13, {
                title: parsed?.label || parsed?.labels?.fr
              });
              if (repairedCover) {
                parsed.image = { url: repairedCover };
                parsed.claims = {
                  ...(parsed.claims || {}),
                  'invp:P2': [repairedCover]
                };
                await db
                  .prepare('UPDATE catalog_entities SET image_url = ?, entity_json = ? WHERE uri = ?')
                  .bind(repairedCover, JSON.stringify(parsed), row.uri)
                  .run();
                if (row.work_uri) {
                  await db
                    .prepare("UPDATE catalog_entities SET image_url = COALESCE(image_url, ?) WHERE uri = ?")
                    .bind(repairedCover, row.work_uri)
                    .run();
                }
              }
            }
          }
          entities[requestedUri] = parsed;
          if (relatives && row.work_uri) {
            const wRow = await db
              .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
              .bind(row.work_uri)
              .first<{ entity_json: string }>();
            if (wRow) entities[row.work_uri] = JSON.parse(wRow.entity_json);
          }
        }
      }

      return jsonResp({ entities });
    }

    case 'entities-create': {
      const claims = { ...((body?.claims || {}) as Record<string, any[]>) };
      const label =
        body?.labels?.fr ||
        body?.labels?.en ||
        body?.label ||
        claims['wdt:P1476']?.[0] ||
        'Sans titre';

      const p31 = claims['wdt:P31']?.[0];
      const isbn13 = claims['wdt:P212']?.[0]
        ? isbnUtil.normalize(String(claims['wdt:P212'][0]))
        : undefined;
      const workUri = claims['wdt:P629']?.[0] ? String(claims['wdt:P629'][0]) : undefined;
      const seriesUri = claims['wdt:P179']?.[0] ? String(claims['wdt:P179'][0]) : undefined;
      const seriesNumber = claims['wdt:P1545']?.[0]
        ? normalizeSeriesNumber(String(claims['wdt:P1545'][0]))
        : undefined;
      const authorUris: string[] = Array.isArray(claims['wdt:P50'])
        ? claims['wdt:P50'].map(String)
        : [];
      const imageUrl = claims['invp:P2']?.[0] || claims['wdt:P18']?.[0] || body?.imageUrl;

      let entityType: 'edition' | 'work' | 'serie' | 'human' = 'work';
      if (isbn13 || workUri) entityType = 'edition';
      else if (p31 === 'wd:Q277759' || p31 === 'wd:Q14406742') entityType = 'serie';
      else if (p31 === 'wd:Q5') entityType = 'human';

      const publisherLabel = typeof body?.publisher === 'string' ? body.publisher.trim() : '';
      if (publisherLabel && !claims['wdt:P123']?.length) {
        const pubUri = await upsertCatalogEntity(db, {
          entityType: 'publisher',
          label: publisherLabel,
          claims: {}
        });
        claims['wdt:P123'] = [pubUri];
      }

      const providedGenres: string[] = Array.isArray(body?.genres)
        ? body.genres.map((g: unknown) => String(g).trim()).filter(Boolean)
        : [];

      let mainCategory: string;
      let subgenres: string[];
      if (providedGenres.length > 0) {
        const gUris: string[] = [];
        for (const gLabel of providedGenres) {
          const gUri = await upsertCatalogEntity(db, {
            entityType: 'genre',
            label: gLabel,
            claims: {}
          });
          gUris.push(gUri);
        }
        claims['wdt:P136'] = gUris;
        mainCategory = providedGenres[0];
        subgenres = providedGenres.slice(1);
      } else {
        const classification = classifyBookMetadata({
          title: String(label),
          series: seriesUri ? String(label) : undefined,
          publisher: publisherLabel || undefined
        });
        mainCategory = classification.mainCategory;
        subgenres = classification.subgenres;
      }

      const createdUri = await upsertCatalogEntity(db, {
        entityType,
        label: String(label),
        isbn13,
        workUri,
        seriesUri,
        seriesNumber,
        authorUris,
        mainCategory,
        subgenres,
        imageUrl: imageUrl ? String(imageUrl) : undefined,
        descriptions:
          body?.descriptions && typeof body.descriptions === 'object' ? body.descriptions : {},
        claims
      });

      return jsonResp({
        uri: createdUri,
        entity: { uri: createdUri, labels: { fr: label }, claims }
      });
    }

    case 'entities-update-claim': {
      const uri = String(body?.uri || '').trim();
      const property = String(body?.property || '').trim();
      const newValue = body?.['new-value'] !== undefined ? body['new-value'] : body?.newValue;
      if (!uri || !property) return jsonResp({ error: 'uri et property requis' }, 400);

      const row = await db
        .prepare('SELECT * FROM catalog_entities WHERE uri = ? LIMIT 1')
        .bind(uri)
        .first<Record<string, any>>();

      if (!row) return jsonResp({ ok: true });

      const entityObj = JSON.parse(row.entity_json);
      entityObj.claims = entityObj.claims || {};
      if (newValue === null || newValue === undefined || newValue === '') {
        delete entityObj.claims[property];
      } else {
        entityObj.claims[property] = Array.isArray(newValue) ? newValue : [newValue];
      }

      const seriesUri =
        property === 'wdt:P179' ? (newValue ? String(newValue) : null) : row.series_uri;
      const seriesNumber =
        property === 'wdt:P1545'
          ? newValue
            ? normalizeSeriesNumber(String(newValue))
            : null
          : row.series_number;
      const sortOrder =
        seriesNumber && /^\d+(\.\d+)?$/.test(seriesNumber)
          ? parseFloat(seriesNumber)
          : row.sort_order;

      await db
        .prepare(
          'UPDATE catalog_entities SET series_uri = ?, series_number = ?, sort_order = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
        )
        .bind(seriesUri, seriesNumber, sortOrder, JSON.stringify(entityObj), now, uri)
        .run();

      return jsonResp({ ok: true });
    }

    case 'entities-update-label': {
      const uri = String(body?.uri || '').trim();
      const value = String(body?.value || '').trim();
      if (!uri || !value) return jsonResp({ error: 'uri et value requis' }, 400);

      const row = await db
        .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
        .bind(uri)
        .first<{ entity_json: string }>();

      if (row) {
        const entityObj = JSON.parse(row.entity_json);
        entityObj.label = value;
        entityObj.labels = { ...(entityObj.labels || {}), fr: value, en: value };
        await db
          .prepare(
            'UPDATE catalog_entities SET label = ?, normalized_label = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
          )
          .bind(value, normalizeTextKey(value), JSON.stringify(entityObj), now, uri)
          .run();
      }
      return jsonResp({ ok: true });
    }

    case 'entities-update-genres': {
      const targetUris = new Set(
        [String(body?.uri || '').trim(), String(body?.workUri || '').trim()].filter(Boolean)
      );
      const cleanGenres: string[] = Array.isArray(body?.genres)
        ? body.genres.map((g: unknown) => String(g).trim()).filter(Boolean)
        : [];
      if (targetUris.size === 0) return jsonResp({ error: 'uri requis' }, 400);

      let resolvedSeriesUri = String(body?.seriesUri || '').trim();
      if (!resolvedSeriesUri) {
        for (const u of targetUris) {
          const sLookup = await db
            .prepare('SELECT series_uri FROM catalog_entities WHERE uri = ? AND series_uri IS NOT NULL LIMIT 1')
            .bind(u)
            .first<{ series_uri: string | null }>();
          if (sLookup?.series_uri) {
            resolvedSeriesUri = sLookup.series_uri;
            break;
          }
        }
      }

      if (resolvedSeriesUri && body?.propagateSeries !== false) {
        targetUris.add(resolvedSeriesUri);
        const seriesRows = await db
          .prepare('SELECT uri FROM catalog_entities WHERE series_uri = ?')
          .bind(resolvedSeriesUri)
          .all<{ uri: string }>();
        for (const sr of seriesRows.results || []) {
          if (sr.uri) targetUris.add(sr.uri);
        }
      }

      const genreUris: string[] = [];
      for (const gLabel of cleanGenres) {
        const gUri = await upsertCatalogEntity(db, {
          entityType: 'genre',
          label: gLabel,
          claims: {}
        });
        genreUris.push(gUri);
      }

      const mainCategory = cleanGenres[0] || 'Autre';
      const subgenres = cleanGenres.slice(1);
      const subgenresJson = JSON.stringify(subgenres);

      for (const targetUri of targetUris) {
        const row = await db
          .prepare('SELECT entity_json FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(targetUri)
          .first<{ entity_json: string }>();
        if (!row) continue;

        const entityObj = JSON.parse(row.entity_json);
        entityObj.claims = entityObj.claims || {};
        entityObj.mainCategory = mainCategory;
        entityObj.subgenres = subgenres;
        if (genreUris.length > 0) {
          entityObj.claims['wdt:P136'] = genreUris;
        } else {
          delete entityObj.claims['wdt:P136'];
        }

        await db
          .prepare(
            'UPDATE catalog_entities SET main_category = ?, subgenres_json = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
          )
          .bind(mainCategory, subgenresJson, JSON.stringify(entityObj), now, targetUri)
          .run();
      }

      return jsonResp({
        ok: true,
        genres: cleanGenres,
        genreUris,
        propagatedSeriesUri: resolvedSeriesUri || null
      });
    }

    case 'entities-patch': {
      const editionUri = String(body?.editionUri || '').trim();
      const workUri = String(body?.workUri || '').trim();
      if (!editionUri) return jsonResp({ error: 'editionUri requis' }, 400);

      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      const seriesUri = typeof body?.seriesUri === 'string' ? body.seriesUri.trim() : '';
      const rawSeriesNumber =
        typeof body?.seriesNumber === 'string' ? body.seriesNumber.trim() : '';
      const seriesNumber = rawSeriesNumber ? normalizeSeriesNumber(rawSeriesNumber) : null;
      const sortOrder =
        seriesNumber && /^\d+(\.\d+)?$/.test(seriesNumber) ? parseFloat(seriesNumber) : 1000.0;
      const authorUris: string[] | null = Array.isArray(body?.authorUris)
        ? body.authorUris.map(String).filter(Boolean)
        : null;
      const publisherLabel =
        typeof body?.publisher === 'string' ? body.publisher.trim() : undefined;
      const publishDate =
        typeof body?.publishDate === 'string' ? body.publishDate.trim() : undefined;
      const pageCount =
        body?.pageCount !== undefined && body?.pageCount !== null && body?.pageCount !== ''
          ? Number(body.pageCount)
          : undefined;
      const coverUrl =
        typeof body?.coverUrl === 'string' ? body.coverUrl.trim() : undefined;

      let publisherUri: string | null | undefined = undefined;
      if (publisherLabel !== undefined) {
        publisherUri = publisherLabel
          ? await upsertCatalogEntity(db, {
              entityType: 'publisher',
              label: publisherLabel,
              claims: {}
            })
          : null;
      }

      const targetEntries: Array<{ uri: string; isEdition: boolean }> = [
        { uri: editionUri, isEdition: true }
      ];
      if (workUri && workUri !== editionUri) {
        targetEntries.push({ uri: workUri, isEdition: false });
      }

      for (const entry of targetEntries) {
        const row = await db
          .prepare('SELECT * FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(entry.uri)
          .first<Record<string, any>>();
        if (!row) continue;

        const entityObj = JSON.parse(row.entity_json);
        entityObj.claims = entityObj.claims || {};

        if (title) {
          entityObj.label = title;
          entityObj.labels = { ...(entityObj.labels || {}), fr: title, en: title };
          if (entry.isEdition) entityObj.claims['wdt:P1476'] = [title];
        }
        if (seriesUri) {
          entityObj.claims['wdt:P179'] = [seriesUri];
        } else if (body?.seriesUri === '') {
          delete entityObj.claims['wdt:P179'];
        }
        if (seriesNumber) {
          entityObj.claims['wdt:P1545'] = [seriesNumber];
        } else if (body?.seriesNumber === '') {
          delete entityObj.claims['wdt:P1545'];
        }
        if (authorUris) {
          if (authorUris.length > 0) entityObj.claims['wdt:P50'] = authorUris;
          else delete entityObj.claims['wdt:P50'];
        }

        if (entry.isEdition) {
          if (publisherUri) entityObj.claims['wdt:P123'] = [publisherUri];
          else if (publisherUri === null) delete entityObj.claims['wdt:P123'];

          if (publishDate) entityObj.claims['wdt:P577'] = [publishDate];
          else if (publishDate === '') delete entityObj.claims['wdt:P577'];

          if (pageCount && Number.isFinite(pageCount) && pageCount > 0) {
            entityObj.claims['wdt:P1104'] = [pageCount];
          } else if (body?.pageCount === null || body?.pageCount === '') {
            delete entityObj.claims['wdt:P1104'];
          }
        }

        let nextImageUrl = row.image_url;
        if (coverUrl !== undefined) {
          const isDataUrl = coverUrl.startsWith('data:');
          if (!coverUrl) {
            nextImageUrl = null;
            delete entityObj.image;
            delete entityObj.claims['invp:P2'];
          } else if (!isDataUrl) {
            nextImageUrl = coverUrl;
            entityObj.image = { url: coverUrl, value: coverUrl };
            entityObj.claims['invp:P2'] = [coverUrl];
          }
        }

        const finalLabel = title || row.label;
        const finalWorkUri =
          entry.isEdition && workUri ? workUri : row.work_uri;
        const finalSeriesUri =
          body?.seriesUri !== undefined ? (seriesUri || null) : row.series_uri;
        const finalSeriesNumber =
          body?.seriesNumber !== undefined ? seriesNumber : row.series_number;
        const finalSortOrder =
          body?.seriesNumber !== undefined ? sortOrder : row.sort_order;
        const finalAuthorJson = authorUris ? JSON.stringify(authorUris) : row.author_uris_json;

        await db
          .prepare(
            `UPDATE catalog_entities
             SET label = ?, normalized_label = ?, work_uri = ?, series_uri = ?, series_number = ?, sort_order = ?,
                 author_uris_json = ?, image_url = ?, entity_json = ?, updated_at = ?
             WHERE uri = ?`
          )
          .bind(
            finalLabel,
            normalizeTextKey(finalLabel),
            finalWorkUri,
            finalSeriesUri,
            finalSeriesNumber,
            finalSortOrder,
            finalAuthorJson,
            nextImageUrl,
            JSON.stringify(entityObj),
            now,
            entry.uri
          )
          .run();
      }

      return jsonResp({ ok: true });
    }

    case 'reverse-claims':
    case 'series-list': {
      const property =
        action === 'series-list' ? 'wdt:P179' : String(url.searchParams.get('property') || '');
      const value =
        action === 'series-list'
          ? String(url.searchParams.get('seriesId') || '')
          : String(url.searchParams.get('value') || '');

      if (!value) return jsonResp({ uris: [] });

      if (property === 'wdt:P179') {
        const sRow = await db
          .prepare('SELECT entity_json, series_checked_at FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(value)
          .first<{ entity_json: string | null; series_checked_at?: string | null }>();

        let isAlreadyExpanded = false;
        if (sRow?.entity_json) {
          try {
            const parsedS = JSON.parse(sRow.entity_json);
            isAlreadyExpanded = parsedS?.claims?.['invp:bnfExpanded']?.[0] === 'true';
          } catch {
            isAlreadyExpanded = false;
          }
        }

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const isCheckStale = !sRow?.series_checked_at || sRow.series_checked_at < sevenDaysAgo;

        let rows = await db
          .prepare(
            "SELECT uri FROM catalog_entities WHERE series_uri = ? AND entity_type = 'work' ORDER BY sort_order ASC, label ASC"
          )
          .bind(value)
          .all<{ uri: string }>();

        // Si la série n'a pas encore été expansée via BnF (ou a moins de 2 tomes en base D1, ou n'a pas été vérifiée depuis 7 jours),
        // on déclenche automatiquement l'expansion relationnelle BnF (460$3 / bib.ens2bib / bib.recordtype="ens").
        if (!isAlreadyExpanded || (rows.results || []).length < 2 || isCheckStale) {
          await expandSeriesVolumesInD1(db, value);
          rows = await db
            .prepare(
              "SELECT uri FROM catalog_entities WHERE series_uri = ? AND entity_type = 'work' ORDER BY sort_order ASC, label ASC"
            )
            .bind(value)
            .all<{ uri: string }>();
        }

        return jsonResp({ uris: (rows.results || []).map((r) => r.uri) });
      }

      if (property === 'wdt:P629') {
        const rows = await db
          .prepare(
            "SELECT uri FROM catalog_entities WHERE work_uri = ? AND entity_type = 'edition' ORDER BY updated_at DESC"
          )
          .bind(value)
          .all<{ uri: string }>();
        return jsonResp({ uris: (rows.results || []).map((r) => r.uri) });
      }

      return jsonResp({ uris: [] });
    }

    case 'author-works': {
      const authorUri = String(url.searchParams.get('authorUri') || '');
      const rows = await db
        .prepare(
          "SELECT uri, series_uri FROM catalog_entities WHERE author_uris_json LIKE ? AND entity_type = 'work'"
        )
        .bind(`%${authorUri}%`)
        .all<{ uri: string; series_uri: string | null }>();

      const works = (rows.results || []).map((r) => ({ uri: r.uri }));
      const seriesSet = new Set(
        (rows.results || []).map((r) => r.series_uri).filter(Boolean) as string[]
      );
      return jsonResp({
        works,
        series: Array.from(seriesSet).map((uri) => ({ uri })),
        articles: []
      });
    }

    case 'search-text': {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return jsonResp({ results: [] });
      const normQ = `%${normalizeTextKey(q)}%`;

      const localRows = await db
        .prepare(
          `SELECT uri, entity_type, label, image_url
           FROM catalog_entities
           WHERE normalized_label LIKE ? AND entity_type IN ('work', 'serie', 'human', 'edition')
           ORDER BY CASE entity_type WHEN 'serie' THEN 1 WHEN 'work' THEN 2 WHEN 'edition' THEN 3 ELSE 4 END
           LIMIT 30`
        )
        .bind(normQ)
        .all<{ uri: string; entity_type: string; label: string; image_url: string | null }>();

      const results = (localRows.results || []).map((r) => ({
        uri: r.uri,
        type: r.entity_type === 'serie' ? 'series' : r.entity_type === 'work' ? 'works' : r.entity_type === 'human' ? 'humans' : 'works',
        label: r.label,
        image: r.image_url || undefined
      }));

      // Si peu de résultats en D1, on enrichit à la volée avec Google Books pour que la recherche par mots-clés ou auteur trouve n'importe quel livre !
      if (results.length < 5 && q.length >= 3) {
        try {
          const gbRes = await fetch(
            `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8`
          );
          if (gbRes.ok) {
            const gbData = await gbRes.json();
            for (const item of gbData.items || []) {
              const info = item.volumeInfo;
              const identifiers: Array<{ type: string; identifier: string }> =
                info?.industryIdentifiers || [];
              const isbn13 =
                identifiers.find((id) => id.type === 'ISBN_13')?.identifier ||
                isbnUtil.toIsbn13(
                  identifiers.find((id) => id.type === 'ISBN_10')?.identifier || ''
                );
              if (isbn13 && info?.title) {
                const uri = `isbn:${isbn13}`;
                if (!results.some((r) => r.uri === uri)) {
                  const thumb = (
                    info.imageLinks?.thumbnail ||
                    info.imageLinks?.smallThumbnail ||
                    ''
                  ).replace(/^http:\/\//i, 'https://');
                  results.push({
                    uri,
                    type: 'works',
                    label: `${info.title}${info.authors?.length ? ' — ' + info.authors[0] : ''}`,
                    image: thumb || undefined
                  });
                }
              }
            }
          }
        } catch {
          // Ignore erreur réseau externe
        }
      }

      return jsonResp({ results });
    }

    // ========================================================================
    // 6. RATTACHEMENT HORS-SÉRIE & FUSION DE SÉRIES EN 1 CLIC
    // ========================================================================
    case 'series-merge': {
      const targetSeriesTitle = String(body?.targetSeriesTitle || '').trim();
      const targetSeriesIdInput = String(body?.targetSeriesId || '').trim();
      const sourceSeriesId = String(body?.sourceSeriesId || '').trim();
      const bookUris: string[] = Array.isArray(body?.bookUris) ? body.bookUris : [];
      const customVolumeLabel =
        body?.volumeLabel !== undefined ? String(body.volumeLabel).trim() : undefined;
      const customSortOrder =
        body?.sortOrder !== undefined ? Number(body.sortOrder) : undefined;

      if (!targetSeriesTitle && !targetSeriesIdInput) {
        return jsonResp({ error: 'Série cible requise' }, 400);
      }

      let finalSeriesUri = targetSeriesIdInput;
      let finalSeriesLabel = targetSeriesTitle;

      if (!finalSeriesUri && finalSeriesLabel) {
        finalSeriesUri = await upsertCatalogEntity(db, {
          entityType: 'serie',
          label: finalSeriesLabel,
          claims: { 'wdt:P31': ['wd:Q277759'] }
        });
      } else if (finalSeriesUri && !finalSeriesLabel) {
        const sRow = await db
          .prepare('SELECT label FROM catalog_entities WHERE uri = ? LIMIT 1')
          .bind(finalSeriesUri)
          .first<{ label: string }>();
        finalSeriesLabel = sRow?.label || 'Série';
      }

      // Si on fusionne toute une série source vers la série cible
      if (sourceSeriesId && sourceSeriesId !== finalSeriesUri) {
        const sourceWorks = await db
          .prepare('SELECT uri, entity_json FROM catalog_entities WHERE series_uri = ?')
          .bind(sourceSeriesId)
          .all<{ uri: string; entity_json: string }>();

        for (const w of sourceWorks.results || []) {
          const obj = JSON.parse(w.entity_json);
          obj.claims = obj.claims || {};
          obj.claims['wdt:P179'] = [finalSeriesUri];
          await db
            .prepare(
              'UPDATE catalog_entities SET series_uri = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
            )
            .bind(finalSeriesUri, JSON.stringify(obj), now, w.uri)
            .run();
        }
      }

      // Rattachement des livres / hors-séries sélectionnés
      for (const bUri of bookUris) {
        const row = await db
          .prepare('SELECT uri, work_uri, series_number, sort_order, entity_json FROM catalog_entities WHERE uri = ? OR work_uri = ?')
          .bind(bUri, bUri)
          .all<{
            uri: string;
            work_uri: string | null;
            series_number: string | null;
            sort_order: number;
            entity_json: string;
          }>();

        for (const r of row.results || []) {
          const obj = JSON.parse(r.entity_json);
          obj.claims = obj.claims || {};
          obj.claims['wdt:P179'] = [finalSeriesUri];
          const volLabel =
            customVolumeLabel !== undefined ? customVolumeLabel : r.series_number;
          if (volLabel) {
            obj.claims['wdt:P1545'] = [volLabel];
          }
          const sortVal =
            customSortOrder !== undefined && !Number.isNaN(customSortOrder)
              ? customSortOrder
              : volLabel && /^\d+(\.\d+)?$/.test(volLabel)
              ? parseFloat(volLabel)
              : r.sort_order || 999;

          await db
            .prepare(
              'UPDATE catalog_entities SET series_uri = ?, series_number = ?, sort_order = ?, entity_json = ?, updated_at = ? WHERE uri = ?'
            )
            .bind(finalSeriesUri, volLabel || null, sortVal, JSON.stringify(obj), now, r.uri)
            .run();
        }
      }

      return jsonResp({
        ok: true,
        seriesId: finalSeriesUri,
        seriesTitle: finalSeriesLabel
      });
    }

    case 'series-check-releases': {
      const auth = await resolveAuthSession(db, request, null);
      if (!auth) {
        return jsonResp({ ok: true, checkedCount: 0, alerts: [] });
      }
      const limit = Math.min(Math.max(Number(body?.limit ?? 3), 0), 5);
      const staleDays = Math.min(Math.max(Number(body?.staleDays ?? 7), 1), 30);
      const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

      let checkedCount = 0;
      if (limit > 0) {
        try {
          const staleSeries = await db
            .prepare(
              `SELECT DISTINCT s.uri, s.label
               FROM library_items li
               JOIN catalog_entities ce ON (ce.uri = li.edition_id OR ce.uri = li.work_id)
               JOIN catalog_entities s ON s.uri = ce.series_uri
               WHERE li.library_id = ?
                 AND li.ownership_status = 'owned'
                 AND li.deleted_at IS NULL
                 AND ce.series_uri IS NOT NULL
                 AND s.entity_type = 'serie'
                 AND (s.series_checked_at IS NULL OR s.series_checked_at < ?)
               ORDER BY s.series_checked_at IS NOT NULL ASC, s.series_checked_at ASC
               LIMIT ?`
            )
            .bind(auth.libraryId, staleCutoff, limit)
            .all<{ uri: string; label: string }>();

          for (const s of staleSeries.results || []) {
            checkedCount++;
            const expandRes = await expandSeriesVolumesInD1(db, s.uri, s.label);
            if (expandRes.wasAlreadyExpanded && expandRes.addedVolumes.length > 0) {
              for (const vol of expandRes.addedVolumes) {
                const alertId = `${auth.libraryId}:${vol.workUri}`;
                await db
                  .prepare(
                    `INSERT OR IGNORE INTO series_release_alerts (
                       id, library_id, series_uri, series_title, volume_uri, volume_title,
                       series_number, isbn13, cover_url, detected_at, dismissed
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
                  )
                  .bind(
                    alertId,
                    auth.libraryId,
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
              }
            }
          }
        } catch (err) {
          console.warn('[SERIES RELEASE CHECK] Erreur non bloquante :', err);
        }
      }

      try {
        const alertRows = await db
          .prepare(
            `SELECT a.id, a.series_uri, a.series_title, a.volume_uri, a.volume_title,
                    a.series_number, a.isbn13, a.cover_url, a.detected_at
             FROM series_release_alerts a
             WHERE a.library_id = ?
               AND a.dismissed = 0
               AND NOT EXISTS (
                 SELECT 1 FROM library_items li
                 WHERE li.library_id = a.library_id
                   AND (li.edition_id = a.volume_uri OR li.work_id = a.volume_uri OR (a.isbn13 IS NOT NULL AND li.edition_id = ('isbn:' || a.isbn13)))
               )
             ORDER BY a.detected_at DESC
             LIMIT 20`
          )
          .bind(auth.libraryId)
          .all<{
            id: string;
            series_uri: string;
            series_title: string;
            volume_uri: string;
            volume_title: string;
            series_number: string | null;
            isbn13: string | null;
            cover_url: string | null;
            detected_at: string;
          }>();

        const alerts = (alertRows.results || []).map((r) => ({
          id: r.id,
          seriesUri: r.series_uri,
          seriesTitle: r.series_title,
          volumeUri: r.volume_uri,
          volumeTitle: r.volume_title,
          seriesNumber: r.series_number || undefined,
          isbn13: r.isbn13 || undefined,
          coverUrl: r.cover_url || undefined,
          detectedAt: r.detected_at
        }));

        return jsonResp({ ok: true, checkedCount, alerts });
      } catch {
        return jsonResp({ ok: true, checkedCount, alerts: [] });
      }
    }

    case 'series-dismiss-alert': {
      const auth = await resolveAuthSession(db, request, null);
      if (!auth) return jsonResp({ error: 'Non authentifié' }, 401);

      const alertId = String(body?.alertId || '').trim();
      const dismissAll = Boolean(body?.dismissAll);
      try {
        if (dismissAll) {
          await db
            .prepare('UPDATE series_release_alerts SET dismissed = 1 WHERE library_id = ?')
            .bind(auth.libraryId)
            .run();
        } else if (alertId) {
          await db
            .prepare('UPDATE series_release_alerts SET dismissed = 1 WHERE id = ? AND library_id = ?')
            .bind(alertId, auth.libraryId)
            .run();
        }
      } catch {
        // ignore if table not present
      }
      return jsonResp({ ok: true });
    }

    default:
      return null;
  }
}
