// src/server/repositories/loan.repo.ts
// Repository SQL pur pour loans et borrower_contacts (Espace Foyer).

import type { DatabaseAdapter } from '../db/database.adapter';

export interface LoanRow {
  id: string;
  library_id: string;
  book_id: string;
  borrower_name: string;
  loaned_at: string;
  returned_at: string | null;
  notes: string | null;
  updated_at: string;
}

export interface BorrowerContactRow {
  library_id: string;
  name: string;
  last_used_at: string;
}

export class LoanRepository {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  findActiveLoanByBook(libraryId: string, bookId: string): LoanRow | null {
    return this.db.get<LoanRow>(
      'SELECT * FROM loans WHERE library_id = ? AND book_id = ? AND returned_at IS NULL ORDER BY loaned_at DESC LIMIT 1',
      [libraryId, bookId]
    );
  }

  findLatestLoanByBook(libraryId: string, bookId: string): LoanRow | null {
    return this.db.get<LoanRow>(
      'SELECT * FROM loans WHERE library_id = ? AND book_id = ? ORDER BY updated_at DESC LIMIT 1',
      [libraryId, bookId]
    );
  }

  listActiveLoans(libraryId: string): LoanRow[] {
    return this.db.all<LoanRow>(
      'SELECT * FROM loans WHERE library_id = ? AND returned_at IS NULL ORDER BY loaned_at DESC',
      [libraryId]
    );
  }

  listLoansSince(libraryId: string, since?: string): LoanRow[] {
    if (since) {
      return this.db.all<LoanRow>(
        'SELECT * FROM loans WHERE library_id = ? AND updated_at > ? ORDER BY loaned_at DESC',
        [libraryId, since]
      );
    }
    return this.listActiveLoans(libraryId);
  }

  createLoan(input: {
    id: string;
    libraryId: string;
    bookId: string;
    borrowerName: string;
    notes?: string | null;
    now: string;
  }): LoanRow {
    // Clôturer un éventuel prêt actif précédent sur le même livre par sécurité
    this.db.run(
      'UPDATE loans SET returned_at = ?, updated_at = ? WHERE library_id = ? AND book_id = ? AND returned_at IS NULL',
      [input.now, input.now, input.libraryId, input.bookId]
    );

    this.db.run(
      `INSERT INTO loans (id, library_id, book_id, borrower_name, loaned_at, returned_at, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        input.id,
        input.libraryId,
        input.bookId,
        input.borrowerName.trim(),
        input.now,
        input.notes ?? null,
        input.now
      ]
    );

    this.upsertContact(input.libraryId, input.borrowerName.trim(), input.now);
    return this.findActiveLoanByBook(input.libraryId, input.bookId)!;
  }

  markReturnedByBook(libraryId: string, bookId: string, now: string): boolean {
    const res = this.db.run(
      'UPDATE loans SET returned_at = ?, updated_at = ? WHERE library_id = ? AND book_id = ? AND returned_at IS NULL',
      [now, now, libraryId, bookId]
    );
    return res.changes > 0;
  }

  transferActiveLoans(libraryId: string, fromBookId: string, toBookId: string, now: string): number {
    if (fromBookId === toBookId) return 0;
    const res = this.db.run(
      'UPDATE loans SET book_id = ?, updated_at = ? WHERE library_id = ? AND book_id = ? AND returned_at IS NULL',
      [toBookId, now, libraryId, fromBookId]
    );
    return res.changes;
  }

  moveActiveLoanToLibrary(
    fromLibraryId: string,
    toLibraryId: string,
    bookId: string,
    now: string
  ): boolean {
    const active = this.findActiveLoanByBook(fromLibraryId, bookId);
    if (!active) return false;
    const res = this.db.run(
      'UPDATE loans SET library_id = ?, updated_at = ? WHERE id = ?',
      [toLibraryId, now, active.id]
    );
    if (res.changes > 0) {
      this.upsertContact(toLibraryId, active.borrower_name, now);
      return true;
    }
    return false;
  }

  upsertContact(libraryId: string, name: string, now: string): void {
    const clean = name.trim();
    if (!clean) return;
    this.db.run(
      `INSERT INTO borrower_contacts (library_id, name, last_used_at)
       VALUES (?, ?, ?)
       ON CONFLICT(library_id, name) DO UPDATE SET last_used_at = excluded.last_used_at`,
      [libraryId, clean, now]
    );
  }

  listContacts(libraryId: string): BorrowerContactRow[] {
    return this.db.all<BorrowerContactRow>(
      'SELECT * FROM borrower_contacts WHERE library_id = ? ORDER BY last_used_at DESC LIMIT 100',
      [libraryId]
    );
  }
}
