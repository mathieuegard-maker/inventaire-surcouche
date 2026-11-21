import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bnfResolver } from '../resolvers/bnf.resolver';
import { workEditionHarvesterService } from './work-edition-harvester.service';

vi.mock('../resolvers/bnf.resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resolvers/bnf.resolver')>();
  return {
    ...actual,
    bnfResolver: {
      ...actual.bnfResolver,
      searchCandidatesByHints: vi.fn()
    }
  };
});

describe('workEditionHarvesterService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("n'absorbe pas l'ISBN du Tome 2 sur le Tome 1 d'une série homonyme (Les Éphémères)", async () => {
    vi.mocked(bnfResolver.searchCandidatesByHints).mockResolvedValue([
      {
        score: 120,
        meta: {
          isbn: '9782754836531',
          title: 'Les éphémères',
          series: 'Les éphémères',
          seriesNumber: '1',
          authors: ['Jeff Lemire']
        }
      },
      {
        score: 125,
        meta: {
          isbn: '9782754843775',
          title: 'Les éphémères',
          series: 'Les éphémères',
          seriesNumber: '2',
          authors: ['Jeff Lemire']
        }
      }
    ]);

    const resT1 = await workEditionHarvesterService.harvestKnownIsbnsForWork({
      title: 'Les éphémères',
      series: 'Les éphémères',
      seriesNumber: '1',
      authors: ['Jeff Lemire'],
      seedIsbns: ['9782754836531']
    });

    expect(resT1.knownIsbns).toEqual(['9782754836531']);
    expect(resT1.knownIsbns).not.toContain('9782754843775');

    // Si aucun numéro de tome n'est fourni sur un titre égal au nom de la série, abandonne le moissonnage risqué
    const resUnnumbered = await workEditionHarvesterService.harvestKnownIsbnsForWork({
      title: 'Les éphémères',
      series: 'Les éphémères',
      authors: ['Jeff Lemire'],
      seedIsbns: ['9782754836531']
    });
    expect(resUnnumbered.knownIsbns).toEqual(['9782754836531']);
    expect(bnfResolver.searchCandidatesByHints).toHaveBeenCalledTimes(1);
  });
});
