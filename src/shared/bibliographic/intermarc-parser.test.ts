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
        <datafield tag="702"><subfield code="a">Mébarki</subfield><subfield code="b">Thierry</subfield><subfield code="4">212</subfield></datafield>
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
    expect(parsed?.authors).toEqual(['Kid Toussaint', 'Miss Prickly', 'Thierry Mébarki']);
    expect(parsed?.scriptwriters).toEqual(['Kid Toussaint']);
    expect(parsed?.illustrators).toEqual(['Miss Prickly']);
    expect(parsed?.colorists).toEqual(['Thierry Mébarki']);
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

  it('ne classe pas "texte intégral", "version intégrale" ou un roman isolé en 2 vol. comme intégrale multi-tomes', () => {
    const xml1 = `
      <record>
        <datafield tag="020"><subfield code="a">9782070413119</subfield></datafield>
        <datafield tag="051"><subfield code="a">txt</subfield></datafield>
        <datafield tag="245"><subfield code="a">Les Misérables</subfield><subfield code="e">texte intégral</subfield></datafield>
        <datafield tag="280"><subfield code="a">2 vol.</subfield></datafield>
      </record>
    `;
    expect(parseMarcRecord(xml1)?.isIntegralHint).toBe(false);

    const xml2 = `
      <record>
        <datafield tag="020"><subfield code="a">9782070409228</subfield></datafield>
        <datafield tag="051"><subfield code="a">txt</subfield></datafield>
        <datafield tag="245"><subfield code="a">Critique de la raison pure</subfield><subfield code="e">édition intégrale</subfield></datafield>
        <datafield tag="280"><subfield code="a">2 vol. (800 p.)</subfield></datafield>
      </record>
    `;
    expect(parseMarcRecord(xml2)?.isIntegralHint).toBe(false);
  });

  it('détecte les vraies intégrales BD via 460$t, 250$a ou notes MARC 300/327', () => {
    const passagersXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">9782413081692</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">sti</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Les passagers du vent</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="250"><mxc:subfield code="a">Éd. intégrale</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="300"><mxc:subfield code="a">Réunit les tomes 1 à 9.</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="460"><mxc:subfield code="t">Les passagers du vent : l'intégrale</mxc:subfield></mxc:datafield>
      </mxc:record>
    `;
    const parsed = parseMarcRecord(passagersXml);
    expect(parsed?.isIntegralHint).toBe(true);
    expect(parsed?.integralNotes).toContain('Réunit les tomes 1 à 9');
  });

  it('déduit la langue originale depuis la mention ISBD 245$f ("traduit du japonais") si 041$h est absent', () => {
    const mangaIsbdXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">9782723442282</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">sti</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245">
          <mxc:subfield code="a">Sawako</mxc:subfield>
          <mxc:subfield code="f">Karuho Shiina ; traduit du japonais par Yuko Kurahashi</mxc:subfield>
        </mxc:datafield>
      </mxc:record>
    `;
    const parsed = parseMarcRecord(mangaIsbdXml);
    expect(parsed?.originalLanguage).toBe('jpn');
  });

  it('extrait les rôles scénariste/dessinateur/coloriste depuis 245$f/$g et multi-$4 sans polluer authors ni étiqueter un roman', () => {
    // 1. Cas réel BnF : coloriste absent de 700, uniquement dans 245$g ; d'après ignoré
    const bdColoristIn245 = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">9782205089998</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">sti</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245">
          <mxc:subfield code="a">Histoire de Jérusalem</mxc:subfield>
          <mxc:subfield code="f">texte et scénario, Vincent Lemire</mxc:subfield>
          <mxc:subfield code="g">dessin, Christophe Gaultier</mxc:subfield>
          <mxc:subfield code="g">couleur, Marie Galopin</mxc:subfield>
          <mxc:subfield code="g">d'après le roman de Pascal Ruter</mxc:subfield>
        </mxc:datafield>
        <mxc:datafield tag="100"><mxc:subfield code="a">Lemire</mxc:subfield><mxc:subfield code="m">Vincent</mxc:subfield><mxc:subfield code="4">0070</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="700"><mxc:subfield code="a">Gaultier</mxc:subfield><mxc:subfield code="m">Christophe</mxc:subfield><mxc:subfield code="4">0440</mxc:subfield></mxc:datafield>
      </mxc:record>
    `;
    const parsedBd = parseMarcRecord(bdColoristIn245);
    expect(parsedBd?.authors).toEqual(['Vincent Lemire', 'Christophe Gaultier']);
    expect(parsedBd?.scriptwriters).toEqual(['Vincent Lemire']);
    expect(parsedBd?.illustrators).toEqual(['Christophe Gaultier']);
    expect(parsedBd?.colorists).toEqual(['Marie Galopin']);

    // 2. Cas réel BnF : coloriste classé 0440 à tort par la BnF -> basculé en coloriste uniquement
    const bdColoristAs0440 = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">9782205088168</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">sti</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245">
          <mxc:subfield code="a">Le monde sans fin</mxc:subfield>
          <mxc:subfield code="f">Jancovici, Blain</mxc:subfield>
          <mxc:subfield code="g">couleur, Clémence Sapin et Christophe Blain</mxc:subfield>
        </mxc:datafield>
        <mxc:datafield tag="100"><mxc:subfield code="a">Jancovici</mxc:subfield><mxc:subfield code="m">Jean-Marc</mxc:subfield><mxc:subfield code="4">0070</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="700"><mxc:subfield code="a">Blain</mxc:subfield><mxc:subfield code="m">Christophe</mxc:subfield><mxc:subfield code="4">0070</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="700"><mxc:subfield code="a">Sapin</mxc:subfield><mxc:subfield code="m">Clémence</mxc:subfield><mxc:subfield code="4">0440</mxc:subfield></mxc:datafield>
      </mxc:record>
    `;
    const parsed0440 = parseMarcRecord(bdColoristAs0440);
    expect(parsed0440?.colorists).toEqual(['Clémence Sapin', 'Christophe Blain']);
    expect(parsed0440?.illustrators).toEqual([]);
    expect(parsed0440?.scriptwriters).toEqual(['Jean-Marc Jancovici', 'Christophe Blain']);

    // 3. Multi-$4 sur un même auteur complet (0070 + 0440)
    const multiRoleXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">9782205000016</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">sti</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">Sylvain et Sylvette</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="100">
          <mxc:subfield code="a">Cuvillier</mxc:subfield>
          <mxc:subfield code="m">Maurice</mxc:subfield>
          <mxc:subfield code="4">0070</mxc:subfield>
          <mxc:subfield code="4">0440</mxc:subfield>
        </mxc:datafield>
      </mxc:record>
    `;
    const parsedMulti = parseMarcRecord(multiRoleXml);
    expect(parsedMulti?.scriptwriters).toEqual(['Maurice Cuvillier']);
    expect(parsedMulti?.illustrators).toEqual(['Maurice Cuvillier']);

    // 4. Roman pur (051=txt, 100$4=0070, aucun illustrateur/coloriste) -> scriptwriters reste []
    const pureNovelXml = `
      <mxc:record>
        <mxc:datafield tag="020"><mxc:subfield code="a">9782070360024</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="051"><mxc:subfield code="a">txt</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="245"><mxc:subfield code="a">L'Étranger</mxc:subfield><mxc:subfield code="f">Albert Camus</mxc:subfield></mxc:datafield>
        <mxc:datafield tag="100"><mxc:subfield code="a">Camus</mxc:subfield><mxc:subfield code="m">Albert</mxc:subfield><mxc:subfield code="4">0070</mxc:subfield></mxc:datafield>
      </mxc:record>
    `;
    const parsedNovel = parseMarcRecord(pureNovelXml);
    expect(parsedNovel?.authors).toEqual(['Albert Camus']);
    expect(parsedNovel?.scriptwriters).toEqual([]);
    expect(parsedNovel?.illustrators).toEqual([]);
    expect(parsedNovel?.colorists).toEqual([]);
  });
});
