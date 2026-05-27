// src/core/resolvers/mapper.test.ts
import { describe, it, expect, vi } from 'vitest';
import { entityMapper } from './mapper';

// Mock simple de TEXTS avec le bon chemin d'import relatif à mapper.ts
vi.mock('../../ui/locales/fr', () => ({
  TEXTS: {
    authorView: {
      unknownTitle: 'Titre inconnu'
    }
  }
}));

describe('Entity Mapper', () => {
  it('doit mapper une réponse standard d\'une édition et d\'une œuvre', () => {
    const rawEdition = {
      type: 'edition',
      label: 'Astérix le Gaulois',
      isbn13: '978-2-203-35327-5',
      image: '3a4b5c6d',
      claims: {
        'P50': ['wd:Q_GOSCINNY'], // Auteur
        'P110': ['wd:Q_UDERZO'], // Illustrateur
        'P58': ['wd:Q_GOSCINNY'], // Scénariste
        'P1104': [{ value: '48' }] // Nombre de pages
      }
    };

    const rawWork = {
      label: 'Astérix le Gaulois (Œuvre)',
      claims: {
        'P179': ['wd:Q_SERIES_ASTERIX'], // Série
        'P1545': ['1'] // Tome numéro
      }
    };

    const result = entityMapper.mapResponse('inv:12345', rawEdition, rawWork);

    expect(result.uri).toBe('inv:12345');
    expect(result.title).toBe('Astérix le Gaulois');
    expect(result.isbn13).toBe('9782203353275'); // ISBN normalisé
    expect(result.coverUrl).toBe('https://inventaire.io/img/entities/300x300/3a4b5c6d');
    expect(result.authorIds).toEqual(['wd:Q_GOSCINNY']);
    expect(result.seriesId).toBe('wd:Q_SERIES_ASTERIX');
    expect(result.seriesNumber).toBe('1');
    expect(result.pageCount).toBe(48);
  });

  it('doit appliquer la règle BD : copier scénaristes + dessinateurs si authors est vide', () => {
    const rawEdition = {
      type: 'edition',
      label: 'Tintin au Tibet',
      claims: {
        'P110': ['wd:Q_HERGE'], // Dessinateur
        'P58': ['wd:Q_HERGE']  // Scénariste
      }
    };

    const result = entityMapper.mapResponse('inv:tintin', rawEdition, undefined);

    // Initialement pas d'auteur (P50), doit copier le dessinateur/scénariste en dédoublonnant
    expect(result.authorIds).toEqual(['wd:Q_HERGE']);
  });

  it('doit renvoyer le titre par défaut s\'il n\'y a aucun label', () => {
    const rawEdition = {
      type: 'edition',
      claims: {}
    };

    const result = entityMapper.mapResponse('inv:unknown', rawEdition, undefined);
    expect(result.title).toBe('Titre inconnu');
  });
});
