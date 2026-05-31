// src/core/resolvers/bnf.resolver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { 
  bnfResolver, 
  cleanTitle, 
  cleanAuthor, 
  cleanPublisher, 
  cleanPublishDate, 
  cleanPageCount,
  cleanSeriesName,
  extractSeriesInfo,
  extractBnfCoverId,
  parseSeriesFromString,
  parseSeriesFromTitle,
  parseMarcFields
} from './bnf.resolver';

describe('BNF Resolver & Parsers', () => {

  describe('extractSeriesInfo', () => {
    it('doit extraire la serie et le numero entre parentheses', () => {
      const relations = ['Collection principale : (Astérix ; 39)', 'Autre relation'];
      expect(extractSeriesInfo(relations)).toEqual({
        series: 'Astérix',
        seriesNumber: '39'
      });
    });

    it('doit extraire uniquement la serie si pas de numero', () => {
      const relations = ['Collection principale : (Sillage)'];
      expect(extractSeriesInfo(relations)).toEqual({
        series: 'Sillage',
        seriesNumber: undefined
      });
    });

    it('doit extraire la serie simple sans parentheses', () => {
      const relations = ['Collection : Astérix'];
      expect(extractSeriesInfo(relations)).toEqual({
        series: 'Astérix',
        seriesNumber: undefined
      });
    });

    it('doit renvoyer un objet vide si aucune relation correspondante', () => {
      expect(extractSeriesInfo(['Autre relation'])).toEqual({});
      expect(extractSeriesInfo([])).toEqual({});
    });
  });

  describe('cleanSeriesName', () => {
    it('doit nettoyer les parentheses de disambiguation', () => {
      expect(cleanSeriesName('Ex-libris (Paris. 2007)')).toBe('Ex-libris');
      expect(cleanSeriesName('Thorgal')).toBe('Thorgal');
      expect(cleanSeriesName('')).toBe('');
    });
  });

  describe('parseSeriesFromString', () => {
    it('doit extraire le nom et le numero de collection', () => {
      expect(parseSeriesFromString("Collection : Une aventure d'Astérix ; 39")).toEqual({
        series: "Une aventure d'Astérix",
        seriesNumber: "39"
      });
      expect(parseSeriesFromString("Collection principale : (Folio junior ; 100)")).toEqual({
        series: "Folio junior",
        seriesNumber: "100"
      });
      expect(parseSeriesFromString("Titre d'ensemble : Thorgal ; 24")).toEqual({
        series: "Thorgal",
        seriesNumber: "24"
      });
      expect(parseSeriesFromString("Titre d'ensemble : Docteur Bonheur, Tome 1")).toEqual({
        series: "Docteur Bonheur",
        seriesNumber: "1"
      });
      expect(parseSeriesFromString("Titre d'ensemble : Sillage (tome 12)")).toEqual({
        series: "Sillage",
        seriesNumber: "12"
      });
      expect(parseSeriesFromString("Titre d'ensemble : Lanfeust de Troy. Tome 5")).toEqual({
        series: "Lanfeust de Troy",
        seriesNumber: "5"
      });
      expect(parseSeriesFromString("Titre d'ensemble : Ex-libris (Paris. 2007) ; 5")).toEqual({
        series: "Ex-libris",
        seriesNumber: "5"
      });
    });
  });

  describe('parseSeriesFromTitle', () => {
    it('doit extraire la serie et le numero depuis le titre', () => {
      expect(parseSeriesFromTitle("Tome 1, Le nom de la série")).toEqual({
        title: "Le nom de la série",
        series: "Le nom de la série",
        seriesNumber: "1"
      });
      expect(parseSeriesFromTitle("Docteur Bonheur. Tome 1")).toEqual({
        title: "Docteur Bonheur",
        series: "Docteur Bonheur",
        seriesNumber: "1"
      });
      expect(parseSeriesFromTitle("Oliver Twist. Volume 5")).toEqual({
        title: "Oliver Twist",
        series: "Oliver Twist",
        seriesNumber: "5"
      });
      expect(parseSeriesFromTitle("Le Combat ordinaire")).toEqual({
        title: "Le Combat ordinaire"
      });
    });
  });

  describe('parseMarcFields', () => {
    it('doit parser correctement les champs et sous-zones', () => {
      const xml = `
        <mxc:datafield tag="245" ind1="1" ind2=" ">
          <mxc:subfield code="a">Arachnéa</mxc:subfield>
          <mxc:subfield code="h">Tome 24</mxc:subfield>
        </mxc:datafield>
        <mxc:datafield tag="460" ind1=" " ind2=" ">
          <mxc:subfield code="t">Thorgal</mxc:subfield>
          <mxc:subfield code="v">24</mxc:subfield>
        </mxc:datafield>
      `;
      const fields = parseMarcFields(xml);
      expect(fields.length).toBe(2);
      expect(fields[0].tag).toBe('245');
      expect(fields[0].subfields[0].code).toBe('a');
      expect(fields[0].subfields[0].value).toBe('Arachnéa');
      expect(fields[1].tag).toBe('460');
      expect(fields[1].subfields[0].code).toBe('t');
      expect(fields[1].subfields[0].value).toBe('Thorgal');
      expect(fields[1].subfields[1].value).toBe('24');
    });
  });

  describe('extractBnfCoverId', () => {
    it('doit extraire l\'identifiant de la sous-zone a du tag 950', () => {
      const xml = `<mxc:datafield tag="950" ind1=" " ind2=" ">
        <mxc:subfield code="a">119563</mxc:subfield>
        <mxc:subfield code="b">C1</mxc:subfield>
      </mxc:datafield>`;
      expect(extractBnfCoverId(xml)).toBe('119563');
    });

    it('doit retourner null si le tag 950 n\'existe pas', () => {
      const xml = `<mxc:datafield tag="930" ind1=" " ind2=" ">
        <mxc:subfield code="a">FR-751131010</mxc:subfield>
      </mxc:datafield>`;
      expect(extractBnfCoverId(xml)).toBeNull();
    });

    it('doit retourner null si la sous-zone a du tag 950 n\'existe pas', () => {
      const xml = `<mxc:datafield tag="950" ind1=" " ind2=" ">
        <mxc:subfield code="b">C1</mxc:subfield>
      </mxc:datafield>`;
      expect(extractBnfCoverId(xml)).toBeNull();
    });
  });

  describe('cleanTitle', () => {
    it('doit extraire le titre principal avant le premier slash', () => {
      expect(cleanTitle('Celle qui brûle / Paula Hawkins ; traduit...')).toBe('Celle qui brûle');
      expect(cleanTitle('Le Petit Prince / Antoine de Saint-Exupéry')).toBe('Le Petit Prince');
      expect(cleanTitle('Astérix le Gaulois')).toBe('Astérix le Gaulois');
      expect(cleanTitle('')).toBe('');
    });
  });

  describe('cleanAuthor', () => {
    it('doit inverser Nom, Prénom, retirer le rôle et les dates de naissance/décès', () => {
      // Cas standard avec rôle et dates
      expect(cleanAuthor('Hawkins, Paula (1972-....). Auteur du texte')).toBe('Paula Hawkins');
      // Illustrateur et dates complètes
      expect(cleanAuthor('Uderzo, Albert (1927-2020). Illustrateur')).toBe('Albert Uderzo');
      // Sans dates ni rôles
      expect(cleanAuthor('Goscinny, René')).toBe('René Goscinny');
      // Format simple sans virgule
      expect(cleanAuthor('Paula Hawkins')).toBe('Paula Hawkins');
      expect(cleanAuthor('')).toBe('');
    });
  });

  describe('cleanPublisher', () => {
    it('doit supprimer la ville de publication entre parenthèses', () => {
      expect(cleanPublisher('Sonatine éditions (Paris)')).toBe('Sonatine éditions');
      expect(cleanPublisher('Gallimard')).toBe('Gallimard');
      expect(cleanPublisher('')).toBe('');
    });
  });

  describe('cleanPublishDate', () => {
    it('doit extraire l\'année sur 4 chiffres', () => {
      expect(cleanPublishDate('2021')).toBe('2021');
      expect(cleanPublishDate('DL 2021')).toBe('2021');
      expect(cleanPublishDate('impr. 1999')).toBe('1999');
      expect(cleanPublishDate('sans date')).toBe('');
      expect(cleanPublishDate('')).toBe('');
    });
  });

  describe('cleanPageCount', () => {
    it('doit extraire la pagination', () => {
      expect(cleanPageCount('1 vol. (346 p.) ; 22 cm')).toBe(346);
      expect(cleanPageCount('112 p. : ill. ; 30 cm')).toBe(112);
      expect(cleanPageCount('non paginé')).toBeUndefined();
      expect(cleanPageCount('')).toBeUndefined();
    });
  });

  describe('resolve', () => {
    it('doit résoudre les métadonnées BNF d\'un XML de réponse valide avec couverture', async () => {
      const mockDcXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <oai_dc:dc xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:title>Le Petit Prince / Antoine de Saint-Exupéry</dc:title>
                <dc:creator>Saint-Exupéry, Antoine de (1900-1944). Auteur du texte</dc:creator>
                <dc:publisher>Gallimard (Paris)</dc:publisher>
                <dc:date>2007</dc:date>
                <dc:format>1 vol. (113 p.) ; 18 cm</dc:format>
              </oai_dc:dc>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const mockImXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2" format="INTERMARC" id="ark:/12148/cb41023439w" type="Bibliographic">
                <mxc:datafield tag="950" ind1=" " ind2=" ">
                  <mxc:subfield code="a">119563</mxc:subfield>
                  <mxc:subfield code="b">C1</mxc:subfield>
                </mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const globalFetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('schema=intermarc')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(mockImXml)
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(mockDcXml)
        });
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const result = await bnfResolver.resolve('9782070612758');
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Le Petit Prince');
      expect(result?.authors).toEqual(['Antoine de Saint-Exupéry']);
      expect(result?.publisher).toBe('Gallimard');
      expect(result?.publishDate).toBe('2007');
      expect(result?.pageCount).toBe(113);
      expect(result?.coverUrl).toBe('https://catalogue.bnf.fr/couverture?idImage=119563&couverture=1&appName=NE');
    });

    it('doit résoudre les métadonnées avec série structurée depuis InterMarc (Thorgal)', async () => {
      const mockDcXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <oai_dc:dc xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:title>Arachnéa / dessin G. Rosinski ; scénario J. Van Hamme</dc:title>
                <dc:creator>Van Hamme, Jean (1939-....). Auteur du texte</dc:creator>
              </oai_dc:dc>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const mockImXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2" format="INTERMARC" id="ark:/12148/cb46674895g" type="Bibliographic">
                <mxc:datafield tag="245" ind1="1" ind2=" ">
                  <mxc:subfield code="a">Arachnéa</mxc:subfield>
                </mxc:datafield>
                <mxc:datafield tag="460" ind1=" " ind2=" ">
                  <mxc:subfield code="t">Thorgal</mxc:subfield>
                  <mxc:subfield code="v">24</mxc:subfield>
                </mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const globalFetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('schema=intermarc')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(mockImXml)
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(mockDcXml)
        });
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const result = await bnfResolver.resolve('9782803613625');
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Arachnéa');
      expect(result?.series).toBe('Thorgal');
      expect(result?.seriesNumber).toBe('24');
    });

    it('doit résoudre les métadonnées avec série depuis le titre (Docteur Bonheur)', async () => {
      const mockDcXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <oai_dc:dc xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:title>Docteur Bonheur. Tome 1 / Clarke, Turk</dc:title>
              </oai_dc:dc>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const mockImXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2" format="INTERMARC" type="Bibliographic">
                <mxc:datafield tag="245" ind1="1" ind2=" ">
                  <mxc:subfield code="a">Docteur Bonheur</mxc:subfield>
                  <mxc:subfield code="h">Tome 1</mxc:subfield>
                  <mxc:subfield code="u">01</mxc:subfield>
                </mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const globalFetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('schema=intermarc')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(mockImXml)
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(mockDcXml)
        });
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const result = await bnfResolver.resolve('9782803622641');
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Docteur Bonheur');
      expect(result?.series).toBe('Docteur Bonheur');
      expect(result?.seriesNumber).toBe('01');
    });

    it('doit renvoyer null si la notice BNF n\'a aucun enregistrement', async () => {
      const mockXmlEmpty = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>0</srw:numberOfRecords>
        <srw:records/>
      </srw:searchRetrieveResponse>`;

      const globalFetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockXmlEmpty)
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const result = await bnfResolver.resolve('9780000000000');
      expect(result).toBeNull();
    });
  });
});
