// src/shared/schemas/book.schema.ts
import { z } from 'zod';

export const bookMainCategorySchema = z.enum([
  'BD',
  'Manga',
  'Comics',
  'Roman',
  'Jeunesse',
  'Essai',
  'Poésie / Théâtre',
  'Pratique',
  'Art / Beau livre',
  'Autre'
]);

export const ownershipStatusSchema = z.enum(['none', 'wish', 'owned']);
export const readingStatusSchema = z.enum(['none', 'to_read', 'reading', 'read', 'abandoned']);
export const acquisitionChannelSchema = z.enum([
  'barcode_simple',
  'barcode_burst',
  'manual_isbn',
  'text_search',
  'photo_ai'
]);

export const resolveIsbnSchema = z.object({
  isbns: z.array(z.string().trim().min(10).max(20)).min(1).max(50),
  channel: acquisitionChannelSchema.default('barcode_simple'),
  action: z.enum(['preview', 'owned', 'wish']).default('preview')
});

export const manualBookCreateSchema = z.object({
  isbn13: z.string().trim().optional(),
  title: z.string().trim().min(1).max(300),
  authors: z.array(z.string().trim().min(1).max(120)).default([]),
  seriesName: z.string().trim().max(200).nullable().optional(),
  seriesId: z.string().trim().nullable().optional(),
  volumeNumber: z.number().int().positive().nullable().optional(),
  volumeLabel: z.string().trim().max(40).nullable().optional(),
  oneShot: z.boolean().default(false),
  expandSeries: z.boolean().default(false),
  isIntegral: z.boolean().default(false),
  includedVolumes: z.array(z.string().trim()).default([]),
  publisher: z.string().trim().max(150).nullable().optional(),
  publishYear: z.string().trim().max(10).nullable().optional(),
  pageCount: z.number().int().positive().max(20000).nullable().optional(),
  mainCategory: bookMainCategorySchema.optional(),
  genres: z.array(z.string().trim().min(1).max(60)).default([]),
  coverKey: z.string().trim().nullable().optional(),
  ownershipStatus: ownershipStatusSchema.default('owned')
});

export const catalogSearchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  series: z.string().trim().max(200).optional(),
  volumeNumber: z.string().trim().max(20).optional(),
  author: z.string().trim().max(150).optional(),
  collection: z.string().trim().max(150).optional(),
  publisher: z.string().trim().max(150).optional(),
  isbn: z.string().trim().max(25).optional()
});

export const readingStateUpsertSchema = z.object({
  status: readingStatusSchema,
  rating: z.number().int().min(0).max(5),
  notes: z.string().max(5000).default('')
});
