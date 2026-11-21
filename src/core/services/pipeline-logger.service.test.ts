import { describe, it, expect, vi } from 'vitest';
import { PipelineTracer, sanitizeLogPayload } from './pipeline-logger.service';
import type { DatabaseBinding } from '../adapters/storage-db.interface';

describe('pipeline-logger.service', () => {
  it('caviarde récursivement les secrets/tokens/cookies avant persistance', () => {
    const clean = sanitizeLogPayload({
      isbn13: '9782014001266',
      apiKey: 'AIzaSySecret123',
      nested: { passwordHash: 'abc', authorization: 'Bearer xyz', title: 'La Serpe d’or' }
    }) as Record<string, any>;

    expect(clean.isbn13).toBe('9782014001266');
    expect(clean.apiKey).toBe('[REDACTED]');
    expect(clean.nested.passwordHash).toBe('[REDACTED]');
    expect(clean.nested.authorization).toBe('[REDACTED]');
    expect(clean.nested.title).toBe('La Serpe d’or');
  });

  it('regroupe les étapes sur un même traceId et écrit en un seul batch non bloquant', async () => {
    const batchSpy = vi.fn().mockResolvedValue([]);
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ stmt: true })
      }),
      batch: batchSpy
    } as unknown as DatabaseBinding;

    const tracer = new PipelineTracer({ traceId: 'tr_test001', sourceChannel: 'PHOTO_SHELF_BATCH' });
    tracer.record('C1', 'ocr', 'ok', '12 tranches lues', { count: 12 }, 410);
    tracer.record('C3', 'bnf', 'warn', 'Pas de tome sur édition pivot', { apiKey: 'secret' }, 180);
    await tracer.flush(mockDb);

    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0][0]).toHaveLength(2);
  });
});
