// src/shared/schemas/auth.schema.ts
import { z } from 'zod';

export const themeIdSchema = z.enum([
  'editorial-light',
  'dark',
  'warm',
  'librairie',
  'studio',
  'atelier-bd',
  'nocturne'
]);
export const localeIdSchema = z.enum(['fr']);

export const registerSchema = z.object({
  username: z.string().trim().min(2).max(50),
  email: z.string().trim().email().max(150),
  password: z.string().min(6).max(128),
  gdprAccepted: z.literal(true),
  inviteCode: z.string().trim().optional(),
  friendToken: z.string().trim().optional()
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(2).max(150),
  password: z.string().min(1).max(128),
  inviteCode: z.string().trim().optional(),
  friendToken: z.string().trim().optional()
});

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(2).max(150)
});

export const resetPasswordSchema = z.object({
  identifier: z.string().trim().min(2).max(150),
  code: z.string().trim().regex(/^\d{6}$/),
  newPassword: z.string().min(6).max(128)
});

export const updateProfileSchema = z.object({
  username: z.string().trim().min(2).max(50).optional(),
  email: z.string().trim().email().max(150).optional(),
  currentPassword: z.string().min(1).max(128).optional(),
  newPassword: z.string().min(6).max(128).optional(),
  theme: themeIdSchema.optional(),
  locale: localeIdSchema.optional(),
  onboardingNotifSeen: z.boolean().optional()
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128)
});

export const updateDefaultGenresSchema = z.object({
  action: z.enum(['add', 'remove', 'reset']),
  genre: z.string().trim().min(1).max(60).optional()
});

export const reorderDefaultGenresSchema = z.object({
  genres: z.array(z.string().trim().min(1).max(60)).min(1).max(100)
});

export const importFieldKeySchema = z.enum([
  'isbn',
  'title',
  'series',
  'volumeNumber',
  'author',
  'scriptwriter',
  'illustrator',
  'colorist',
  'publisher',
  'mainCategory',
  'genres',
  'ownershipStatus',
  'isIntegral',
  'includedVolumes',
  'readingStatus',
  'rating',
  'notes',
  'testCategory'
]);

export const importColumnMappingSchema = z.record(z.string().min(1).max(120), importFieldKeySchema.nullable());

export const collectionImportPreviewRequestSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(16 * 1024 * 1024),
  hasHeaderRow: z.boolean().optional()
});

export const collectionImportRequestSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(16 * 1024 * 1024),
  defaultStatus: z.enum(['owned', 'wish']).default('owned'),
  hasHeaderRow: z.boolean().optional(),
  columnMapping: importColumnMappingSchema.optional()
});
