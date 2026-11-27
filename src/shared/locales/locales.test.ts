// src/shared/locales/locales.test.ts
import { describe, expect, it } from 'vitest';
import { t } from './index';

describe('i18n centralisé', () => {
  it('résout les clés typées et interpole les paramètres dynamiques', () => {
    expect(t('app.title')).toBe('Ma Bibliothèque Cloud');
    expect(t('scan.photoBannerRunning', { done: 4, total: 12 })).toBe('Photo IA — En cours : 4/12');
    expect(t('social.giftLoginRequired')).toContain('inscrit et connecté');
  });
});
