// src/shared/schemas/contact.schema.ts
// Schéma Zod pour le formulaire de contact vers l'administrateur.

import { z } from 'zod';

export const contactCategorySchema = z.enum(['question', 'bug', 'suggestion', 'other']);
export type ContactCategory = z.infer<typeof contactCategorySchema>;

export const contactMessageSchema = z.object({
  email: z.string().trim().email('Adresse e-mail invalide.').max(160),
  senderName: z.string().trim().max(80).optional(),
  category: contactCategorySchema.default('question'),
  subject: z.string().trim().max(140).optional(),
  message: z
    .string()
    .trim()
    .min(10, 'Votre message doit contenir au moins 10 caractères.')
    .max(4000, 'Votre message ne peut pas dépasser 4 000 caractères.'),
  pageUrl: z.string().trim().max(300).optional(),
  // Champ honeypot invisible (doit toujours rester vide pour un utilisateur humain)
  website: z.string().max(200).optional()
});

export type ContactMessageInput = z.infer<typeof contactMessageSchema>;
