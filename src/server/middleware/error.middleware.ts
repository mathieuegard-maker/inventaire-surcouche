// src/server/middleware/error.middleware.ts
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

export class AppError extends Error {
  public readonly status: ContentfulStatusCode;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function handleServerError(err: unknown, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {})
        }
      },
      err.status
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Données invalides.',
          details: err.flatten()
        }
      },
      400
    );
  }

  console.error('[API ERROR]', err);
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Erreur interne du serveur.'
      }
    },
    500
  );
}
