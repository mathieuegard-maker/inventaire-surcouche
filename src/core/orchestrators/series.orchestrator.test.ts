import { beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from '../database/database.service';
import { seriesOrchestrator } from './series.orchestrator';
import type { HumanizedBook } from '../types';

describe('seriesOrchestrator — priorité de la couverture sélectionnée sur la fiche livre', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('privilégie toujours la couverture éditée manuellement par l’utilisateur sur une édition auto-hydratée du même tome', async () => {
    const autoHydratedEdition: HumanizedBook = {
      uri: 'isbn:9782845385672',
      workUri: 'wd:Q_FABLES_T1',
      isbn13: '9782845385672',
      type: 'edition',
      title: 'Légendes en exil',
      authors: ['Bill Willingham'],
      illustrators: [],
      scriptwriters: [],
      genres: ['Comics'],
      series: 'Fables',
      seriesId: 'ser_fables',
      seriesNumber: '1',
      coverUrl: 'https://panini.example/fables-t1-auto.jpg',
      ownershipStatus: 'owned',
      updatedAt: 1000
    };

    const userEditedCard: HumanizedBook = {
      uri: 'isbn:9782365770125',
      workUri: 'wd:Q_FABLES_T1',
      isbn13: '9782365770125',
      type: 'edition',
      title: 'Légendes en exil',
      authors: ['Bill Willingham'],
      illustrators: [],
      scriptwriters: [],
      genres: ['Comics'],
      series: 'Fables',
      seriesId: 'ser_fables',
      seriesNumber: '1',
      coverUrl: 'https://urban.example/fables-t1-manual.jpg',
      localCover: 'data:image/webp;base64,MANUAL_COVER',
      ownershipStatus: 'owned',
      isLocallyEdited: true,
      updatedAt: 2000
    };

    vi.spyOn(databaseService, 'getBooksBySeriesId').mockResolvedValue([autoHydratedEdition, userEditedCard]);
    vi.spyOn(databaseService, 'isUriInRegistry').mockImplementation(async (reg) => reg === 'inventory');
    vi.spyOn(databaseService, 'getLoan').mockResolvedValue(undefined);

    const ctx = await seriesOrchestrator.getCompleteSeriesForUI('ser_fables', 'Fables');
    expect(ctx?.tomes).toHaveLength(1);
    expect(ctx?.tomes[0].coverUrl).toBe('https://urban.example/fables-t1-manual.jpg');
    expect(ctx?.tomes[0].localCover).toBe('data:image/webp;base64,MANUAL_COVER');
    expect(ctx?.tomes[0].isLocallyEdited).toBe(true);
  });

  it('ne fusionne pas deux tomes portant le même numéro mais issus de deux séries Fables distinctes (seriesId différents)', async () => {
    const urbanT1: HumanizedBook = {
      uri: 'isbn:9782365770125',
      isbn13: '9782365770125',
      type: 'edition',
      title: 'Fables — Tome 1',
      authors: ['Bill Willingham'],
      illustrators: [],
      scriptwriters: [],
      genres: ['Comics'],
      series: 'Fables',
      seriesId: 'ser_fables_urban',
      seriesNumber: '1',
      coverUrl: 'https://urban.example/t1.jpg',
      ownershipStatus: 'owned'
    };

    const paniniT1: HumanizedBook = {
      uri: 'isbn:9782845385672',
      isbn13: '9782845385672',
      type: 'edition',
      title: 'Fables — Tome 1',
      authors: ['Bill Willingham'],
      illustrators: [],
      scriptwriters: [],
      genres: ['Comics'],
      series: 'Fables',
      seriesId: 'ser_fables_panini',
      seriesNumber: '1',
      coverUrl: 'https://panini.example/t1.jpg',
      ownershipStatus: 'none'
    };

    vi.spyOn(databaseService, 'getBooksBySeriesId').mockResolvedValue([urbanT1, paniniT1]);
    vi.spyOn(databaseService, 'isUriInRegistry').mockImplementation(async (reg, uri) => reg === 'inventory' && uri === urbanT1.uri);
    vi.spyOn(databaseService, 'getLoan').mockResolvedValue(undefined);

    const ctx = await seriesOrchestrator.getCompleteSeriesForUI('ser_fables_urban', 'Fables');
    expect(ctx?.tomes).toHaveLength(2);
    expect(ctx?.tomes[0].coverUrl).toBe('https://urban.example/t1.jpg');
    expect(ctx?.tomes[1].coverUrl).toBe('https://panini.example/t1.jpg');
  });
});
