// src/server/services/social.service.ts
// Service métier Social : Foyer (rejoindre, régénérer code), Amis stricts (PUB-...) & Vitrine + Réservation Cadeau anti-spoiler.

import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/database.adapter';
import type { CatalogRepository } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import type { LoanRepository } from '../repositories/loan.repo';
import type { SocialRepository } from '../repositories/social.repo';
import type { IngestionService } from './acquisition/ingestion.service';
import type { AuthSessionContext } from './auth.service';
import type { FamilyDetachPolicy } from '../../shared/types/domain.types';
import { AppError } from '../middleware/error.middleware';

export type GiftReservationStatus = 'available' | 'reserved_by_me' | 'reserved_by_other';

export interface FamilyDetachBookItem {
  id: string;
  title: string;
  seriesId: string | null;
  seriesName: string | null;
  volumeNumber: number | null;
  volumeLabel: string | null;
  isIntegral: boolean;
  includedVolumes: string[];
  authors: string[];
  mainCategory: string;
  genres: string[];
  coverUrl: string | null;
  ownershipStatus: 'owned' | 'wish';
  wishedByUserId: string | null;
  wishedByName: string | null;
  activeLoan: {
    borrowerName: string;
    loanedAt: string;
  } | null;
}

export interface FamilyDetachPreviewPayload {
  libraryId: string;
  libraryName: string;
  detachPolicy: FamilyDetachPolicy;
  isActorOwner: boolean;
  isSelfDetach: boolean;
  canTransferOwned: boolean;
  targetMember: {
    userId: string;
    username: string;
    role: 'owner' | 'member';
  };
  willTransferOwnershipTo: {
    userId: string;
    username: string;
  } | null;
  defaultNewLibraryName: string;
  preselectedBookIds: string[];
  books: FamilyDetachBookItem[];
}

export interface FamilyDetachResult {
  newLibraryId: string;
  newLibraryName: string;
  targetUserId: string;
  targetUsername: string;
  selfDetached: boolean;
  promotedOwnerUsername: string | null;
  mode: 'move' | 'copy';
  transferredOwnedCount: number;
  transferredWishCount: number;
  transferredLoansCount: number;
  keptAsFriends: boolean;
}

export interface SharedBookView {
  id: string;
  title: string;
  seriesId: string | null;
  seriesName: string | null;
  volumeLabel: string | null;
  isIntegral: boolean;
  includedVolumes: string[];
  authors: string[];
  publisher: string | null;
  mainCategory: string;
  genres: string[];
  coverUrl: string | null;
  ownershipStatus: 'owned' | 'wish';
  /** Statut prêté sans JAMAIS exposer le nom de l'emprunteur. */
  isLent: boolean;
  /** Strictement omis (null) si le lecteur appartient au foyer propriétaire (anti-spoiler). */
  giftReservation: GiftReservationStatus | null;
}

export interface SharedLibraryPayload {
  libraryId: string;
  libraryName: string;
  ownerUsername: string;
  isOwnLibrary: boolean;
  canReserveGifts: boolean;
  alreadyFriend: boolean;
  books: SharedBookView[];
}

function generateShareCode(prefix: 'FAM' | 'PUB'): string {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function extractTokenCode(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/((?:FAM|PUB)-[A-Z0-9]{4,32})/i);
  return match ? match[1].toUpperCase() : trimmed.toUpperCase();
}

export class SocialService {
  private readonly db: DatabaseAdapter;
  private readonly socialRepo: SocialRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly catalogRepo: CatalogRepository;
  private readonly loanRepo: LoanRepository;
  private readonly ingestionService: IngestionService;

  constructor(deps: {
    db: DatabaseAdapter;
    socialRepo: SocialRepository;
    libraryRepo: LibraryRepository;
    catalogRepo: CatalogRepository;
    loanRepo: LoanRepository;
    ingestionService: IngestionService;
  }) {
    this.db = deps.db;
    this.socialRepo = deps.socialRepo;
    this.libraryRepo = deps.libraryRepo;
    this.catalogRepo = deps.catalogRepo;
    this.loanRepo = deps.loanRepo;
    this.ingestionService = deps.ingestionService;
  }

  /**
   * Rejoindre le foyer d'un autre membre via code `FAM-...`.
   * Gère proprement le départ de l'ancien foyer (succession owner si partagé, suppression si solo).
   */
  joinFamily(userId: string, rawCode: string): { targetLibraryId: string; targetLibraryName: string } {
    const code = extractTokenCode(rawCode);
    const targetLib = this.libraryRepo.findByFamilyInviteCode(code);
    if (!targetLib) {
      throw new AppError(404, 'INVALID_FAMILY_CODE', 'Code Foyer invalide ou expiré.');
    }

    const currentLib = this.libraryRepo.findLibraryByUserId(userId);
    if (currentLib?.id === targetLib.id) {
      return { targetLibraryId: targetLib.id, targetLibraryName: targetLib.name };
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (currentLib) {
        const otherMembers = this.libraryRepo.listMembers(currentLib.id).filter((m) => m.user_id !== userId);
        if (otherMembers.length === 0) {
          this.libraryRepo.deleteLibrary(currentLib.id);
        } else {
          if (currentLib.owner_user_id === userId) {
            this.libraryRepo.transferOwnership(currentLib.id, otherMembers[0].user_id, now);
          }
          this.libraryRepo.removeMember(currentLib.id, userId);
        }
      }
      this.libraryRepo.addMember(targetLib.id, userId, 'member', now);
    });

    return { targetLibraryId: targetLib.id, targetLibraryName: targetLib.name };
  }

  /**
   * Met à jour la politique de départ du foyer (réservé au propriétaire / chef du foyer).
   */
  updateFamilyDetachPolicy(
    libraryId: string,
    actorUserId: string,
    detachPolicy: FamilyDetachPolicy
  ): { detachPolicy: FamilyDetachPolicy } {
    const lib = this.libraryRepo.findLibraryById(libraryId);
    if (!lib) {
      throw new AppError(404, 'LIBRARY_NOT_FOUND', 'Foyer introuvable.');
    }
    if (lib.owner_user_id !== actorUserId) {
      throw new AppError(
        403,
        'FORBIDDEN_NOT_OWNER',
        'Seul le propriétaire du foyer peut modifier la règle de départ.'
      );
    }
    this.libraryRepo.updateDetachPolicy(libraryId, detachPolicy, new Date().toISOString());
    return { detachPolicy };
  }

  /**
   * Prépare l'aperçu de détachement/départ d'un membre du foyer (séries, livres, wishlist, prêts actifs & droits).
   */
  getFamilyDetachPreview(input: {
    libraryId: string;
    actorUserId: string;
    targetUserIdParam: string;
  }): FamilyDetachPreviewPayload {
    const lib = this.libraryRepo.findLibraryById(input.libraryId);
    if (!lib) {
      throw new AppError(404, 'LIBRARY_NOT_FOUND', 'Foyer introuvable.');
    }
    const members = this.libraryRepo.listMembers(lib.id);
    if (members.length < 2) {
      throw new AppError(
        400,
        'CANNOT_DETACH_SOLO_LIBRARY',
        'Vous êtes le seul membre de ce foyer : aucun détachement nécessaire.'
      );
    }

    const resolvedTargetId = input.targetUserIdParam === 'me' ? input.actorUserId : input.targetUserIdParam;
    const targetMember = members.find((m) => m.user_id === resolvedTargetId);
    if (!targetMember) {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Ce membre ne fait pas partie de votre foyer.');
    }

    const isActorOwner = lib.owner_user_id === input.actorUserId;
    const isSelfDetach = resolvedTargetId === input.actorUserId;
    if (!isSelfDetach && !isActorOwner) {
      throw new AppError(
        403,
        'FORBIDDEN_NOT_OWNER',
        'Seul le propriétaire du foyer peut détacher un autre membre.'
      );
    }

    const detachPolicy: FamilyDetachPolicy =
      lib.detach_policy === 'owner_only' ? 'owner_only' : 'member_choice';
    const canTransferOwned = isActorOwner || detachPolicy === 'member_choice';

    const remainingMembers = members.filter((m) => m.user_id !== resolvedTargetId);
    const willTransferOwnershipTo =
      lib.owner_user_id === resolvedTargetId && remainingMembers.length > 0
        ? {
            userId: remainingMembers[0].user_id,
            username: remainingMembers[0].username || ''
          }
        : null;

    const libRows = this.libraryRepo.listLibraryBooks(lib.id);
    const activeLoansByBook = new Map(
      this.loanRepo.listActiveLoans(lib.id).map((l) => [l.book_id, l])
    );
    const usernames = this.libraryRepo.mapUsernamesByIds(
      libRows.map((r) => r.wished_by_user_id).filter((id): id is string => Boolean(id))
    );

    const books: FamilyDetachBookItem[] = [];
    const preselectedBookIds: string[] = [];

    for (const lr of libRows) {
      if (lr.deleted_at || (lr.status !== 'owned' && lr.status !== 'wish')) continue;
      if (!canTransferOwned && !(lr.status === 'wish' && lr.wished_by_user_id === resolvedTargetId)) {
        continue;
      }
      const bookRow = this.catalogRepo.findBookById(lr.book_id);
      if (!bookRow) continue;
      const merged = this.ingestionService.buildMergedBookView(bookRow, lr);
      const activeLoan = activeLoansByBook.get(bookRow.id) ?? null;

      books.push({
        id: merged.id,
        title: merged.title,
        seriesId: merged.seriesId,
        seriesName: merged.seriesName,
        volumeNumber: merged.volumeNumber,
        volumeLabel: merged.volumeLabel,
        isIntegral: merged.isIntegral,
        includedVolumes: merged.includedVolumes,
        authors: merged.authors,
        mainCategory: merged.mainCategory,
        genres: merged.genres,
        coverUrl: merged.coverUrl,
        ownershipStatus: lr.status,
        wishedByUserId: lr.wished_by_user_id ?? null,
        wishedByName: lr.wished_by_user_id ? (usernames.get(lr.wished_by_user_id) ?? null) : null,
        activeLoan: activeLoan
          ? { borrowerName: activeLoan.borrower_name, loanedAt: activeLoan.loaned_at }
          : null
      });

      if (lr.status === 'wish' && lr.wished_by_user_id === resolvedTargetId) {
        preselectedBookIds.push(merged.id);
      }
    }

    const targetName = targetMember.username || 'Membre';
    return {
      libraryId: lib.id,
      libraryName: lib.name,
      detachPolicy,
      isActorOwner,
      isSelfDetach,
      canTransferOwned,
      targetMember: {
        userId: targetMember.user_id,
        username: targetName,
        role: targetMember.role
      },
      willTransferOwnershipTo,
      defaultNewLibraryName: `Foyer de ${targetName}`,
      preselectedBookIds,
      books
    };
  }

  /**
   * Détache un membre du foyer dans une transaction SQLite atomique :
   * - Crée un foyer indépendant pour le membre sortant (owner + codes FAM/PUB neufs)
   * - Promeut le membre le plus ancien si le propriétaire quitte le foyer
   * - Transfère (Déplacer ou Copier) les livres sélectionnés en préservant les surcharges Couche 3
   * - Gère les prêts actifs (transfer / return / skip) et déplace silencieusement les réservations cadeaux (anti-spoiler)
   * - Crée optionnellement le lien Ami bidirectionnel entre les 2 foyers
   */
  detachFamilyMember(input: {
    libraryId: string;
    actorUserId: string;
    targetUserId: string;
    mode: 'move' | 'copy';
    bookIds: string[];
    loanDecisions: Record<string, 'transfer' | 'return' | 'skip'>;
    keepAsFriends: boolean;
    newLibraryName?: string;
  }): FamilyDetachResult {
    const lib = this.libraryRepo.findLibraryById(input.libraryId);
    if (!lib) {
      throw new AppError(404, 'LIBRARY_NOT_FOUND', 'Foyer introuvable.');
    }
    const members = this.libraryRepo.listMembers(lib.id);
    if (members.length < 2) {
      throw new AppError(
        400,
        'CANNOT_DETACH_SOLO_LIBRARY',
        'Impossible de détacher le seul membre du foyer.'
      );
    }

    const resolvedTargetId = input.targetUserId === 'me' ? input.actorUserId : input.targetUserId;
    const targetMember = members.find((m) => m.user_id === resolvedTargetId);
    if (!targetMember) {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Ce membre ne fait pas partie de votre foyer.');
    }

    const isActorOwner = lib.owner_user_id === input.actorUserId;
    const isSelfDetach = resolvedTargetId === input.actorUserId;
    if (!isSelfDetach && !isActorOwner) {
      throw new AppError(
        403,
        'FORBIDDEN_NOT_OWNER',
        'Seul le propriétaire du foyer peut détacher un autre membre.'
      );
    }

    const detachPolicy: FamilyDetachPolicy =
      lib.detach_policy === 'owner_only' ? 'owner_only' : 'member_choice';
    const canTransferOwned = isActorOwner || detachPolicy === 'member_choice';

    const remainingMembers = members.filter((m) => m.user_id !== resolvedTargetId);
    const targetUsername = targetMember.username || 'Membre';
    const finalNewLibraryName = input.newLibraryName?.trim() || `Foyer de ${targetUsername}`;
    const newLibraryId = `lib_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    const uniqueBookIds = Array.from(new Set(input.bookIds));
    if (!canTransferOwned) {
      for (const bookId of uniqueBookIds) {
        const lr = this.libraryRepo.findLibraryBook(lib.id, bookId);
        if (!lr || lr.deleted_at) continue;
        if (lr.status === 'owned' || (lr.status === 'wish' && lr.wished_by_user_id !== resolvedTargetId)) {
          throw new AppError(
            403,
            'FORBIDDEN_DETACH_POLICY',
            'Selon la politique de ce foyer, seul le chef de foyer peut transférer des livres possédés ou les souhaits d’autres membres.'
          );
        }
      }
    }
    let transferredOwnedCount = 0;
    let transferredWishCount = 0;
    let transferredLoansCount = 0;
    let promotedOwnerUsername: string | null = null;

    this.db.transaction(() => {
      // 1. Créer le nouveau foyer indépendant du membre sortant
      this.libraryRepo.createLibrary({
        id: newLibraryId,
        name: finalNewLibraryName,
        ownerUserId: resolvedTargetId,
        familyInviteCode: generateShareCode('FAM'),
        friendShareToken: generateShareCode('PUB'),
        now
      });

      // 2. Succession owner si le propriétaire actuel quitte le foyer
      if (lib.owner_user_id === resolvedTargetId && remainingMembers.length > 0) {
        this.libraryRepo.transferOwnership(lib.id, remainingMembers[0].user_id, now);
        promotedOwnerUsername = remainingMembers[0].username || null;
      }

      // 3. Retirer le membre de l'ancien foyer
      this.libraryRepo.removeMember(lib.id, resolvedTargetId);

      // 4. Transférer les ouvrages sélectionnés (Couche 3 préservée)
      for (const bookId of uniqueBookIds) {
        const lr = this.libraryRepo.findLibraryBook(lib.id, bookId);
        if (!lr || lr.deleted_at || (lr.status !== 'owned' && lr.status !== 'wish')) {
          continue;
        }
        if (!canTransferOwned && !(lr.status === 'wish' && lr.wished_by_user_id === resolvedTargetId)) {
          continue;
        }

        const activeLoan = this.loanRepo.findActiveLoanByBook(lib.id, bookId);
        if (activeLoan && input.mode === 'move') {
          const decision = input.loanDecisions[bookId] ?? 'transfer';
          if (decision === 'skip') {
            continue;
          }
          if (decision === 'return') {
            this.loanRepo.markReturnedByBook(lib.id, bookId, now);
          } else if (decision === 'transfer') {
            if (this.loanRepo.moveActiveLoanToLibrary(lib.id, newLibraryId, bookId, now)) {
              transferredLoansCount++;
            }
          }
        }

        this.libraryRepo.copyLibraryBookToTarget(
          lr,
          newLibraryId,
          lr.status === 'wish' ? resolvedTargetId : null,
          now
        );

        if (input.mode === 'move') {
          // Déplacement silencieux des réservations cadeaux (zéro spoiler!)
          if (lr.status === 'wish') {
            this.socialRepo.moveReservationToLibrary(lib.id, newLibraryId, bookId);
          }
          this.libraryRepo.softRemoveLibraryBook(lib.id, bookId, now);
        }

        if (lr.status === 'owned') transferredOwnedCount++;
        else if (lr.status === 'wish') transferredWishCount++;
      }

      // 5. Option « Rester amis automatiquement » (bidirectionnel)
      if (input.keepAsFriends) {
        this.libraryRepo.addFriendConnection(resolvedTargetId, lib.id, now);
        for (const rem of remainingMembers) {
          this.libraryRepo.addFriendConnection(rem.user_id, newLibraryId, now);
        }
      }
    });

    return {
      newLibraryId,
      newLibraryName: finalNewLibraryName,
      targetUserId: resolvedTargetId,
      targetUsername,
      selfDetached: isSelfDetach,
      promotedOwnerUsername,
      mode: input.mode,
      transferredOwnedCount,
      transferredWishCount,
      transferredLoansCount,
      keptAsFriends: input.keepAsFriends
    };
  }

  /**
   * Régénère le code Foyer (`FAM-...`) ou le code Amis (`PUB-...`), révoquant immédiatement l'ancien lien.
   */
  regenerateToken(libraryId: string, tokenType: 'family' | 'friend'): { newCode: string } {
    const now = new Date().toISOString();
    if (tokenType === 'family') {
      const newCode = generateShareCode('FAM');
      this.socialRepo.updateFamilyInviteCode(libraryId, newCode, now);
      return { newCode };
    }
    const newCode = generateShareCode('PUB');
    this.socialRepo.updateFriendShareToken(libraryId, newCode, now);
    return { newCode };
  }

  listFriends(userId: string) {
    return this.socialRepo.listFriendsForUser(userId).map((row) => ({
      libraryId: row.target_library_id,
      libraryName: row.library_name,
      ownerUsername: row.owner_username,
      shareToken: row.friend_share_token,
      connectedAt: row.connected_at,
      deletedAt: row.deleted_at,
      ownedCount: Number(row.owned_count ?? 0),
      wishCount: Number(row.wish_count ?? 0)
    }));
  }

  listRemovedFriends(userId: string) {
    return this.socialRepo.listRemovedFriendsForUser(userId).map((row) => ({
      libraryId: row.target_library_id,
      libraryName: row.library_name,
      ownerUsername: row.owner_username,
      shareToken: row.friend_share_token,
      connectedAt: row.connected_at,
      deletedAt: row.deleted_at,
      ownedCount: Number(row.owned_count ?? 0),
      wishCount: Number(row.wish_count ?? 0)
    }));
  }

  addFriend(userId: string, myLibraryId: string, rawTokenOrUrl: string): { libraryId: string; ownerUsername: string } {
    const token = extractTokenCode(rawTokenOrUrl);
    const targetLib = this.libraryRepo.findByFriendShareToken(token);
    if (!targetLib) {
      throw new AppError(404, 'INVALID_FRIEND_TOKEN', 'Code ou lien ami invalide ou révoqué.');
    }
    if (targetLib.id === myLibraryId) {
      throw new AppError(400, 'CANNOT_FOLLOW_SELF', 'Vous ne pouvez pas ajouter votre propre foyer en ami.');
    }

    const now = new Date().toISOString();
    this.libraryRepo.addFriendConnection(userId, targetLib.id, now);
    const ownerName = this.libraryRepo.mapUsernamesByIds([targetLib.owner_user_id]).get(targetLib.owner_user_id) ?? '';
    return { libraryId: targetLib.id, ownerUsername: ownerName };
  }

  removeFriend(userId: string, targetLibraryId: string): void {
    this.socialRepo.removeFriendConnection(userId, targetLibraryId, new Date().toISOString());
  }

  restoreFriend(userId: string, targetLibraryId: string): void {
    const restored = this.socialRepo.restoreFriendConnection(userId, targetLibraryId);
    if (!restored) {
      throw new AppError(404, 'FRIEND_NOT_FOUND', 'Ami retiré introuvable.');
    }
  }

  /**
   * Vitrine lecture seule d'un ami (`GET /api/social/share/:token`).
   * - Masque TOUJOURS les noms d'emprunteurs (`isLent` uniquement).
   * - Masque STRICTEMENT `wishlist_reservations` si `viewerAuth` appartient au foyer propriétaire (anti-spoiler).
   */
  getSharedLibraryByToken(token: string, viewerAuth: AuthSessionContext | null): SharedLibraryPayload {
    const cleanToken = extractTokenCode(token);
    const lib = this.libraryRepo.findByFriendShareToken(cleanToken);
    if (!lib) {
      throw new AppError(404, 'SHARED_LIBRARY_NOT_FOUND', 'Bibliothèque introuvable ou lien révoqué.');
    }

    const isOwnLibrary = Boolean(viewerAuth && viewerAuth.libraryId === lib.id);
    const canReserveGifts = Boolean(viewerAuth && !isOwnLibrary);

    const ownerUsername = this.libraryRepo.mapUsernamesByIds([lib.owner_user_id]).get(lib.owner_user_id) ?? '';
    const libRows = this.libraryRepo.listLibraryBooks(lib.id);
    const activeLoanBookIds = new Set(this.loanRepo.listActiveLoans(lib.id).map((l) => l.book_id));

    // Anti-spoiler : on ne charge même pas les réservations si le viewer appartient au foyer propriétaire !
    const reservationsByBookId = new Map<string, string>();
    if (!isOwnLibrary && viewerAuth) {
      for (const res of this.socialRepo.listReservationsForLibrary(lib.id)) {
        reservationsByBookId.set(res.book_id, res.reserved_by_user_id);
      }
    }

    const books: SharedBookView[] = [];
    for (const lr of libRows) {
      if (lr.deleted_at || (lr.status !== 'owned' && lr.status !== 'wish')) continue;
      const bookRow = this.catalogRepo.findBookById(lr.book_id);
      if (!bookRow) continue;
      const merged = this.ingestionService.buildMergedBookView(bookRow, lr);

      let giftReservation: GiftReservationStatus | null = null;
      if (lr.status === 'wish' && canReserveGifts && viewerAuth) {
        const reservedBy = reservationsByBookId.get(bookRow.id);
        if (!reservedBy) giftReservation = 'available';
        else if (reservedBy === viewerAuth.userId) giftReservation = 'reserved_by_me';
        else giftReservation = 'reserved_by_other';
      }

      books.push({
        id: merged.id,
        title: merged.title,
        seriesId: merged.seriesId,
        seriesName: merged.seriesName,
        volumeLabel: merged.volumeLabel,
        isIntegral: merged.isIntegral,
        includedVolumes: merged.includedVolumes,
        authors: merged.authors,
        publisher: merged.publisher,
        mainCategory: merged.mainCategory,
        genres: merged.genres,
        coverUrl: merged.coverUrl,
        ownershipStatus: lr.status,
        isLent: activeLoanBookIds.has(bookRow.id),
        giftReservation
      });
    }

    let alreadyFriend = false;
    if (viewerAuth && !isOwnLibrary) {
      alreadyFriend = this.socialRepo
        .listFriendsForUser(viewerAuth.userId)
        .some((f) => f.target_library_id === lib.id);
    }

    return {
      libraryId: lib.id,
      libraryName: lib.name,
      ownerUsername,
      isOwnLibrary,
      canReserveGifts,
      alreadyFriend,
      books
    };
  }

  /**
   * Réserve un cadeau sur la wishlist d'un ami (`POST /api/social/share/:token/reserve/:bookId`).
   * Strictement réservé aux utilisateurs inscrits et connectés HORS foyer propriétaire.
   */
  reserveGift(input: {
    token: string;
    bookId: string;
    viewerUserId: string;
    viewerLibraryId: string;
  }): { status: GiftReservationStatus } {
    const lib = this.libraryRepo.findByFriendShareToken(extractTokenCode(input.token));
    if (!lib) {
      throw new AppError(404, 'SHARED_LIBRARY_NOT_FOUND', 'Bibliothèque introuvable ou lien révoqué.');
    }
    if (lib.id === input.viewerLibraryId) {
      throw new AppError(403, 'FORBIDDEN_SELF_RESERVE', 'Vous ne pouvez pas réserver un livre sur votre propre wishlist.');
    }

    const libBook = this.libraryRepo.findLibraryBook(lib.id, input.bookId);
    if (!libBook || libBook.deleted_at || libBook.status !== 'wish') {
      throw new AppError(400, 'BOOK_NOT_IN_WISHLIST', 'Cet ouvrage ne fait plus partie de la wishlist.');
    }

    const existing = this.socialRepo.findReservation(lib.id, input.bookId);
    if (existing) {
      if (existing.reserved_by_user_id === input.viewerUserId) {
        return { status: 'reserved_by_me' };
      }
      throw new AppError(409, 'ALREADY_RESERVED', 'Ce cadeau est déjà réservé par un autre proche.');
    }

    this.socialRepo.createReservation(lib.id, input.bookId, input.viewerUserId, new Date().toISOString());
    return { status: 'reserved_by_me' };
  }

  cancelGiftReservation(input: {
    token: string;
    bookId: string;
    viewerUserId: string;
    viewerLibraryId: string;
  }): { status: GiftReservationStatus } {
    const lib = this.libraryRepo.findByFriendShareToken(extractTokenCode(input.token));
    if (!lib) {
      throw new AppError(404, 'SHARED_LIBRARY_NOT_FOUND', 'Bibliothèque introuvable ou lien révoqué.');
    }
    if (lib.id === input.viewerLibraryId) {
      throw new AppError(403, 'FORBIDDEN_SELF_RESERVE', 'Action non autorisée sur votre propre foyer.');
    }
    this.socialRepo.deleteReservationByUser(lib.id, input.bookId, input.viewerUserId);
    return { status: 'available' };
  }
}
