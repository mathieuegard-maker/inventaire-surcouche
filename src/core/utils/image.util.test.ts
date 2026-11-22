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

  describe('buildCoverCandidates & advanceCoverFallback', () => {
    it('construit des URLs de repli CDN (Amazon EU, Eyrolles, OpenLibrary) en gardant les URLs explicites en tête', () => {
      const candidates = imageUtil.buildCoverCandidates('9782203001107', [
        'https://catalogue.bnf.fr/couverture?idImage=123',
        'http://books.google.com/thumb.jpg'
      ]);
      expect(candidates[0]).toBe('https://catalogue.bnf.fr/couverture?idImage=123');
      expect(candidates[1]).toBe('https://books.google.com/thumb.jpg');
      expect(candidates.some((u) => u.includes('images-eu.ssl-images-amazon.com/images/P/2203001100'))).toBe(true);
      expect(candidates.some((u) => u.includes('servimg.eyrolles.com'))).toBe(true);
      expect(candidates.some((u) => u.includes('covers.openlibrary.org/b/isbn/9782203001107-L.jpg'))).toBe(true);
    });

    it('bascule sur l\'URL de repli suivante puis efface coverUrl quand toutes ont échoué', () => {
      const target = {
        coverUrl: 'https://a.example/1.jpg',
        coverFallbackUrls: ['https://a.example/1.jpg', 'https://b.example/2.jpg']
      };
      imageUtil.advanceCoverFallback(target);
      expect(target.coverUrl).toBe('https://b.example/2.jpg');

      imageUtil.advanceCoverFallback(target);
      expect(target.coverUrl).toBeUndefined();
    });
  });

  describe('handleImageError', () => {
    it('bascule automatiquement sur la source suivante lorsque la couverture proxifiée échoue puis déclenche onExhausted', () => {
      let exhausted = false;
      const fakeImgObj: {
        src: string;
        dataset: Record<string, string>;
        getAttribute(name: string): string | null;
      } = {
        src: '/api/gateway?action=image-proxy&url=https%3A%2F%2Fbroken.example%2Fa.jpg',
        dataset: {},
        getAttribute(name: string) {
          return name === 'src' ? fakeImgObj.src : null;
        }
      };
      const fakeImg = fakeImgObj as unknown as HTMLImageElement;

      const step1 = imageUtil.handleImageError(fakeImg, {
        isbn: '9782203001107',
        fallbackUrls: ['https://broken.example/a.jpg', 'https://good.example/b.jpg'],
        onExhausted: () => {
          exhausted = true;
        }
      });
      expect(step1).toBe(true);
      expect(exhausted).toBe(false);
      expect(fakeImg.src).toBe(
        '/api/gateway?action=image-proxy&url=https%3A%2F%2Fgood.example%2Fb.jpg&isbn=9782203001107'
      );

      // Tant qu'il reste les repli CDN ISBN, bascule dessus avant d'épuiser
      while (imageUtil.handleImageError(fakeImg, {
        isbn: '9782203001107',
        fallbackUrls: ['https://broken.example/a.jpg', 'https://good.example/b.jpg'],
        onExhausted: () => {
          exhausted = true;
        }
      })) {
        // avance jusqu'à épuisement
      }
      expect(exhausted).toBe(true);
    });
  });

  describe('resolveBookCardCoverUrl & getCoverFingerprint', () => {
    it('priorise localCover puis coverUrl exacte sans suffixe &isbn= pour respecter strictement la fiche livre', () => {
      const bookWithLocal: Partial<HumanizedBook> = {
        isbn13: '9782365770125',
        localCover: 'data:image/webp;base64,CUSTOM_FABLES_T1',
        coverUrl: 'https://example.com/old-default.jpg'
      };
      expect(imageUtil.resolveBookCardCoverUrl(bookWithLocal as HumanizedBook)).toBe(
        'data:image/webp;base64,CUSTOM_FABLES_T1'
      );

      const bookWithChosenUrl: Partial<HumanizedBook> = {
        isbn13: '9782365770125',
        coverUrl: 'https://urban-comics.example/fables-t1-chosen.jpg'
      };
      const resolved = imageUtil.resolveBookCardCoverUrl(bookWithChosenUrl as HumanizedBook);
      expect(resolved).toBe(
        '/api/gateway?action=image-proxy&url=https%3A%2F%2Furban-comics.example%2Ffables-t1-chosen.jpg'
      );
      expect(resolved).not.toContain('&isbn=');
    });

    it('détecte le remplacement dun localCover par un autre localCover via getCoverFingerprint', () => {
      const fpA = imageUtil.getCoverFingerprint({
        localCover: 'data:image/webp;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_OLD'
      });
      const fpB = imageUtil.getCoverFingerprint({
        localCover: 'data:image/webp;base64,BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_NEW'
      });
      expect(fpA).not.toBe(fpB);
    });
  });
});
