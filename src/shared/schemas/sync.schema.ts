// src/shared/schemas/sync.schema.ts
import { z } from 'zod';
import { ownershipStatusSchema, readingStatusSchema } from './book.schema';

export const syncOutboxItemSchema = z.discriminatedUnion('op', [
  z.object({
    id: z.string().min(1),
    op: z.literal('SET_STATUS'),
    bookId: z.string().min(1),
    status: ownershipStatusSchema,
    timestamp: z.string().datetime()
  }),
  z.object({
    id: z.string().min(1),
    op: z.literal('LEND'),
    bookId: z.string().min(1),
    borrowerName: z.string().trim().min(1).max(120),
    timestamp: z.string().datetime()
  }),
  z.object({
    id: z.string().min(1),
    op: z.literal('RETURN'),
    bookId: z.string().min(1),
    timestamp: z.string().datetime()
  }),
  z.object({
    id: z.string().min(1),
    op: z.literal('SET_READING'),
    bookId: z.string().min(1),
    status: readingStatusSchema,
    rating: z.number().int().min(0).max(5),
    notes: z.string().max(5000),
    timestamp: z.string().datetime()
  }),
  z.object({
    id: z.string().min(1),
    op: z.literal('OFFLINE_SCAN'),
    isbn13: z.string().trim().min(10).max(20),
    timestamp: z.string().datetime()
  })
]);

export const syncPushSchema = z.object({
  operations: z.array(syncOutboxItemSchema).max(500)
});

export type SyncOutboxOperation = z.infer<typeof syncOutboxItemSchema>;
