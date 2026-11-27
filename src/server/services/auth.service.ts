// src/server/services/auth.service.ts
// Service métier Auth, Profil, Succession Foyer et Genres par défaut.

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/database.adapter';
import type { ServerConfig } from '../config';
import type { MailSender } from '../connectors/resend.connector';
import { LibraryRepository } from '../repositories/library.repo';
import { UserRepository, type UserRow } from '../repositories/user.repo';
import { AppError } from '../middleware/error.middleware';
import { SUGGESTED_GENRE_CHIPS } from '../../shared/bibliographic/category-classifier';
import type { LibraryMemberRole, LocaleId, ThemeId } from '../../shared/types/domain.types';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 jours
const RESET_CODE_TTL_MS = 1000 * 60 * 15; // 15 minutes

export interface AuthSessionContext {
  userId: string;
  libraryId: string;
  username: string;
  email: string;
  isAdmin: boolean;
  role: LibraryMemberRole;
  sessionTokenHash: string;
}

export interface ProfilePayload {
  user: {
    id: string;
    username: string;
    email: string;
    isAdmin: boolean;
    theme: ThemeId;
    locale: LocaleId;
    onboardingNotifSeen: boolean;
    createdAt: string;
  };
  library: {
    id: string;
    name: string;
    role: LibraryMemberRole;
    familyInviteCode: string;
    friendShareToken: string;
    members: Array<{
      userId: string;
      username: string;
      role: LibraryMemberRole;
      joinedAt: string;
    }>;
  };
  defaultGenres: string[];
  aiQuota: {
    monthKey: string;
    used: number;
    limit: number;
    remaining: number;
  };
  unreadAlertsCount: number;
}

function hashSha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function generateShareCode(prefix: 'FAM' | 'PUB'): string {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export class AuthService {
  private readonly db: DatabaseAdapter;
  private readonly userRepo: UserRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly config: ServerConfig;
  private readonly mailSender: MailSender;

  constructor(deps: {
    db: DatabaseAdapter;
    userRepo: UserRepository;
    libraryRepo: LibraryRepository;
    config: ServerConfig;
    mailSender: MailSender;
  }) {
    this.db = deps.db;
    this.userRepo = deps.userRepo;
    this.libraryRepo = deps.libraryRepo;
    this.config = deps.config;
    this.mailSender = deps.mailSender;
  }

  private createSessionToken(userId: string): { rawToken: string; expiresAt: string } {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSha256(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    this.userRepo.createSession({ tokenHash, userId, expiresAt, now: now.toISOString() });
    return { rawToken, expiresAt };
  }

  resolveSessionByRawToken(rawToken: string): AuthSessionContext | null {
    if (!rawToken) return null;
    const tokenHash = hashSha256(rawToken);
    const session = this.userRepo.findSession(tokenHash);
    if (!session) return null;

    if (Date.parse(session.expires_at) <= Date.now()) {
      this.userRepo.deleteSession(tokenHash);
      return null;
    }

    const user = this.userRepo.findById(session.user_id);
    if (!user || user.banned_at) return null;

    const lib = this.libraryRepo.findLibraryByUserId(user.id);
    if (!lib) return null;

    const members = this.libraryRepo.listMembers(lib.id);
    const meMember = members.find((m) => m.user_id === user.id);

    return {
      userId: user.id,
      libraryId: lib.id,
      username: user.username,
      email: user.email,
      isAdmin: user.is_admin === 1,
      role: meMember?.role ?? (lib.owner_user_id === user.id ? 'owner' : 'member'),
      sessionTokenHash: tokenHash
    };
  }

  buildProfilePayload(userId: string): ProfilePayload {
    const user = this.userRepo.findById(userId);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');

    const lib = this.libraryRepo.findLibraryByUserId(user.id);
    if (!lib) throw new AppError(404, 'LIBRARY_NOT_FOUND', 'Foyer introuvable.');

    const members = this.libraryRepo.listMembers(lib.id);
    const meMember = members.find((m) => m.user_id === user.id);

    const monthKey = currentMonthKey();
    const aiRow = this.userRepo.getAiUsage(user.id);
    const used = aiRow && aiRow.month_key === monthKey ? aiRow.month_used : 0;
    const limit = this.config.monthlyAiQuota;

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.is_admin === 1,
        theme: user.theme,
        locale: user.locale,
        onboardingNotifSeen: user.onboarding_notif_seen === 1,
        createdAt: user.created_at
      },
      library: {
        id: lib.id,
        name: lib.name,
        role: meMember?.role ?? 'member',
        familyInviteCode: lib.family_invite_code,
        friendShareToken: lib.friend_share_token,
        members: members.map((m) => ({
          userId: m.user_id,
          username: m.username || '',
          role: m.role,
          joinedAt: m.joined_at
        }))
      },
      defaultGenres: this.userRepo.listDefaultGenres(user.id),
      aiQuota: {
        monthKey,
        used,
        limit,
        remaining: Math.max(0, limit - used)
      },
      unreadAlertsCount: this.libraryRepo.countActiveAlerts(lib.id)
    };
  }

  register(input: {
    username: string;
    email: string;
    password: string;
    inviteCode?: string;
    friendToken?: string;
  }): { sessionToken: string; expiresAt: string; profile: ProfilePayload } {
    const normalizedEmail = input.email.trim().toLowerCase();
    const cleanUsername = input.username.trim();

    if (this.userRepo.findByUsername(cleanUsername)) {
      throw new AppError(409, 'USERNAME_TAKEN', "Ce nom d'utilisateur est déjà utilisé.");
    }
    if (this.userRepo.findByEmail(normalizedEmail)) {
      throw new AppError(409, 'EMAIL_TAKEN', 'Cette adresse e-mail est déjà utilisée.');
    }

    const now = new Date().toISOString();
    const userId = generateId('usr');
    const isAdmin = Boolean(this.config.adminEmail && normalizedEmail === this.config.adminEmail);
    const passwordHash = hashPassword(input.password);

    this.db.transaction(() => {
      this.userRepo.createUser({
        id: userId,
        username: cleanUsername,
        email: normalizedEmail,
        passwordHash,
        isAdmin,
        gdprAcceptedAt: now,
        now
      });

      this.userRepo.replaceDefaultGenres(userId, SUGGESTED_GENRE_CHIPS, now);

      // Rattachement au foyer invité si un code FAM-... valide est fourni, sinon création d'un foyer propre
      const invitedLibrary = input.inviteCode
        ? this.libraryRepo.findByFamilyInviteCode(input.inviteCode)
        : null;

      if (invitedLibrary) {
        this.libraryRepo.addMember(invitedLibrary.id, userId, 'member', now);
      } else {
        this.libraryRepo.createLibrary({
          id: generateId('lib'),
          name: `Foyer de ${cleanUsername}`,
          ownerUserId: userId,
          familyInviteCode: generateShareCode('FAM'),
          friendShareToken: generateShareCode('PUB'),
          now
        });
      }

      // Suivi ami automatique si un jeton PUB-... valide est fourni
      if (input.friendToken) {
        const friendLib = this.libraryRepo.findByFriendShareToken(input.friendToken);
        if (friendLib && friendLib.owner_user_id !== userId) {
          this.libraryRepo.addFriendConnection(userId, friendLib.id, now);
        }
      }
    });

    const { rawToken, expiresAt } = this.createSessionToken(userId);
    return {
      sessionToken: rawToken,
      expiresAt,
      profile: this.buildProfilePayload(userId)
    };
  }

  login(input: {
    identifier: string;
    password: string;
    inviteCode?: string;
    friendToken?: string;
  }): { sessionToken: string; expiresAt: string; profile: ProfilePayload } {
    const user = this.userRepo.findByIdentifier(input.identifier.trim());
    if (!user || !verifyPassword(input.password, user.password_hash)) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Identifiants incorrects.');
    }
    if (user.banned_at) {
      throw new AppError(403, 'ACCOUNT_BANNED', 'Ce compte a été temporairement suspendu par un administrateur.');
    }

    const now = new Date().toISOString();
    if (input.inviteCode) {
      const invitedLibrary = this.libraryRepo.findByFamilyInviteCode(input.inviteCode);
      if (invitedLibrary) {
        this.libraryRepo.addMember(invitedLibrary.id, user.id, 'member', now);
      }
    }
    if (input.friendToken) {
      const friendLib = this.libraryRepo.findByFriendShareToken(input.friendToken);
      const myLib = this.libraryRepo.findLibraryByUserId(user.id);
      if (friendLib && friendLib.id !== myLib?.id) {
        this.libraryRepo.addFriendConnection(user.id, friendLib.id, now);
      }
    }

    const { rawToken, expiresAt } = this.createSessionToken(user.id);
    return {
      sessionToken: rawToken,
      expiresAt,
      profile: this.buildProfilePayload(user.id)
    };
  }

  logout(sessionTokenHash: string): void {
    this.userRepo.deleteSession(sessionTokenHash);
  }

  async requestPasswordReset(identifier: string): Promise<{ maskedEmail: string; devCode?: string }> {
    const user = this.userRepo.findByIdentifier(identifier.trim());
    if (!user) {
      // Réponse uniforme pour éviter l'énumération de comptes
      return { maskedEmail: '***@***' };
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const tokenHash = hashSha256(code);
    const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS).toISOString();
    this.userRepo.createPasswordResetToken({ tokenHash, userId: user.id, expiresAt });

    await this.mailSender.sendEmail({
      to: user.email,
      subject: 'Votre code de réinitialisation — Ma Bibliothèque Cloud',
      html: `<p>Bonjour ${user.username},</p><p>Votre code de récupération (valable 15 minutes) : <strong>${code}</strong></p>`
    });

    return {
      maskedEmail: maskEmail(user.email),
      ...(this.config.nodeEnv === 'test' ? { devCode: code } : {})
    };
  }

  resetPassword(input: { identifier: string; code: string; newPassword: string }): void {
    const user = this.userRepo.findByIdentifier(input.identifier.trim());
    if (!user) {
      throw new AppError(400, 'INVALID_RESET_CODE', 'Code de récupération invalide ou expiré.');
    }

    const tokenHash = hashSha256(input.code.trim());
    const resetRow = this.userRepo.findPasswordResetToken(tokenHash, user.id);
    if (!resetRow || resetRow.used_at || Date.parse(resetRow.expires_at) <= Date.now()) {
      throw new AppError(400, 'INVALID_RESET_CODE', 'Code de récupération invalide ou expiré.');
    }

    const now = new Date().toISOString();
    const newHash = hashPassword(input.newPassword);

    this.db.transaction(() => {
      this.userRepo.updateUser(user.id, { passwordHash: newHash, updatedAt: now });
      this.userRepo.markPasswordResetUsed(tokenHash, now);
      this.userRepo.deleteAllUserSessions(user.id);
    });
  }

  updateProfile(
    userId: string,
    patch: {
      username?: string;
      email?: string;
      currentPassword?: string;
      newPassword?: string;
      theme?: ThemeId;
      locale?: LocaleId;
      onboardingNotifSeen?: boolean;
    }
  ): ProfilePayload {
    const user: UserRow | null = this.userRepo.findById(userId);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');

    const identityChanged =
      (patch.username !== undefined && patch.username !== user.username) ||
      (patch.email !== undefined && patch.email.toLowerCase() !== user.email.toLowerCase()) ||
      Boolean(patch.newPassword);

    if (identityChanged) {
      if (!patch.currentPassword || !verifyPassword(patch.currentPassword, user.password_hash)) {
        throw new AppError(403, 'INVALID_CURRENT_PASSWORD', 'Mot de passe actuel incorrect.');
      }
    }

    if (patch.username && patch.username !== user.username) {
      const existing = this.userRepo.findByUsername(patch.username);
      if (existing && existing.id !== userId) {
        throw new AppError(409, 'USERNAME_TAKEN', "Ce nom d'utilisateur est déjà utilisé.");
      }
    }
    if (patch.email && patch.email.toLowerCase() !== user.email.toLowerCase()) {
      const existing = this.userRepo.findByEmail(patch.email);
      if (existing && existing.id !== userId) {
        throw new AppError(409, 'EMAIL_TAKEN', 'Cette adresse e-mail est déjà utilisée.');
      }
    }

    this.userRepo.updateUser(userId, {
      username: patch.username,
      email: patch.email,
      passwordHash: patch.newPassword ? hashPassword(patch.newPassword) : undefined,
      theme: patch.theme,
      locale: patch.locale,
      onboardingNotifSeen: patch.onboardingNotifSeen
    });

    return this.buildProfilePayload(userId);
  }

  updateDefaultGenres(userId: string, action: 'add' | 'remove' | 'reset', genre?: string): string[] {
    const now = new Date().toISOString();
    if (action === 'reset') {
      this.userRepo.replaceDefaultGenres(userId, SUGGESTED_GENRE_CHIPS, now);
    } else if (action === 'add' && genre?.trim()) {
      this.userRepo.addDefaultGenre(userId, genre.trim(), now);
    } else if (action === 'remove' && genre?.trim()) {
      this.userRepo.removeDefaultGenre(userId, genre.trim());
    }
    return this.userRepo.listDefaultGenres(userId);
  }

  reorderDefaultGenres(userId: string, orderedGenres: string[]): string[] {
    this.userRepo.reorderDefaultGenres(userId, orderedGenres);
    return this.userRepo.listDefaultGenres(userId);
  }

  /**
   * Suppression définitive de compte :
   * - Vérifie le mot de passe.
   * - Foyer partagé : retire le membre et promeut automatiquement le membre le plus ancien en `owner` si nécessaire.
   * - Foyer solo : supprime le foyer (et ses possessions/prêts/alertes en cascade).
   * - Ne touche JAMAIS au Catalogue Central (`books`, `series`, `franchises`, `book_editions`, `covers`).
   */
  deleteAccount(userId: string, password: string): { deletedLibrary: boolean; promotedOwnerUserId: string | null } {
    const user = this.userRepo.findById(userId);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');

    if (!verifyPassword(password, user.password_hash)) {
      throw new AppError(403, 'INVALID_CURRENT_PASSWORD', 'Mot de passe incorrect.');
    }

    const now = new Date().toISOString();
    let deletedLibrary = false;
    let promotedOwnerUserId: string | null = null;

    this.db.transaction(() => {
      const lib = this.libraryRepo.findLibraryByUserId(userId);
      if (lib) {
        const otherMembers = this.libraryRepo.listMembers(lib.id).filter((m) => m.user_id !== userId);
        if (otherMembers.length === 0) {
          this.libraryRepo.deleteLibrary(lib.id);
          deletedLibrary = true;
        } else {
          if (lib.owner_user_id === userId) {
            promotedOwnerUserId = otherMembers[0].user_id;
            this.libraryRepo.transferOwnership(lib.id, promotedOwnerUserId, now);
          }
          this.libraryRepo.removeMember(lib.id, userId);
        }
      }
      // Supprime l'utilisateur + ses sessions, lectures, genres défaut, abonnements amis, push, quotas en cascade
      this.userRepo.deleteUser(userId);
    });

    return { deletedLibrary, promotedOwnerUserId };
  }
}
