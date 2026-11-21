import { describe, expect, it } from 'vitest';
import { extractBnfCoverId, extractControlField, parseMarcFields } from './intermarc-parser';
import {
  computeCanal3WorkKey,
  hasAuthorOverlap,
  hasTextTokenOverlap,
  isEditorialOrPublisherCollection,
  isMetaIntegral,
  matchesSeriesFallbackCandidate
} from './work-identity';
import { rankCanal3Consensus } from './canal3-consensus';

describe('bibliographic core (unifié)', () => {
  it('parseMarcFields gère indifféremment les balises préfixées mxc: et sans préfixe', () => {
    const xml = `
      <record>
        <controlfield tag="008">990101s2024    fr              fre          </controlfield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Titre &amp; Suite</mxc:subfield></mxc:datafield>
        <datafield tag="950"><subfield code="a">998877</subfield></datafield>
      </record>`;
    const fields = parseMarcFields(xml);
    expect(fields).toHaveLength(2);
    expect(fields[0].subfields[0].value).toBe('Titre & Suite');
    expect(extractBnfCoverId(xml)).toBe('998877');
    expect(extractControlField(xml, '008').substring(31, 34)).toBe('fre');
  });

  it('isEditorialOrPublisherCollection écarte structurellement toute collection identique au nom de l’éditeur', () => {
    expect(isEditorialOrPublisherCollection('Gallmeister', 'Éditions Gallmeister')).toBe(true);
    expect(isEditorialOrPublisherCollection('Collection Métailié', 'Métailié')).toBe(true);
    expect(isEditorialOrPublisherCollection('Folio', 'Gallimard')).toBe(true);
    expect(isEditorialOrPublisherCollection('Thorgal', 'Le Lombard')).toBe(false);
  });

  it('matchesSeriesFallbackCandidate rejette les homonymes d’autres auteurs et accepte les vrais tomes', () => {
    expect(
      matchesSeriesFallbackCandidate({
        candTitle: 'Le Silence des agneaux',
        candAuthors: ['Thomas Harris'],
        targetCoreKey: 'silence',
        expectedAuthors: ['Didier Comès']
      })
    ).toBe(false);

    expect(
      matchesSeriesFallbackCandidate({
        candSeriesRaw: 'Silence',
        candTitle: 'Silence',
        candAuthors: ['Didier Comès'],
        candVolumeNumber: '1',
        targetCoreKey: 'silence',
        expectedAuthors: ['Didier Comès']
      })
    ).toBe(true);
  });

  it('work-identity primitives : isMetaIntegral, hasTextTokenOverlap, hasAuthorOverlap, computeCanal3WorkKey', () => {
    expect(isMetaIntegral({ title: 'Série — Intégrale 1' })).toBe(true);
    expect(isMetaIntegral({ title: 'Roman — texte intégral' })).toBe(false);
    expect(hasTextTokenOverlap('Jeff Lemire', 'Lemire, Jeff')).toBe(true);
    expect(hasAuthorOverlap(['Goscinny, René'], ['René Goscinny', 'Albert Uderzo'])).toBe(true);
    expect(
      computeCanal3WorkKey({ title: 'La Serpe d’or', series: 'Astérix', seriesNumber: '2', authors: ['Goscinny'] })
    ).toBe('series:asterix#2');
  });

  it('rankCanal3Consensus fusionne les sources multiples et trie les alternatives proprement', () => {
    const out = rankCanal3Consensus({
      hints: { title: 'La Serpe d’or', series: 'Astérix', volumeNumber: '2', publisher: 'Dargaud' },
      inputs: [
        {
          source: 'bnf',
          meta: {
            isbn: '9782205000962',
            title: 'La Serpe d’or',
            series: 'Astérix',
            seriesNumber: '2',
            authors: ['René Goscinny'],
            publisher: 'Dargaud'
          }
        },
        {
          source: 'openlibrary',
          meta: {
            isbn: '9782205000962',
            title: 'La Serpe d’or',
            series: 'Astérix',
            seriesNumber: '2',
            authors: ['René Goscinny'],
            publisher: 'Dargaud'
          }
        },
        {
          source: 'bnf',
          meta: {
            isbn: '9782012101340',
            title: 'La Serpe d’or',
            series: 'Astérix',
            seriesNumber: '2',
            authors: ['René Goscinny'],
            publisher: 'Hachette'
          }
        }
      ]
    });
    expect(out.isbn13).toBe('9782205000962');
    expect(out.sourcesCount).toBe(2);
    expect(out.alternatives[0].publisher).toBe('Dargaud');

    // Sans filtre éditeur explicite, les deux éditions (Dargaud et Hachette) restent proposées en alternatives
    const outNoPub = rankCanal3Consensus({
      hints: { title: 'La Serpe d’or', series: 'Astérix', volumeNumber: '2' },
      inputs: [
        {
          source: 'bnf',
          meta: {
            isbn: '9782205000962',
            title: 'La Serpe d’or',
            series: 'Astérix',
            seriesNumber: '2',
            authors: ['René Goscinny'],
            publisher: 'Dargaud'
          }
        },
        {
          source: 'bnf',
          meta: {
            isbn: '9782012101340',
            title: 'La Serpe d’or',
            series: 'Astérix',
            seriesNumber: '2',
            authors: ['René Goscinny'],
            publisher: 'Hachette'
          }
        }
      ]
    });
    expect(outNoPub.alternatives.length).toBeGreaterThanOrEqual(2);
  });
});
