// src/shared/schemas/series.schema.ts
import { z } from 'zod';

export const attachSeriesSchema = z
  .object({
    bookIds: z.array(z.string().trim().min(1)).max(200).default([]),
    targetSeriesId: z.string().trim().optional(),
    newSeriesName: z.string().trim().min(1).max(200).optional(),
    mergeEntireSourceSeriesId: z.string().trim().optional(),
    volumeType: z.enum(['standard', 'hors_serie', 'integrale', 'unnumbered']).optional(),
    volumeLabel: z.string().trim().max(40).nullable().optional(),
    sortOrder: z.number().nullable().optional()
  })
  .refine((d) => d.bookIds.length > 0 || Boolean(d.mergeEntireSourceSeriesId), {
    message: 'Au moins un livre ou une série source est requis.'
  });

export const excludeFromSeriesSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(200)
});

export const createSeriesIntegralSchema = z.object({
  title: z.string().trim().max(240).optional(),
  includedVolumes: z.array(z.string().trim().min(1)).min(1).max(60),
  sourceBookId: z.string().trim().optional(),
  isbn13: z.string().trim().optional(),
  ownershipStatus: z.enum(['owned', 'wish', 'none']).default('owned')
});

export const seriesEditionTargetSchema = z.object({
  isbn13: z.string().trim().max(20).nullable().optional(),
  publisher: z.string().trim().max(150).nullable().optional(),
  collectionName: z.string().trim().max(150).nullable().optional(),
  isbnPrefix: z.string().trim().max(13).nullable().optional(),
  lineageKey: z.string().trim().max(240).nullable().optional(),
  label: z.string().trim().max(240).nullable().optional()
});

export const previewSeriesEditionCoversSchema = z.object({
  sourceBookId: z.string().trim().min(1),
  targetEdition: seriesEditionTargetSchema
});

export const applySeriesEditionCoversSchema = z.object({
  sourceBookId: z.string().trim().min(1),
  sourceCoverKey: z.string().trim().min(8).max(64),
  scope: z.enum(['single', 'all', 'selected']),
  bookIds: z.array(z.string().trim().min(1)).max(300).default([]),
  targetEdition: seriesEditionTargetSchema.nullable().optional(),
  searchMissingInBackground: z.boolean().default(false)
});
