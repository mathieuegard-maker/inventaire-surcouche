import { describe, it, expect } from 'vitest';
import { classifyBookMetadata } from './category-classifier.util';

describe('classifyBookMetadata (V2 Fine Category & Subgenre Classifier)', () => {
  it('classe correctement une BD franco-belge avec sous-genre Historique / Humour', () => {
    const res = classifyBookMetadata({
      title: 'Astérix le Gaulois',
      series: 'Astérix',
      publisher: 'Dargaud',
      deweyCode: '741.5944',
      rawSubjects: ['Bandes dessinées humoristiques', 'Histoire -- Antiquité']
    });
    expect(res.mainCategory).toBe('BD');
    expect(res.subgenres).toContain('Humour');
    expect(res.subgenres).toContain('Historique');
  });

  it('classe correctement un Manga à partir de son éditeur ou sujet', () => {
    const res = classifyBookMetadata({
      title: 'One Piece',
      series: 'One Piece',
      publisher: 'Glénat Manga',
      rawSubjects: ['Shonen', 'Aventure', 'Pirates']
    });
    expect(res.mainCategory).toBe('Manga');
    expect(res.subgenres).toContain('Aventure');
  });

  it('classe correctement un Roman de Science-Fiction', () => {
    const res = classifyBookMetadata({
      title: 'Dune',
      publisher: 'Robert Laffont',
      deweyCode: '813.54',
      rawSubjects: ['Romans de science-fiction', 'Space opera']
    });
    expect(res.mainCategory).toBe('Roman');
    expect(res.subgenres).toContain('Science-Fiction');
  });

  it('classe correctement un Essai philosophique / scientifique', () => {
    const res = classifyBookMetadata({
      title: 'Brève histoire du temps',
      publisher: 'Flammarion',
      deweyCode: '523.1',
      rawSubjects: ['Astrophysique', 'Sciences', 'Essais']
    });
    expect(res.mainCategory).toBe('Essai');
    expect(res.subgenres).toContain('Sciences & Nature');
  });
});
