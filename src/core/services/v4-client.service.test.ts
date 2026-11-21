import { beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from '../database/database.service';
import { connectionState } from '../../state/connection';
import { sessionStore } from '../../state/session';
import { ingestIsbnsViaV4 } from './v4-client.service';

describe('v4-client.service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    connectionState.isOffline.value = false;
    vi.spyOn(sessionStore, 'getUserUri').mockReturnValue('user:test');
  });

  it('persiste à la fois cache_books ET le registre inventory local lors dun ajout V4 owned', async () => {
    const saveSpy = vi.spyOn(databaseService, 'saveBookToCache').mockResolvedValue(undefined);
    const regSpy = vi.spyOn(databaseService, 'addRegistryEntry').mockResolvedValue(undefined);
    const removeWishSpy = vi.spyOn(databaseService, 'removeRegistryEntry').mockResolvedValue(undefined);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            traceId: 'tr_1',
            sourceChannel: 'canal_4_ai_photo',
            results: [
              {
                inputIsbn: '9782075079297',
                normalizedIsbn13: '9782075079297',
                layer2Status: 'FULL_MISS',
                ownedIntegralMatches: [],
                includedOwnedWorkIds: [],
                book: {
                  id: 'bk_1',
                  workCanonicalId: 'integral:aya yopougon:1-2-3',
                  canonicalTitle: 'Aya de Yopougon — Intégrale 1',
                  normalizedTitle: 'aya de yopougon integrale 1',
                  seriesId: 'ser_aya',
                  seriesName: 'Aya de Yopougon',
                  volumeNumber: null,
                  volumeLabel: 'Int. T.1-3',
                  isHorsSerie: false,
                  isIntegral: true,
                  integralMetadata: { includedVolumeNumbers: ['1', '2', '3'], includedWorkIds: [], includedIsbns: [] },
                  parentIntegrals: [],
                  authors: ['Marguerite Abouet'],
                  language: 'fr',
                  knownIsbns: ['9782075079297'],
                  editionsCatalog: [{ isbn13: '9782075079297', publisher: 'Gallimard' }],
                  selectedCoverUrl: 'https://catalogue.bnf.fr/couverture?idImage=1&couverture=1&appName=NE',
                  mainCategory: 'BD',
                  subgenres: [],
                  legacyEntityUri: 'isbn:9782075079297',
                  updatedAt: '2026-11-18T15:00:00Z'
                }
              }
            ]
          }),
          { status: 200 }
        )
      )
    );

    const res = await ingestIsbnsViaV4({
      isbns: ['9782075079297'],
      sourceChannel: 'canal_4_ai_photo',
      action: 'owned'
    });

    expect(res?.results).toHaveLength(1);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: 'isbn:9782075079297',
        ownershipStatus: 'owned',
        isIntegral: true,
        seriesNumber: 'Int. T.1-3'
      })
    );
    expect(regSpy).toHaveBeenCalledWith('inventory', 'isbn:9782075079297');
    expect(removeWishSpy).toHaveBeenCalledWith('wishlist', 'isbn:9782075079297');

    vi.unstubAllGlobals();
  });
});
