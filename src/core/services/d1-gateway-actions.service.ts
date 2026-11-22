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
  parseJsonArraySafe,
  PREFERRED_GEMINI_MODELS,
  VISION_OCR_RESPONSE_SCHEMA
} from '../utils/vision-prompt.util';
import { PipelineTracer } from './pipeline-logger.service';
import {
  expandSeriesVolumesInD1,
  resolveAndStoreIsbnInD1,
  resolveAuthSession,
  resolveBestCoverUrl,
  upsertCatalogEntity
} from './d1-gateway.service';
import { updateV4BookMetadata } from './v4-pipeline.service';
import {
  addFriendConnectionForUser,
  getOrCreateShareTokens,
  jsonResp,
  maskEmail,
  type GatewayActionContext
} from './gateway/gateway-context';
import { handleAdminGatewayAction } from './gateway/admin-actions';
import { handleFamilyShareGatewayAction } from './gateway/family-share-actions';
import { handleNotificationsGatewayAction } from './gateway/notifications-actions';

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
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

/**
 * Synchronise le statut de possession / souhait d'un livre dans `v4_library_books`
 * lorsqu'une action V2 (`inventory-add`, `inventory-bulk`, `inventory-delete`, `lists-add-elements`, `lists-remove-elements`)
 * est appelée sur une URI d'entité (`isbn:...` ou `inv:...`).
 */
async function syncV4LibraryBookFlag(
  db: DatabaseBinding,
  libraryId: string,
  entityUri: string,
  opts: { isOwned?: number; isWished?: number; userId?: string | null; now: string }
): Promise<void> {
  if (!libraryId || !entityUri) return;
  try {
    const rawIsbn = entityUri.startsWith('isbn:') ? isbnUtil.normalize(entityUri.slice(5)) : '';
    const isbn13 = rawIsbn.length === 10 ? isbnUtil.toIsbn13(rawIsbn) : rawIsbn;
    const bookRows = await db
      .prepare(
        isbn13
          ? `SELECT id, selected_cover_url FROM books WHERE legacy_entity_uri = ?
             UNION
             SELECT b.id, b.selected_cover_url FROM book_isbn_index bi JOIN books b ON b.id = bi.book_id WHERE bi.isbn13 = ?`
          : 'SELECT id, selected_cover_url FROM books WHERE legacy_entity_uri = ?'
      )
      .bind(...(isbn13 ? [entityUri, isbn13] : [entityUri]))
      .all<{ id: string; selected_cover_url: string | null }>();

    for (const b of bookRows.results || []) {
      if (opts.isOwned === 1 || opts.isWished === 1) {
        const wishedBy = opts.isOwned === 1 ? null : (opts.isWished === 1 ? (opts.userId || null) : null);
        await db
          .prepare(
            `INSERT INTO v4_library_books (library_id, book_id, is_owned, is_wished, wished_by_user_id, selected_cover_url, added_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(library_id, book_id) DO UPDATE SET
               is_owned = CASE WHEN ? IS NOT NULL THEN ? ELSE v4_library_books.is_owned END,
               is_wished = CASE
                 WHEN COALESCE(?, v4_library_books.is_owned) = 1 THEN 0
                 WHEN ? IS NOT NULL THEN ?
                 ELSE v4_library_books.is_wished
               END,
               wished_by_user_id = CASE
                 WHEN COALESCE(?, v4_library_books.is_owned) = 1 THEN NULL
                 WHEN ? = 1 THEN COALESCE(?, v4_library_books.wished_by_user_id)
                 WHEN ? = 0 THEN NULL
                 ELSE v4_library_books.wished_by_user_id
               END,
               updated_at = excluded.updated_at`
          )
          .bind(
            libraryId,
            b.id,
            opts.isOwned === 1 ? 1 : 0,
            opts.isOwned === 1 ? 0 : (opts.isWished === 1 ? 1 : 0),
            wishedBy,
            b.selected_cover_url || null,
            opts.now,
            opts.now,
            opts.isOwned ?? null,
            opts.isOwned ?? null,
            opts.isOwned ?? null,
            opts.isWished ?? null,
            opts.isWished ?? null,
            opts.isOwned ?? null,
            opts.isWished ?? null,
            wishedBy,
            opts.isWished ?? null
          )
          .run();
      } else {
        if (opts.isOwned === 0) {
          await db
            .prepare('UPDATE v4_library_books SET is_owned = 0, updated_at = ? WHERE library_id = ? AND book_id = ?')
            .bind(opts.now, libraryId, b.id)
            .run();
        }
        if (opts.isWished === 0) {
          await db
            .prepare('UPDATE v4_library_books SET is_wished = 0, wished_by_user_id = NULL, updated_at = ? WHERE library_id = ? AND book_id = ?')
            .bind(opts.now, libraryId, b.id)
            .run();
        }
      }
    }
  } catch {
    // Non-bloquant si tables V4 absentes dans un test unitaire isolé
  }
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

  // Délégation par domaine métier (Chantier 5 : Notifications, Admin, Foyer/Partage/Amis)
  const ctx: GatewayActionContext = { action, db, env, request, url, body, now };
  const delegated =
    (await handleNotificationsGatewayAction(ctx)) ??
    (await handleAdminGatewayAction(ctx)) ??
    (await handleFamilyShareGatewayAction(ctx));
  if (delegated) return delegated;

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
      const tokenHash = await sha256Hex(`biblio_reset_v2:${userRow.id}:${code}`);
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

      const tokenHash = await sha256Hex(`biblio_reset_v2:${userRow.id}:${code}`);
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

      // Couche 1 (Canal 4) : 1 seule passe IA Gemini Vision en OCR strict (JSON 6 champs contraint)
      // avec bascule multi-modèles et backoff automatique sur HTTP 503 / 429
      const tracer = new PipelineTracer({
        userId: auth.userId,
        sourceChannel: 'canal_4_ai_photo'
      });
      const visionStart = Date.now();
      const prompt = buildVisionPrompt(mode);
      let rawText: string | null = null;
      let usedModelId: string | null = null;
      let lastStatus = 0;
      let lastBody = '';
      const attemptsLog: Array<{ model: string; round: number; status: number; durationMs: number; error?: string }> = [];

      const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const candidateModels = PREFERRED_GEMINI_MODELS.slice(0, 6);

      for (let round = 1; round <= 2 && rawText === null; round++) {
        if (round > 1) {
          // Court backoff avant la 2e passe si tous les modèles ont répondu 503/429
          await sleepMs(750);
        }
        for (const modelId of candidateModels) {
          const attStart = Date.now();
          const abortCtrl = new AbortController();
          const timer = setTimeout(() => abortCtrl.abort(), 14000);
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
                        { inline_data: { mime_type: mimeType, data: imageBase64 } }
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
              attemptsLog.push({ model: modelId, round, status: res.status, durationMs: Date.now() - attStart });
              break;
            }
            lastStatus = res.status;
            lastBody = await res.text().catch(() => '');
            attemptsLog.push({
              model: modelId,
              round,
              status: lastStatus,
              durationMs: Date.now() - attStart,
              error: lastBody.slice(0, 220)
            });
            // Arrêt anticipé seulement sur erreur client non récupérable (hors 404/429/5xx)
            if (lastStatus !== 404 && lastStatus !== 429 && lastStatus < 500) {
              round = 99;
              break;
            }
          } catch (fetchErr: unknown) {
            lastStatus = 502;
            lastBody = fetchErr instanceof Error ? fetchErr.message : 'Erreur réseau';
            attemptsLog.push({
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
        tracer.record(
          'C1',
          'vision_ocr',
          'error',
          `Échec OCR Gemini Vision après ${attemptsLog.length} tentative(s) (dernier HTTP ${lastStatus})`,
          {
            requestSent: {
              mode,
              mimeType,
              imageBytesApprox: Math.round((imageBase64.length * 3) / 4),
              promptLength: prompt.length,
              modelsTried: candidateModels
            },
            attempts: attemptsLog,
            lastErrorPreview: lastBody.slice(0, 300)
          },
          Date.now() - visionStart
        );
        await tracer.flush(db);
        const isOverloaded = lastStatus === 503 || lastStatus === 429;
        return jsonResp(
          {
            error: isOverloaded
              ? `Serveur Gemini temporairement surchargé (HTTP ${lastStatus} après ${attemptsLog.length} essais). Nouvel essai automatique recommandé.`
              : `Erreur API Gemini serveur (${lastStatus}): ${lastBody.slice(0, 140)}`,
            traceId: tracer.traceId,
            retryable: isOverloaded
          },
          isOverloaded ? lastStatus : 502
        );
      }

      const parsedCandidates = parseJsonArraySafe<Record<string, unknown>>(rawText);
      tracer.record(
        'C1',
        'vision_ocr',
        parsedCandidates.length > 0 ? 'ok' : 'warn',
        `OCR strict (${mode}, ${usedModelId || 'gemini'}, ${attemptsLog.length} essai(s)) : ${parsedCandidates.length} tranche(s)/couverture(s) détectée(s)`,
        {
          requestSent: {
            mode,
            mimeType,
            imageBytesApprox: Math.round((imageBase64.length * 3) / 4),
            promptLength: prompt.length,
            modelUsed: usedModelId
          },
          attempts: attemptsLog,
          candidatesCount: parsedCandidates.length,
          candidates: parsedCandidates
        },
        Date.now() - visionStart
      );
      await tracer.flush(db);

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

      return jsonResp({ text: rawText, monthlyQuota, remainingQuota, traceId: tracer.traceId });
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
      await syncV4LibraryBookFlag(db, libraryId, entityUri, { isOwned: 1, isWished: 0, now });

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
          await syncV4LibraryBookFlag(db, libraryId, entityUri, { isOwned: 1, isWished: 0, now });
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
        await syncV4LibraryBookFlag(db, libraryId, entityUri, { isOwned: 1, isWished: 0, now });
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
      const allUrisToUnsync = new Set<string>(uris.map((u) => String(u || '').trim()).filter(Boolean));

      for (const id of ids) {
        const existingItem = await db
          .prepare('SELECT edition_id, work_id FROM library_items WHERE id = ? AND library_id = ? LIMIT 1')
          .bind(id, libraryId)
          .first<{ edition_id: string | null; work_id: string | null }>();
        if (existingItem?.edition_id) allUrisToUnsync.add(existingItem.edition_id);
        if (existingItem?.work_id) allUrisToUnsync.add(existingItem.work_id);

        await db
          .prepare("UPDATE loans SET returned_at = COALESCE(returned_at, ?), deleted_at = ?, updated_at = ? WHERE library_id = ? AND library_item_id = ?")
          .bind(now, now, now, libraryId, id)
          .run()
          .catch(() => {});

        await db
          .prepare("UPDATE library_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND library_id = ?")
          .bind(now, now, id, libraryId)
          .run();
      }
      for (const u of allUrisToUnsync) {
        await db
          .prepare(
            "UPDATE library_items SET deleted_at = ?, updated_at = ? WHERE library_id = ? AND ownership_status = 'owned' AND (edition_id = ? OR work_id = ?)"
          )
          .bind(now, now, libraryId, u, u)
          .run();
        await db
          .prepare(
            "UPDATE loans SET returned_at = COALESCE(returned_at, ?), deleted_at = ?, updated_at = ? WHERE library_id = ? AND library_item_id = ?"
          )
          .bind(now, now, now, libraryId, u)
          .run()
          .catch(() => {});
        await syncV4LibraryBookFlag(db, libraryId, u, { isOwned: 0, now });
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
          `SELECT DISTINCT COALESCE(edition_id, work_id) as uri
           FROM library_items
           WHERE library_id = ? AND ownership_status = 'wishlist' AND deleted_at IS NULL
           UNION
           SELECT DISTINCT COALESCE(b.legacy_entity_uri, 'v4:' || b.id) as uri
           FROM v4_library_books lb
           JOIN books b ON b.id = lb.book_id
           WHERE lb.library_id = ? AND lb.is_wished = 1`
        )
        .bind(libraryId, libraryId)
        .all<{ uri: string }>();

      const elements = (rows.results || []).map((r) => ({ uri: r.uri, element: r.uri }));
      return jsonResp({ list: { _id: listId, elements }, elements });
    }

    case 'lists-add-elements': {
      const listId = String(body?.id || '');
      const auth = await resolveAuthSession(db, request, body?.userUri || null);
      const libraryId =
        auth?.libraryId || (listId.startsWith('wish_') ? listId.slice(5) : '') || 'lib_default';
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];

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
            `INSERT INTO library_items (id, library_id, work_id, edition_id, ownership_status, added_by_user_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'wishlist', ?, ?, ?)`
          )
          .bind(itemId, libraryId, entityUri, entityUri, auth?.userId || null, now, now)
          .run();
        await syncV4LibraryBookFlag(db, libraryId, entityUri, {
          isWished: 1,
          userId: auth?.userId || null,
          now
        });
      }
      return jsonResp({ ok: true });
    }

    case 'lists-remove-elements': {
      const listId = String(body?.id || '');
      const auth = await resolveAuthSession(db, request, body?.userUri || null);
      const libraryId =
        auth?.libraryId || (listId.startsWith('wish_') ? listId.slice(5) : '') || 'lib_default';
      const uris: string[] = Array.isArray(body?.uris) ? body.uris : [];

      for (const u of uris) {
        const entityUri = String(u || '').trim();
        if (!entityUri) continue;
        await db
          .prepare(
            "UPDATE library_items SET deleted_at = ?, updated_at = ? WHERE library_id = ? AND ownership_status = 'wishlist' AND (edition_id = ? OR work_id = ?)"
          )
          .bind(now, now, libraryId, entityUri, entityUri)
          .run();
        await syncV4LibraryBookFlag(db, libraryId, entityUri, { isWished: 0, now });
      }
      return jsonResp({ ok: true });
    }

    // ========================================================================
    // 4. PRÊTS (SHELVES / LOANS) DANS D1
    // ========================================================================
    case 'shelves': {
      const subPath = url.searchParams.get('path') || '';
      const ownersParam = url.searchParams.get('owners') || body?.userUri || '';
      const auth = await resolveAuthSession(db, request, ownersParam);
      const libraryId =
        auth?.libraryId ||
        (ownersParam.startsWith('user:') ? ownersParam.slice(5) : ownersParam) ||
        'lib_default';

      if (subPath === 'by-owners') {
        const rows = await db
          .prepare(
            "SELECT id, library_item_id, borrower_name, loaned_at, notes FROM loans WHERE library_id = ? AND library_item_id != '' AND returned_at IS NULL AND deleted_at IS NULL"
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
            .prepare('SELECT id, library_item_id, borrower_name, loaned_at, notes FROM loans WHERE id = ? AND library_id = ? LIMIT 1')
            .bind(id, libraryId)
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
              items: r.library_item_id ? [r.library_item_id] : []
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
        const items: string[] = Array.isArray(body?.items) ? body.items.map(String).filter(Boolean) : [];
        const itemRef = items[0] || '';
        const loanId = `loan_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

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

        await db
          .prepare(
            `INSERT INTO loans (id, library_id, library_item_id, borrower_name, loaned_at, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(loanId, libraryId, itemRef, effectiveBorrower, now, description, now, now)
          .run();

        return jsonResp({
          shelf: { _id: loanId, name: `Prêts - ${effectiveBorrower}`, description, items }
        });
      }

      if (subPath === 'add-items') {
        const loanId = String(body?.id || '');
        const items: string[] = Array.isArray(body?.items) ? body.items.map(String).filter(Boolean) : [];
        if (loanId && items[0]) {
          const existingLoan = await db
            .prepare('SELECT library_item_id, borrower_name, notes FROM loans WHERE id = ? AND library_id = ? LIMIT 1')
            .bind(loanId, libraryId)
            .first<{ library_item_id: string | null; borrower_name: string; notes: string | null }>();
          if (existingLoan && (!existingLoan.library_item_id || existingLoan.library_item_id === items[0])) {
            await db
              .prepare('UPDATE loans SET library_item_id = ?, updated_at = ? WHERE id = ? AND library_id = ?')
              .bind(items[0], now, loanId, libraryId)
              .run();
          } else if (existingLoan) {
            // Un livre était déjà rattaché à cette étagère de prêt : créer un nouveau prêt sans écraser le précédent !
            const newLoanId = `loan_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
            await db
              .prepare(
                `INSERT INTO loans (id, library_id, library_item_id, borrower_name, loaned_at, notes, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(newLoanId, libraryId, items[0], existingLoan.borrower_name, now, existingLoan.notes || String(Date.now()), now, now)
              .run();
          }
        }
        return jsonResp({ ok: true });
      }

      if (subPath === 'remove-items' || subPath === 'delete') {
        const loanId = String(body?.id || (Array.isArray(body?.ids) ? body.ids[0] : '') || '');
        const items: string[] = Array.isArray(body?.items) ? body.items.map(String).filter(Boolean) : [];
        if (loanId) {
          await db
            .prepare('UPDATE loans SET returned_at = ?, updated_at = ? WHERE id = ? AND library_id = ?')
            .bind(now, now, loanId, libraryId)
            .run();
        }
        if (items[0]) {
          await db
            .prepare('UPDATE loans SET returned_at = ?, updated_at = ? WHERE library_id = ? AND library_item_id = ? AND returned_at IS NULL')
            .bind(now, now, libraryId, items[0])
            .run();
        }
        return jsonResp({ ok: true });
      }

      return jsonResp({ shelves: {} });
    }

    // ========================================================================
    // 5. CATALOGUE COMMUN, ENTITÉS, RECHERCHE & SÉRIES DANS D1
    // ========================================================================
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
      const oldValue = body?.['old-value'] !== undefined ? body['old-value'] : body?.oldValue;
      const newValue = body?.['new-value'] !== undefined ? body['new-value'] : body?.newValue;
      if (!uri || !property) return jsonResp({ error: 'uri et property requis' }, 400);

      const row = await db
        .prepare('SELECT * FROM catalog_entities WHERE uri = ? LIMIT 1')
        .bind(uri)
        .first<Record<string, any>>();

      if (!row) return jsonResp({ ok: true });

      const entityObj = JSON.parse(row.entity_json);
      entityObj.claims = entityObj.claims || {};
      const existingArr: unknown[] = Array.isArray(entityObj.claims[property]) ? [...entityObj.claims[property]] : [];
      if (newValue === null || newValue === undefined || newValue === '') {
        if (oldValue !== null && oldValue !== undefined && oldValue !== '') {
          const filtered = existingArr.filter((v) => String(v) !== String(oldValue));
          if (filtered.length > 0) entityObj.claims[property] = filtered;
          else delete entityObj.claims[property];
        } else {
          delete entityObj.claims[property];
        }
      } else if (Array.isArray(newValue)) {
        entityObj.claims[property] = newValue;
      } else if (oldValue !== null && oldValue !== undefined && oldValue !== '') {
        const idx = existingArr.findIndex((v) => String(v) === String(oldValue));
        if (idx >= 0) existingArr[idx] = newValue;
        else if (!existingArr.includes(newValue)) existingArr.push(newValue);
        entityObj.claims[property] = existingArr;
      } else if (property === 'wdt:P50') {
        if (!existingArr.includes(newValue)) existingArr.push(newValue);
        entityObj.claims[property] = existingArr;
      } else {
        entityObj.claims[property] = [newValue];
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
    // 6. RATTACHEMENT HORS-SÉRIE & FUSION DE SÉRIES EN 1 CLIC (OPTION B PAR FOYER)
    // ========================================================================
    case 'series-merge': {
      const auth = await resolveAuthSession(db, request, body?.userUri);
      if (!auth?.libraryId) {
        return jsonResp({ error: 'Authentification requise' }, 401);
      }

      const targetSeriesTitle = String(body?.targetSeriesTitle || '').trim();
      const targetSeriesIdInput = String(body?.targetSeriesId || '').trim();
      const sourceSeriesId = String(body?.sourceSeriesId || '').trim();
      const bookUris: string[] = Array.isArray(body?.bookUris) ? body.bookUris : [];
      const customVolumeLabel =
        body?.volumeLabel !== undefined ? String(body.volumeLabel).trim() : undefined;

      if (!targetSeriesTitle && !targetSeriesIdInput) {
        return jsonResp({ error: 'Série cible requise' }, 400);
      }

      let finalSeriesUri = targetSeriesIdInput;
      let finalSeriesLabel = targetSeriesTitle;

      // 1. Résoudre ou créer la série cible dans V4 (`v4_series`) en priorité
      let effectiveV4SeriesId = '';
      let effectiveV4SeriesName = finalSeriesLabel;
      try {
        if (finalSeriesUri) {
          const existingById = await db
            .prepare('SELECT id, canonical_name FROM v4_series WHERE id = ? LIMIT 1')
            .bind(finalSeriesUri)
            .first<{ id: string; canonical_name: string }>();
          if (existingById) {
            effectiveV4SeriesId = existingById.id;
            effectiveV4SeriesName = existingById.canonical_name;
          }
        }
        if (!effectiveV4SeriesId && finalSeriesLabel) {
          const cleanCoreKey = normalizeTextKey(finalSeriesLabel.replace(/^(?:la\s+)?collection\s+/i, ''));
          let existingByKey = cleanCoreKey
            ? await db
                .prepare('SELECT id, canonical_name FROM v4_series WHERE normalized_core_key = ? LIMIT 1')
                .bind(cleanCoreKey)
                .first<{ id: string; canonical_name: string }>()
            : null;
          if (!existingByKey) {
            const newId = finalSeriesUri || `ser_${(cleanCoreKey || 'custom').replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 7)}`;
            await db
              .prepare(
                `INSERT OR IGNORE INTO v4_series (id, canonical_name, normalized_core_key, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)`
              )
              .bind(newId, finalSeriesLabel, cleanCoreKey || newId, now, now)
              .run();
            existingByKey = { id: newId, canonical_name: finalSeriesLabel };
          }
          effectiveV4SeriesId = existingByKey.id;
          effectiveV4SeriesName = existingByKey.canonical_name;
        }
      } catch {
        // Non-bloquant si v4_series absent dans un test minimal
      }

      if (!finalSeriesUri && finalSeriesLabel) {
        finalSeriesUri =
          effectiveV4SeriesId ||
          (await upsertCatalogEntity(db, {
            entityType: 'serie',
            label: finalSeriesLabel,
            claims: { 'wdt:P31': ['wd:Q277759'] }
          }));
      } else if (finalSeriesUri && !finalSeriesLabel) {
        finalSeriesLabel = effectiveV4SeriesName;
        if (!finalSeriesLabel) {
          const sRow = await db
            .prepare('SELECT label FROM catalog_entities WHERE uri = ? LIMIT 1')
            .bind(finalSeriesUri)
            .first<{ label: string }>();
          finalSeriesLabel = sRow?.label || 'Série';
        }
      }

      effectiveV4SeriesId = effectiveV4SeriesId || finalSeriesUri;
      effectiveV4SeriesName = effectiveV4SeriesName || finalSeriesLabel;

      // 2. Option B V4 : Appliquer le rattachement uniquement dans `v4_library_books` pour `auth.libraryId`
      //    (sans jamais altérer `books` ni écraser les séries d'autres foyers).
      try {
        const targetBookIds = new Set<string>();
        if (sourceSeriesId && sourceSeriesId !== effectiveV4SeriesId) {
          const sourceV4Rows = await db
            .prepare(
              `SELECT b.id
               FROM books b
               LEFT JOIN v4_library_books lb ON lb.book_id = b.id AND lb.library_id = ?
               WHERE b.series_id = ?
                  OR (lb.library_id = ? AND lb.custom_overrides_json LIKE ?)`
            )
            .bind(auth.libraryId, sourceSeriesId, auth.libraryId, `%${sourceSeriesId}%`)
            .all<{ id: string }>();
          for (const sr of sourceV4Rows.results || []) {
            if (sr.id) targetBookIds.add(sr.id);
          }
        }

        for (const id of targetBookIds) {
          await updateV4BookMetadata(db, {
            bookId: id,
            libraryId: auth.libraryId,
            series: effectiveV4SeriesName,
            seriesId: effectiveV4SeriesId
          });
        }

        for (const bUri of bookUris) {
          await updateV4BookMetadata(db, {
            bookId: bUri.startsWith('bk_') ? bUri : undefined,
            uri: bUri,
            isbn13: bUri.startsWith('isbn:') ? bUri.slice(5) : undefined,
            libraryId: auth.libraryId,
            series: effectiveV4SeriesName,
            seriesId: effectiveV4SeriesId,
            ...(customVolumeLabel !== undefined ? { seriesNumber: customVolumeLabel } : {})
          });
        }
      } catch {
        // Non-bloquant
      }

      return jsonResp({
        ok: true,
        seriesId: effectiveV4SeriesId,
        seriesTitle: effectiveV4SeriesName
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
