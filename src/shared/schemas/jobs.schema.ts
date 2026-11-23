// src/shared/schemas/jobs.schema.ts
import { z } from 'zod';

export const createPhotoJobSchema = z.object({
  mode: z.enum(['shelf', 'cover']).default('shelf'),
  imageDataUrl: z.string().startsWith('data:image/'),
  mimeType: z.string().trim().default('image/webp')
});

export const updatePhotoJobItemSchema = z.object({
  selected: z.boolean().optional(),
  ignored: z.boolean().optional(),
  selectedOptionIsbn13: z.string().trim().nullable().optional(),
  isIntegral: z.boolean().optional(),
  includedVolumes: z.array(z.string().trim()).optional()
});

export const retryPhotoItemBnfSchema = z.object({
  title: z.string().trim().max(200).optional(),
  series: z.string().trim().max(200).optional(),
  volumeNumber: z.string().trim().max(20).optional(),
  author: z.string().trim().max(150).optional(),
  publisher: z.string().trim().max(150).optional(),
  isbn: z.string().trim().max(25).optional()
});

export const commitPhotoJobSchema = z.object({
  targetStatus: z.enum(['owned', 'wish']).default('owned'),
  itemIds: z.array(z.string().trim().min(1)).optional()
});
