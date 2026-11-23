// src/shared/bibliographic/isbn.util.test.ts
import { describe, expect, it } from 'vitest';
import { isbnUtil } from './isbn.util';

describe('isbnUtil', () => {
  it('valide les clés de contrôle ISBN-13 et ISBN-10', () => {
    expect(isbnUtil.isValidBookBarcode('979-10-347-6595-9')).toBe(true);
    expect(isbnUtil.isValidBookBarcode('9782203001039')).toBe(true);
    expect(isbnUtil.isValidBookBarcode('9782203001030')).toBe(false);
    expect(isbnUtil.isValidIsbn10('2203001038')).toBe(true);
    expect(isbnUtil.isValidIsbn10('2203001039')).toBe(false);
  });

  it('convertit proprement entre ISBN-10 et ISBN-13', () => {
    expect(isbnUtil.toIsbn13('2-203-00103-8')).toBe('9782203001039');
    expect(isbnUtil.toIsbn10('9782203001039')).toBe('2203001038');
    expect(isbnUtil.toIsbn10('9791034765959')).toBeNull();
  });

  it('normalise les ISBN francophones et codes presse', () => {
    expect(isbnUtil.normalizeToIsbn13('2-203-00103-8')).toBe('9782203001039');
    expect(isbnUtil.normalizeToIsbn13('3781234567890')).toBe('3781234567890');
    expect(isbnUtil.normalizeToIsbn13('invalid')).toBeNull();
    expect(isbnUtil.isFrancophoneBookIsbn13('9791034765959')).toBe(true);
    expect(isbnUtil.isFrancophoneBookIsbn13('9780141036144')).toBe(false);
  });
});
