import { describe, expect, it } from 'vitest';
import {
  areDistinctSeriesWorkTitles,
  isCleanerCanonicalSeriesName,
  resolveCanonicalVolumeNumber,
  type CanonicalSeriesIndex
} from './series-canonical.resolver';

describe('series-canonical.resolver', () => {
  const tintinIndex: CanonicalSeriesIndex = {
    wikidataSeriesQid: 'Q744536',
    canonicalSeriesName: 'Les Aventures de Tintin',
    volumesByQid: {
      Q166199: { volumeNumber: 9, title: "Le Crabe aux pinces d'or", normalizedTitle: "crabe aux pinces d or", wikidataWorkQid: 'Q166199' },
      Q113669881: { volumeNumber: 7, title: "L'Île Noire", normalizedTitle: 'ile noire', wikidataWorkQid: 'Q113669881' },
      Q949863: { volumeNumber: 10, title: "L'Étoile mystérieuse", normalizedTitle: 'etoile mysterieuse', wikidataWorkQid: 'Q949863' },
      Q172723: { volumeNumber: 8, title: "Le Sceptre d'Ottokar", normalizedTitle: 'sceptre d ottokar', wikidataWorkQid: 'Q172723' }
    },
    volumesByNormTitle: {
      'lotus bleu': { volumeNumber: 5, title: 'Le Lotus bleu', normalizedTitle: 'lotus bleu' },
      'cigares du pharaon': { volumeNumber: 4, title: 'Les Cigares du pharaon', normalizedTitle: 'cigares du pharaon' },
      'ile noire': { volumeNumber: 7, title: "L'Île Noire", normalizedTitle: 'ile noire', wikidataWorkQid: 'Q113669881' },
      'sceptre d ottokar': { volumeNumber: 8, title: "Le Sceptre d'Ottokar", normalizedTitle: 'sceptre d ottokar', wikidataWorkQid: 'Q172723' },
      'etoile mysterieuse': { volumeNumber: 10, title: "L'Étoile mystérieuse", normalizedTitle: 'etoile mysterieuse', wikidataWorkQid: 'Q949863' },
      'tresor de rackham le rouge': { volumeNumber: 12, title: 'Le Trésor de Rackham le Rouge', normalizedTitle: 'tresor de rackham le rouge' },
      'temple du soleil': { volumeNumber: 14, title: 'Le Temple du Soleil', normalizedTitle: 'temple du soleil' }
    },
    fetchedAt: Date.now()
  };

  it('résout le vrai numéro canonique Tintin depuis l’index Wikidata malgré une réédition BnF mal numérotée', () => {
    const lotus = resolveCanonicalVolumeNumber({
      canonicalSeriesIndex: tintinIndex,
      sisterEditions: [{ source: 'bnf', volumeNumber: '1', seriesRaw: 'Les aventures de Tintin reporter' }],
      rawTitles: ['Le Lotus bleu'],
      seriesName: 'Les Aventures de Tintin'
    });
    expect(lotus.volumeNumber).toBe('5');
    expect(lotus.source).toBe('wikidata_series_index');

    const cigares = resolveCanonicalVolumeNumber({
      canonicalSeriesIndex: tintinIndex,
      sisterEditions: [{ source: 'bnf', volumeNumber: '20', seriesRaw: 'Les aventures de Tintin reporter' }],
      rawTitles: ['Les cigares du pharaon'],
      seriesName: 'Les Aventures de Tintin'
    });
    expect(cigares.volumeNumber).toBe('4');

    const ileNoire = resolveCanonicalVolumeNumber({
      wikidataWorkQid: 'Q113669881',
      canonicalSeriesIndex: tintinIndex,
      sisterEditions: [{ source: 'bnf', volumeNumber: '10', seriesRaw: 'Archives Tintin' }],
      rawTitles: ["L'île noire"],
      seriesName: 'Les Aventures de Tintin'
    });
    expect(ileNoire.volumeNumber).toBe('7');
  });

  it('déclasse les collections à numérotation divergente lors du vote pondéré sans index Wikidata', () => {
    const res = resolveCanonicalVolumeNumber({
      sisterEditions: [
        { source: 'bnf', volumeNumber: '1', seriesRaw: 'Les aventures de Tintin reporter', collectionRaw: 'Fac-similé' },
        { source: 'bnf', volumeNumber: '5', seriesRaw: 'Les aventures de Tintin', publisher: 'Casterman' },
        { source: 'bnf', volumeNumber: '5', seriesRaw: 'Les aventures de Tintin', publisher: 'Casterman' }
      ],
      rawTitles: ['Le Lotus bleu'],
      seriesName: 'Les Aventures de Tintin'
    });
    expect(res.volumeNumber).toBe('5');
    expect(res.source).toBe('weighted_vote');
  });

  it('distingue deux albums différents portant le même numéro erroné mais autorise les variantes ou titres génériques', () => {
    expect(areDistinctSeriesWorkTitles("L'île noire", "L'étoile mystérieuse", 'Les Aventures de Tintin')).toBe(true);
    expect(areDistinctSeriesWorkTitles("Le sceptre d'Ottokar", 'Le trésor de Rackham le Rouge', 'Les Aventures de Tintin')).toBe(true);
    expect(areDistinctSeriesWorkTitles('Temple du soleil', 'Le temple du soleil', 'Les Aventures de Tintin')).toBe(false);
    expect(areDistinctSeriesWorkTitles('Culottées', 'Culottées', 'Culottées')).toBe(false);
    expect(areDistinctSeriesWorkTitles('Boule & Bill', 'Boule et Bill', 'Boule et Bill')).toBe(false);
  });

  it('reconnaît un nom canonique de série plus propre que la variante éditoriale', () => {
    expect(isCleanerCanonicalSeriesName('Les Aventures de Tintin', 'Les aventures de Tintin reporter')).toBe(true);
    expect(isCleanerCanonicalSeriesName('Les aventures de Tintin reporter', 'Les Aventures de Tintin')).toBe(false);
  });
});
