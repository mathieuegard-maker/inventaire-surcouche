// src/shared/schemas/series.schema.ts
import { z } from 'zod';

export const attachSeriesSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(200),
  targetSeriesId: z.string().trim().optional(),
  newSeriesName: z.string().trim().min(1).max(200).optional(),
  mergeEntireSourceSeriesId: z.string().trim().optional(),
  volumeType: z.enum(['standard', 'hors_serie', 'integrale', 'unnumbered']).optional(),
  volumeLabel: z.string().trim().max(40).nullable().optional(),
  sortOrder: z.number().nullable().optional()
});

export const excludeFromSeriesSchema = z.object({
  bookIds: z.array(z.string().trim().min(1)).min(1).max(200)
});
