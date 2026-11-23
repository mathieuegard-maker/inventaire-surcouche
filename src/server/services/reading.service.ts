// src/server/services/reading.service.ts
// Service métier Lecture / Note / Notes personnelles (strictement isolé par user_id).

import type { ReadingStatus, UserReadingStateView } from '../../shared/types/domain.types';
import type { ReadingRepository } from '../repositories/reading.repo';

export class ReadingService {
  private readonly readingRepo: ReadingRepository;

  constructor(deps: { readingRepo: ReadingRepository }) {
    this.readingRepo = deps.readingRepo;
  }

  getReadingState(userId: string, bookId: string): UserReadingStateView | null {
    const row = this.readingRepo.findByUserAndBook(userId, bookId);
    if (!row) return null;
    return {
      status: row.status,
      rating: row.rating,
      notes: row.notes,
      updatedAt: row.updated_at
    };
  }

  saveReadingState(input: {
    userId: string;
    bookId: string;
    status: ReadingStatus;
    rating: number;
    notes: string;
    now?: string;
  }): UserReadingStateView {
    const timestamp = input.now ?? new Date().toISOString();
    const { row } = this.readingRepo.upsertReadingState({
      userId: input.userId,
      bookId: input.bookId,
      status: input.status,
      rating: input.rating,
      notes: input.notes,
      timestamp
    });
    return {
      status: row.status,
      rating: row.rating,
      notes: row.notes,
      updatedAt: row.updated_at
    };
  }
}
