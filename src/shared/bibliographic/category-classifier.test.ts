// src/shared/bibliographic/category-classifier.test.ts
import { describe, expect, it } from 'vitest';
import { classifyBookMetadata } from './category-classifier';
import { cleanSeriesName, extractFranchiseBaseName, normalizeTextKey } from './text-normalize.util';
import { parseMarcRecord } from './intermarc-parser';

describe('Vague 4 — Classification média (Jeunesse, BD/Comics, Roman/ill.) & nettoyage séries', () => {
  it('ne classe pas les romans adultes contenant le mot "enfant" en Jeunesse', () => {
    expect(
      classifyBookMetadata({
        title: "L'Enfant de sable",
        publisher: 'Éd. du Seuil',
        collection: 'Points. Roman',
        deweyCode: '843.914',
        rawSubjects: ['Roman', 'Children']
      }).mainCategory
    ).toBe('Roman');

    expect(
      classifyBookMetadata({
        title: 'Leurs enfants après eux',
        publisher: 'Actes Sud',
        collection: 'Domaine français',
        deweyCode: '843.92',
        rawSubjects: ['Roman', 'Adolescents']
      }).mainCategory
    ).toBe('Roman');

    expect(
      classifyBookMetadata({
        title: 'Enfant de salaud',
        publisher: 'Bernard Grasset',
        deweyCode: '843.92',
        rawSubjects: ['Roman', 'Guerre mondiale']
      }).mainCategory
    ).toBe('Roman');

    // Mais un vrai roman jeunesse reste bien Jeunesse !
    expect(
      classifyBookMetadata({
        title: 'Les Exploits de Fantômette',
        publisher: 'Hachette',
        collection: 'Bibliothèque rose',
        deweyCode: '843.914',
        rawSubjects: ['Romans pour la jeunesse']
      }).mainCategory
    ).toBe('Jeunesse');
  });

  it('distingue BD franco-belge (Imbattable) et Comics US (Marvel France) sans confusion', () => {
    // Imbattable T.2 "Super-héros de proximité" (Dupuis, français) -> BD, jamais Comics !
    expect(
      classifyBookMetadata({
        title: 'Super-héros de proximité',
        series: 'Imbattable',
        publisher: 'Dupuis',
        deweyCode: '741.594 4',
        originalLanguage: 'fre',
        contentKind: 'illustrated',
        rawSubjects: ['Bandes dessinées']
      }).mainCategory
    ).toBe('BD');

    // Spider-Man : Bleu (Marvel France sans 041$h) -> Comics !
    expect(
      classifyBookMetadata({
        title: 'Bleu',
        series: 'Spider-Man',
        publisher: 'Marvel France',
        deweyCode: '741.5',
        contentKind: 'illustrated',
        rawSubjects: ['Bandes dessinées']
      }).mainCategory
    ).toBe('Comics');
  });

  it('ne classe pas un roman > 112 p. avec "ill." noir et blanc (ex. Dora Bruder) en BD', () => {
    const xml = `
      <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
        <mxc:controlfield tag="008">970401s1997    fr                  fre  </mxc:controlfield>
        <mxc:datafield tag="020"><mxc:subfield code="a">9782070748983</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="100"><mxc:subfield code="a">Modiano</mxc:subfield><mxc:subfield code="m">Patrick</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Dora Bruder</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="260"><mxc:subfield code="c">Gallimard</mxc:subfield><mxc:subfield code="d">1997</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="280"><mxc:subfield code="a">145 p.</mxc:subfield><mxc:subfield code="c">ill., couv. ill.</mxc:subfield></mxc:datafield>
      </mxc:record>
    `;
    const parsed = parseMarcRecord(xml);
    expect(parsed?.contentKind).toBe('text_only');
    expect(
      classifyBookMetadata({
        title: parsed!.title,
        publisher: parsed!.publisher,
        contentKind: parsed!.contentKind,
        rawSubjects: parsed!.rawSubjects
      }).mainCategory
    ).toBe('Roman');
  });

  it('nettoie proprement "Une aventure des Brigades du Tigre", les guillemets et les symboles', () => {
    expect(extractFranchiseBaseName('Une aventure des Brigades du Tigre').baseName).toBe('Brigades du Tigre');
    expect(extractFranchiseBaseName('Les Aventures de Tintin').baseName).toBe('Tintin');
    expect(extractFranchiseBaseName("Les Aventures d'Astérix").baseName).toBe('Astérix');
    expect(cleanSeriesName('"L\'âge d\'or"')).toBe("L'âge d'or");
    expect(normalizeTextKey('Aqua™')).toBe('aqua');
    expect(normalizeTextKey('On Mars_')).toBe('on mars');
  });
});
