// src/shared/bibliographic/intermarc-parser.test.ts
import { describe, expect, it } from 'vitest';
import { parseMarcRecord } from './intermarc-parser';

describe('parseMarcRecord (InterMarc BnF + UNIMARC SUDOC)', () => {
  it('extrait une notice UNIMARC SUDOC (Animal Jack T.7) en ignorant totalement 100$a codé', () => {
    const xml = `
      <record>
        <datafield tag="010"><subfield code="a">979-10-347-6595-9</subfield></datafield>
        <datafield tag="100"><subfield code="a">20220915d2022    m  y0frey50      ba</subfield></datafield>
        <datafield tag="101"><subfield code="a">fre</subfield></datafield>
        <datafield tag="200">
          <subfield code="a">Animal Jack</subfield>
          <subfield code="h">7</subfield>
          <subfield code="i">Le plein d&apos;aventures</subfield>
        </datafield>
        <datafield tag="214"><subfield code="c">Dupuis</subfield><subfield code="d">DL 2022</subfield></datafield>
        <datafield tag="215"><subfield code="a">1 vol. (104 p.)</subfield></datafield>
        <datafield tag="225"><subfield code="a">Animal Jack</subfield><subfield code="v">7</subfield></datafield>
        <datafield tag="700"><subfield code="a">Kid Toussaint</subfield><subfield code="4">070</subfield></datafield>
        <datafield tag="702"><subfield code="a">Miss Prickly</subfield><subfield code="4">440</subfield></datafield>
      </record>
    `;
    const parsed = parseMarcRecord(xml);
    expect(parsed).not.toBeNull();
    expect(parsed?.isbn13).toBe('9791034765959');
    expect(parsed?.title).toBe("Le plein d'aventures");
    expect(parsed?.ensembleSeriesName).toBe('Animal Jack');
    expect(parsed?.ensembleVolumeNumber).toBe('7');
    expect(parsed?.publisher).toBe('Dupuis');
    expect(parsed?.publishYear).toBe('2022');
    expect(parsed?.pageCount).toBe(104);
    expect(parsed?.language).toBe('fre');
    expect(parsed?.authors).toEqual(['Kid Toussaint', 'Miss Prickly']);
    expect(parsed?.scriptwriters).toEqual(['Kid Toussaint']);
    expect(parsed?.illustrators).toEqual(['Miss Prickly']);
  });

  it('distingue strictement un ensemble BnF 460 d une collection poche 410 (Totem / Folio)', () => {
    const romanPocheXml = `
      <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
        <mxc:datafield tag="020"><mxc:subfield code="a">9782351785423</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Sukkwan Island</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="100"><mxc:subfield code="a">Vann</mxc:subfield><mxc:subfield code="m">David</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="260"><mxc:subfield code="c">Gallmeister</mxc:subfield><mxc:subfield code="d">2011</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="410"><mxc:subfield code="t">Totem</mxc:subfield><mxc:subfield code="v">24</mxc:subfield></mxc:datafield>
      </mxc:record>
    `;
    const parsed = parseMarcRecord(romanPocheXml);
    expect(parsed?.title).toBe('Sukkwan Island');
    expect(parsed?.authors).toEqual(['David Vann']);
    expect(parsed?.ensembleSeriesName).toBeUndefined();
    expect(parsed?.collectionName).toBe('Totem');
    expect(parsed?.collectionNumber).toBe('24');
  });

  it('ne classe pas "texte intégral" comme une intégrale multi-tomes', () => {
    const xml = `
      <record>
        <datafield tag="020"><subfield code="a">9782070413119</subfield></datafield>
        <datafield tag="245"><subfield code="a">Les Misérables</subfield><subfield code="e">texte intégral</subfield></datafield>
      </record>
    `;
    const parsed = parseMarcRecord(xml);
    expect(parsed?.isIntegralHint).toBe(false);
  });
});
