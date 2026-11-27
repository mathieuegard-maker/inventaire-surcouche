// src/shared/schemas/admin.schema.ts
import { z } from 'zod';
import { bookMainCategorySchema } from './book.schema';

export const adminCatalogPatchSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(200),
  patch: z.object({
    title: z.string().trim().min(1).max(300).optional(),
    authors: z.array(z.string().trim().min(1).max(120)).optional(),
    seriesName: z.string().trim().max(200).nullable().optional(),
    volumeNumber: z.number().int().positive().nullable().optional(),
    publisher: z.string().trim().max(150).nullable().optional(),
    publishYear: z.string().trim().max(10).nullable().optional(),
    mainCategory: bookMainCategorySchema.optional(),
    subgenres: z.array(z.string().trim().min(1).max(60)).optional(),
    coverKey: z.string().trim().nullable().optional()
  })
});

export const adminMaintenanceTaskSchema = z.enum([
  'release_sweep',
  'sister_editions',
  'purge_orphan_covers',
  'purge_logs'
]);

export const adminResetCatalogSchema = z.object({
  confirmation: z.literal('VIDER')
});

export const adminBenchmarkGradeSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1)
});

export const adminDefaultGenresSchema = z.object({
  genres: z.array(z.string().trim().min(1).max(60)).min(1).max(100)
});
