// src/core/services/gateway/gateway-context.ts
// Contexte et utilitaires partagés entre les modules métiers du Gateway (DRY / SOLID).

import type { AppBackendEnv, DatabaseBinding } from '../../adapters/storage-db.interface';
import { resolveAuthSession } from '../d1-gateway.service';

export interface GatewayActionContext {
  action: string;
  db: DatabaseBinding;
  env: AppBackendEnv;
  request: Request;
  url: URL;
  body: Record<string, any> | null;
  now: string;
}

export function jsonResp(
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

export async function requireAdmin(db: DatabaseBinding, request: Request) {
  const auth = await resolveAuthSession(db, request, null);
  if (!auth) return null;
  const row = await db
    .prepare('SELECT is_admin FROM users WHERE id = ? LIMIT 1')
    .bind(auth.userId)
    .first<{ is_admin?: number }>();
  return row?.is_admin === 1 ? auth : null;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

export function generateShortCode(len = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

export function extractShareToken(raw: string): string {
  const trimmed = String(raw || '').trim();
  const match = /((?:PUB|FAM)-[A-Z0-9]{4,12})/i.exec(trimmed);
  return (match ? match[1] : trimmed).toUpperCase();
}

export async function addFriendConnectionForUser(
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

export async function getOrCreateShareTokens(
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
