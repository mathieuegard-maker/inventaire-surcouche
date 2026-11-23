// src/server/services/sync.service.ts
// Protocole de synchronisation hors-ligne strict : PUSH outbox d'abord (LWW par timestamp), PULL delta ensuite.

import crypto from 'node:crypto';
import type { SyncOutboxOperation } from '../../shared/schemas';
import type { LibraryRepository } from '../repositories/library.repo';
import type { LoanRepository } from '../repositories/loan.repo';
import type { ReadingRepository } from '../repositories/reading.repo';
import type { IngestionService } from './acquisition/ingestion.service';
import type { LibraryService, SyncPullPayload } from './library.service';

export interface SyncPushOpOutcome {
  id: string;
  applied: boolean;
  reason?: string;
}

export interface SyncPushResult {
  serverTime: string;
  results: SyncPushOpOutcome[];
}

export class SyncService {
  private readonly libraryRepo: LibraryRepository;
  private readonly loanRepo: LoanRepository;
  private readonly readingRepo: ReadingRepository;
  private readonly ingestionService: IngestionService;
  private readonly libraryService: LibraryService;

  constructor(deps: {
    libraryRepo: LibraryRepository;
    loanRepo: LoanRepository;
    readingRepo: ReadingRepository;
    ingestionService: IngestionService;
    libraryService: LibraryService;
  }) {
    this.libraryRepo = deps.libraryRepo;
    this.loanRepo = deps.loanRepo;
    this.readingRepo = deps.readingRepo;
    this.ingestionService = deps.ingestionService;
    this.libraryService = deps.libraryService;
  }

  /**
   * Étape 1 à la reconnexion : applique toute l'outbox offline dans l'ordre chronologique.
   * En cas de conflit simultané entre 2 membres sur le même champ, le timestamp le plus récent gagne (Last-Write-Wins).
   */
  async pushOutbox(input: {
    libraryId: string;
    userId: string;
    operations: SyncOutboxOperation[];
  }): Promise<SyncPushResult> {
    const ordered = [...input.operations].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const results: SyncPushOpOutcome[] = [];

    for (const op of ordered) {
      if (op.op === 'SET_STATUS') {
        const res = this.libraryRepo.upsertLibraryBookStatusLww({
          libraryId: input.libraryId,
          bookId: op.bookId,
          status: op.status,
          wishedByUserId: op.status === 'wish' ? input.userId : null,
          timestamp: op.timestamp
        });
        results.push({
          id: op.id,
          applied: res.applied,
          reason: res.applied ? undefined : 'stale_timestamp_lww'
        });
      } else if (op.op === 'LEND') {
        const latest = this.loanRepo.findLatestLoanByBook(input.libraryId, op.bookId);
        if (latest && latest.updated_at > op.timestamp) {
          results.push({ id: op.id, applied: false, reason: 'stale_timestamp_lww' });
        } else {
          this.loanRepo.createLoan({
            id: `ln_${crypto.randomBytes(6).toString('hex')}`,
            libraryId: input.libraryId,
            bookId: op.bookId,
            borrowerName: op.borrowerName,
            now: op.timestamp
          });
          results.push({ id: op.id, applied: true });
        }
      } else if (op.op === 'RETURN') {
        const latest = this.loanRepo.findLatestLoanByBook(input.libraryId, op.bookId);
        if (latest && latest.updated_at > op.timestamp) {
          results.push({ id: op.id, applied: false, reason: 'stale_timestamp_lww' });
        } else {
          const changed = this.loanRepo.markReturnedByBook(input.libraryId, op.bookId, op.timestamp);
          results.push({
            id: op.id,
            applied: changed,
            reason: changed ? undefined : 'no_active_loan'
          });
        }
      } else if (op.op === 'SET_READING') {
        const res = this.readingRepo.upsertReadingState({
          userId: input.userId,
          bookId: op.bookId,
          status: op.status,
          rating: op.rating,
          notes: op.notes,
          timestamp: op.timestamp
        });
        results.push({
          id: op.id,
          applied: res.applied,
          reason: res.applied ? undefined : 'stale_timestamp_lww'
        });
      } else if (op.op === 'OFFLINE_SCAN') {
        try {
          await this.ingestionService.resolveIsbns({
            rawIsbns: [op.isbn13],
            channel: 'barcode_simple',
            action: 'preview',
            userId: input.userId,
            libraryId: input.libraryId
          });
          results.push({ id: op.id, applied: true });
        } catch {
          results.push({ id: op.id, applied: false, reason: 'resolve_failed' });
        }
      }
    }

    return {
      serverTime: new Date().toISOString(),
      results
    };
  }

  /**
   * Étape 2 à la reconnexion : tire le delta serveur (ou snapshot complet si `since` absent).
   */
  pullDelta(input: { libraryId: string; userId: string; since?: string }): SyncPullPayload {
    return this.libraryService.buildSyncPullPayload(input.libraryId, input.userId, input.since);
  }
}
