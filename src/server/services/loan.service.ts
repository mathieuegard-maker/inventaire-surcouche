// src/server/services/loan.service.ts
// Service métier Prêts & Contacts Emprunteurs (Espace Foyer + Amis suivis).

import crypto from 'node:crypto';
import type { ActiveLoanView } from '../../shared/types/domain.types';
import type { LoanRepository, LoanRow } from '../repositories/loan.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';

export interface LoanContactSuggestion {
  name: string;
  isFriend: boolean;
  lastUsedAt: string | null;
}

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function mapLoanRowToView(row: LoanRow): ActiveLoanView {
  return {
    id: row.id,
    bookId: row.book_id,
    borrowerName: row.borrower_name,
    loanedAt: row.loaned_at,
    notes: row.notes
  };
}

export class LoanService {
  private readonly loanRepo: LoanRepository;
  private readonly libraryRepo: LibraryRepository;

  constructor(deps: { loanRepo: LoanRepository; libraryRepo: LibraryRepository }) {
    this.loanRepo = deps.loanRepo;
    this.libraryRepo = deps.libraryRepo;
  }

  listLoansAndContacts(libraryId: string, userId: string): {
    loans: ActiveLoanView[];
    contacts: LoanContactSuggestion[];
  } {
    const activeRows = this.loanRepo.listActiveLoans(libraryId);
    const historicalContacts = this.loanRepo.listContacts(libraryId);
    const friends = this.libraryRepo.listFriendContactsForUser(userId);

    const byKey = new Map<string, LoanContactSuggestion>();

    for (const f of friends) {
      const key = normalizeTextKey(f.name);
      if (!key) continue;
      byKey.set(key, { name: f.name, isFriend: true, lastUsedAt: null });
    }

    for (const c of historicalContacts) {
      const key = normalizeTextKey(c.name);
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) {
        existing.lastUsedAt = c.last_used_at;
      } else {
        byKey.set(key, { name: c.name, isFriend: false, lastUsedAt: c.last_used_at });
      }
    }

    const contacts = Array.from(byKey.values()).sort((a, b) => {
      if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
      if (a.lastUsedAt) return -1;
      if (b.lastUsedAt) return 1;
      return a.name.localeCompare(b.name, 'fr');
    });

    return {
      loans: activeRows.map(mapLoanRowToView),
      contacts
    };
  }

  lendBooks(input: {
    libraryId: string;
    bookIds: string[];
    borrowerName: string;
    notes?: string;
    now?: string;
  }): { loans: ActiveLoanView[] } {
    const now = input.now ?? new Date().toISOString();
    const created: ActiveLoanView[] = [];

    for (const bookId of input.bookIds) {
      const row = this.loanRepo.createLoan({
        id: generateId('ln'),
        libraryId: input.libraryId,
        bookId,
        borrowerName: input.borrowerName,
        notes: input.notes ?? null,
        now
      });
      created.push(mapLoanRowToView(row));
    }

    return { loans: created };
  }

  returnBooks(input: { libraryId: string; bookIds: string[]; now?: string }): { returnedBookIds: string[] } {
    const now = input.now ?? new Date().toISOString();
    const returnedBookIds: string[] = [];

    for (const bookId of input.bookIds) {
      if (this.loanRepo.markReturnedByBook(input.libraryId, bookId, now)) {
        returnedBookIds.push(bookId);
      }
    }

    return { returnedBookIds };
  }
}
