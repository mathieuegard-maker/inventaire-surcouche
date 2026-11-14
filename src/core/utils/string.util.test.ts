import { describe, it, expect } from 'vitest';
import { getLevenshteinDistance } from './string.util';

describe('getLevenshteinDistance', () => {
  it('should return 0 for identical strings', () => {
    expect(getLevenshteinDistance('hello', 'hello')).toBe(0);
    expect(getLevenshteinDistance('Spirou', 'spirou ')).toBe(0); // Case/space insensitivity
  });

  it('should calculate correct distance for simple edits', () => {
    expect(getLevenshteinDistance('spirou', 'spriou')).toBe(2); // Transposition (2 operations: subst/subst or ins/del)
    expect(getLevenshteinDistance('Spirou', 'Le Petit Spirou')).toBe(9);
    expect(getLevenshteinDistance('Spirou', 'Spir')).toBe(2); // 2 deletions
  });

  it('should handle empty strings', () => {
    expect(getLevenshteinDistance('', 'abc')).toBe(3);
    expect(getLevenshteinDistance('abc', '')).toBe(3);
    expect(getLevenshteinDistance('', '')).toBe(0);
  });
});
