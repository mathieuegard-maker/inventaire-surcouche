// src/server/routes/loans.routes.ts
// Routes Carnet des Prêts : GET /api/loans, POST /api/loans, POST /api/loans/return.

import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createLoanSchema, returnLoanSchema } from '../../shared/schemas';
import type { AppVariables } from '../middleware/auth.middleware';
import type { LoanService } from '../services/loan.service';

export function createLoansRoutes(deps: {
  loanService: LoanService;
  requireAuth: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use('*', deps.requireAuth);

  router.get('/', (c) => {
    const auth = c.get('auth')!;
    const data = deps.loanService.listLoansAndContacts(auth.libraryId, auth.userId);
    return c.json({ ok: true, ...data });
  });

  router.post('/', zValidator('json', createLoanSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const res = deps.loanService.lendBooks({
      libraryId: auth.libraryId,
      bookIds: body.bookIds,
      borrowerName: body.borrowerName,
      notes: body.notes
    });
    return c.json({ ok: true, ...res }, 201);
  });

  router.post('/return', zValidator('json', returnLoanSchema), (c) => {
    const auth = c.get('auth')!;
    const body = c.req.valid('json');
    const res = deps.loanService.returnBooks({
      libraryId: auth.libraryId,
      bookIds: body.bookIds
    });
    return c.json({ ok: true, ...res });
  });

  return router;
}
