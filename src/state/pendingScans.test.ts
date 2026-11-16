import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pendingScansStore } from './pendingScans';

describe('pendingScansStore', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; }
    });
    pendingScansStore.clearAll();
  });

  it('normalise et mémorise un code-barres hors-ligne sans doublon', () => {
    pendingScansStore.addPendingScan('2-203-00110-0'); // ISBN-10 de 9782203001107
    pendingScansStore.addPendingScan('978-2-203-00110-7');
    pendingScansStore.addPendingScan('9782803613625');

    expect(pendingScansStore.pendingScans.value).toHaveLength(2);
    expect(pendingScansStore.pendingScans.value.map((s) => s.isbn)).toEqual([
      '9782803613625',
      '9782203001107'
    ]);
  });

  it('supprime un scan mémorisé dès sa consultation ou suppression manuelle', () => {
    pendingScansStore.addPendingScan('9782203001107');
    pendingScansStore.removePendingScan('2203001100');

    expect(pendingScansStore.pendingScans.value).toHaveLength(0);
  });
});
