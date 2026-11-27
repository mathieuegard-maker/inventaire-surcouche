// src/shared/schemas/social.schema.ts
import { z } from 'zod';

export const joinFamilySchema = z.object({
  inviteCode: z.string().trim().min(4).max(80)
});

export const updateFamilyPolicySchema = z.object({
  detachPolicy: z.enum(['member_choice', 'owner_only'])
});

export const detachFamilyMemberSchema = z.object({
  targetUserId: z.string().trim().min(1).max(80),
  mode: z.enum(['move', 'copy']).default('move'),
  bookIds: z.array(z.string().trim().min(1).max(80)).max(5000).default([]),
  loanDecisions: z.record(z.string().min(1), z.enum(['transfer', 'return', 'skip'])).default({}),
  keepAsFriends: z.boolean().default(true),
  newLibraryName: z.string().trim().min(2).max(80).optional()
});

export const regenerateTokenSchema = z.object({
  tokenType: z.enum(['family', 'friend'])
});

export const addFriendSchema = z.object({
  shareToken: z.string().trim().min(4).max(120)
});

export const notificationPrefsSchema = z.object({
  frequency: z.enum(['off', 'daily', 'weekly', 'monthly']),
  dayOfWeek: z.number().int().min(0).max(6).default(6),
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  hour: z.number().int().min(0).max(23).default(9),
  timezone: z.string().trim().min(2).max(80).default('Europe/Paris'),
  channel: z.enum(['push', 'email', 'both']).default('push')
});

export const pushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});
