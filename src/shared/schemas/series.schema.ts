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
