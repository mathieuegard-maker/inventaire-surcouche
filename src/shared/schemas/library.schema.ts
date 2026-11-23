// src/shared/schemas/library.schema.ts
import { z } from 'zod';
import { bookMainCategorySchema, ownershipStatusSchema } from './book.schema';

export const libraryBookOverridePatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  authors: z.array(z.string().trim().min(1).max(120)).optional(),
  scriptwriters: z.array(z.string().trim().min(1).max(120)).optional(),
  illustrators: z.array(z.string().trim().min(1).max(120)).optional(),
  seriesId: z.string().trim().nullable().optional(),
  seriesName: z.string().trim().max(200).nullable().optional(),
  volumeNumber: z.number().int().positive().nullable().optional(),
  volumeLabel: z.string().trim().max(40).nullable().optional(),
  sortOrder: z.number().nullable().optional(),
  isHorsSerie: z.boolean().optional(),
  isIntegral: z.boolean().optional(),
  includedVolumes: z.array(z.string().trim()).optional(),
  publisher: z.string().trim().max(150).nullable().optional(),
  publishYear: z.string().trim().max(10).nullable().optional(),
  pageCount: z.number().int().positive().max(20000).nullable().optional(),
  mainCategory: bookMainCategorySchema.optional(),
  genres: z.array(z.string().trim().min(1).max(60)).optional(),
  coverKey: z.string().trim().nullable().optional(),
  oneShotForced: z.boolean().optional(),
  propagateGenresToSeries: z.boolean().optional()
});

export const batchStatusSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(200),
  status: ownershipStatusSchema,
  /** Pour les livres prêtés inclus dans une suppression : bookId -> 'keep' | 'return_and_delete'. */
  lentDecisions: z.record(z.string(), z.enum(['keep', 'return_and_delete'])).optional()
});

export const batchGenresSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(200),
  genres: z.array(z.string().trim().min(1).max(60)).min(1).max(20)
});

export const createLoanSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(100),
  borrowerName: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(1000).optional()
});

export const returnLoanSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(100)
});
