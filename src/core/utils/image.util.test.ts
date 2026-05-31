// src/core/utils/image.util.test.ts
import { describe, it, expect } from 'vitest';
import { imageUtil } from './image.util';
import type { HumanizedBook } from '../types';

describe('Image Utility', () => {
  describe('resolveCoverUrl', () => {
    it('doit renvoyer une chaine vide si aucun argument', () => {
      expect(imageUtil.resolveCoverUrl(null)).toBe('');
      expect(imageUtil.resolveCoverUrl(undefined)).toBe('');
    });

    it('doit renvoyer localCover en priorite si passe un livre', () => {
      const book: Partial<HumanizedBook> = {
        localCover: 'data:image/webp;base64,12345',
        coverUrl: 'https://covers.openlibrary.org/b/id/111-L.jpg'
      };
      expect(imageUtil.resolveCoverUrl(book as HumanizedBook)).toBe('data:image/webp;base64,12345');
    });

    it('doit faire passer coverUrl par le proxy si localCover est absent', () => {
      const book: Partial<HumanizedBook> = {
        coverUrl: 'https://covers.openlibrary.org/b/id/111-L.jpg'
      };
      expect(imageUtil.resolveCoverUrl(book as HumanizedBook)).toBe(
        '/api/gateway?action=image-proxy&url=https%3A%2F%2Fcovers.openlibrary.org%2Fb%2Fid%2F111-L.jpg'
      );
    });

    it('doit traiter directement une chaine URL externe', () => {
      const url = 'https://covers.openlibrary.org/b/id/111-L.jpg';
      expect(imageUtil.resolveCoverUrl(url)).toBe(
        '/api/gateway?action=image-proxy&url=https%3A%2F%2Fcovers.openlibrary.org%2Fb%2Fid%2F111-L.jpg'
      );
    });

    it('doit preserver les urls data: existantes', () => {
      const dataUrl = 'data:image/png;base64,abc';
      expect(imageUtil.resolveCoverUrl(dataUrl)).toBe(dataUrl);
      
      const book: Partial<HumanizedBook> = {
        coverUrl: 'data:image/png;base64,abc'
      };
      expect(imageUtil.resolveCoverUrl(book as HumanizedBook)).toBe(dataUrl);
    });
  });
});
