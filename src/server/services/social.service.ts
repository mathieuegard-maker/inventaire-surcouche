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
import { AppError } from '../middleware/error.middleware';

export type GiftReservationStatus = 'available' | 'reserved_by_me' | 'reserved_by_other';

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
    this.socialRepo.removeFriendConnection(userId, targetLibraryId);
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
