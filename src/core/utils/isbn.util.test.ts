// src/core/utils/isbn.util.test.ts
import { describe, it, expect } from 'vitest';
import { isbnUtil } from './isbn.util';

describe('ISBN Utility', () => {
  describe('normalize', () => {
    it('doit supprimer les tirets et les espaces', () => {
      expect(isbnUtil.normalize('978-2-203-35327-5')).toBe('9782203353275');
      expect(isbnUtil.normalize('978 2 203 35327 5')).toBe('9782203353275');
    });

    it('doit renvoyer une chaîne vide si aucun ISBN n\'est fourni', () => {
      expect(isbnUtil.normalize('')).toBe('');
      expect(isbnUtil.normalize(undefined as any)).toBe('');
    });
  });

  describe('isValidFormat', () => {
    it('doit valider les formats standard de 10 ou 13 chiffres', () => {
      expect(isbnUtil.isValidFormat('978-2-203-35327-5')).toBe(true);
      expect(isbnUtil.isValidFormat('2203353275')).toBe(true);
      expect(isbnUtil.isValidFormat('9782203353275')).toBe(true);
    });

    it('doit invalider les formats incorrects (longueur ou lettres)', () => {
      expect(isbnUtil.isValidFormat('12345')).toBe(false);
      expect(isbnUtil.isValidFormat('978-2-203-35327-5-A')).toBe(false);
      expect(isbnUtil.isValidFormat('978220335327A')).toBe(false);
    });
  });
});
