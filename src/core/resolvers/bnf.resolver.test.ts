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
  parseMarcFields,
  parseIntermarcRecord,
  scoreHintMatch,
  isEditorialPaperbackCollectionName,
  isFrancophoneBookIsbn13
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
    it('doit nettoyer les parentheses de disambiguation et les pipes de tri BNF', () => {
      expect(cleanSeriesName('Ex-libris (Paris. 2007)')).toBe('Ex-libris');
      expect(cleanSeriesName('Les |Arènes BD')).toBe('Les Arènes BD');
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

  describe('searchSeriesVolumes', () => {
    it('doit filtrer les doubles/intégrales/langues étrangères et dédoublonner les rééditions d un même tome', async () => {
      const mockSeriesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>4</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
                <mxc:controlfield tag="008">190101s 2019                 frfre     b  001 </mxc:controlfield>
                <mxc:datafield tag="020"><mxc:subfield code="a">978-2-8001-3692-9</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="100"><mxc:subfield code="a">Vehlmann</mxc:subfield><mxc:subfield code="m">Fabien</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="245"><mxc:subfield code="a">La disparition</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="280"><mxc:subfield code="a">56 p.</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="460"><mxc:subfield code="t">Seuls</mxc:subfield><mxc:subfield code="v">1</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="950"><mxc:subfield code="a">12345</mxc:subfield></mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
                <mxc:controlfield tag="008">170101s 2017                 frfre     b  001 </mxc:controlfield>
                <mxc:datafield tag="020"><mxc:subfield code="a">978-2-8001-7045-9</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="245"><mxc:subfield code="a">La disparition</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="280"><mxc:subfield code="a">64 p.</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="460"><mxc:subfield code="t">Seuls</mxc:subfield><mxc:subfield code="v">01</mxc:subfield></mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
                <mxc:controlfield tag="008">200101s 2020                 frfre     b  001 </mxc:controlfield>
                <mxc:datafield tag="020"><mxc:subfield code="a">978-2-8001-9999-3</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="245"><mxc:subfield code="a">Tomes 1 et 2</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="280"><mxc:subfield code="a">48-48 p.</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="460"><mxc:subfield code="t">Seuls</mxc:subfield><mxc:subfield code="v">1-2</mxc:subfield></mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
                <mxc:controlfield tag="008">240101s 2024                 frfre     b  001 </mxc:controlfield>
                <mxc:datafield tag="020"><mxc:subfield code="a">978-2-8102-0676-6</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="100"><mxc:subfield code="a">Vehlmann</mxc:subfield><mxc:subfield code="m">Fabien</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="245"><mxc:subfield code="a">Les protecteurs</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="280"><mxc:subfield code="a">52 p.</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="460"><mxc:subfield code="t">Seuls</mxc:subfield><mxc:subfield code="v">14</mxc:subfield></mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockSeriesXml)
      }));

      const volumes = await bnfResolver.searchSeriesVolumes('Seuls', 'Fabien Vehlmann');
      expect(volumes).toHaveLength(2);
      expect(volumes[0].seriesNumber).toBe('1');
      expect(volumes[0].isbn).toBe('9782800136929');
      expect(volumes[0].coverUrl).toContain('idImage=12345');
      expect(volumes[1].seriesNumber).toBe('14');
      expect(volumes[1].title).toBe('Les protecteurs');
    });

    it('doit extraire l EAN-13 en zone 038$a (ex: Mélusine / Les Schtroumpfs années 1990)', async () => {
      const mockMelusineXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
                <mxc:controlfield tag="008">970515s 1997                 befre     d  001 </mxc:controlfield>
                <mxc:datafield tag="020"><mxc:subfield code="a">2-8001-2447-4</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="038"><mxc:subfield code="a">9782800124476</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="100"><mxc:subfield code="a">Clarke</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="245"><mxc:subfield code="a">Histoires à lire au coin du feu</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="280"><mxc:subfield code="a">46 p.</mxc:subfield></mxc:datafield>
                <mxc:datafield tag="460"><mxc:subfield code="t">Mélusine</mxc:subfield><mxc:subfield code="v">4</mxc:subfield></mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockMelusineXml)
      }));

      const volumes = await bnfResolver.searchSeriesVolumes('Mélusine', 'Clarke');
      expect(volumes).toHaveLength(1);
      expect(volumes[0].isbn).toBe('9782800124476');
      expect(volumes[0].title).toBe('Histoires à lire au coin du feu');
      expect(volumes[0].series).toBe('Mélusine');
      expect(volumes[0].seriesNumber).toBe('4');
    });

    it('doit extraire le titre d album en 245$p et le tome en 245$n pour les séries BnF type Tintin', () => {
      const tintinXml = `
        <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
          <mxc:controlfield tag="008">930515s 1993                 befre     d  001 </mxc:controlfield>
          <mxc:datafield tag="020"><mxc:subfield code="a">2-203-00110-0</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="038"><mxc:subfield code="a">9782203001107</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="100"><mxc:subfield code="a">Hergé</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="245">
            <mxc:subfield code="a">Les aventures de Tintin</mxc:subfield>
            <mxc:subfield code="n">11</mxc:subfield>
            <mxc:subfield code="p">Le secret de La Licorne</mxc:subfield>
          </mxc:datafield>
          <mxc:datafield tag="280"><mxc:subfield code="a">62 p.</mxc:subfield></mxc:datafield>
        </mxc:record>`;

      const parsed = parseIntermarcRecord(tintinXml);
      expect(parsed).not.toBeNull();
      expect(parsed?.title).toBe('Le secret de La Licorne');
      expect(parsed?.series).toBe('Les aventures de Tintin');
      expect(parsed?.seriesNumber).toBe('11');
      expect(parsed?.isbn).toBe('9782203001107');
    });

    it('doit conserver les Intégrales FR BnF quand includeIntegrals=true (ex: Aya de Yopougon Intégrale 1)', () => {
      const ayaIntXml = `
        <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
          <mxc:controlfield tag="008">140515s 2014                 frfre     d  001 </mxc:controlfield>
          <mxc:datafield tag="038"><mxc:subfield code="a">9782070658787</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="100"><mxc:subfield code="a">Abouet</mxc:subfield><mxc:subfield code="m">Marguerite</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="245">
            <mxc:subfield code="a">Aya de Yopougon</mxc:subfield>
            <mxc:subfield code="d">Texte imprimé</mxc:subfield>
            <mxc:subfield code="e">intégrale</mxc:subfield>
            <mxc:subfield code="h">1</mxc:subfield>
          </mxc:datafield>
          <mxc:datafield tag="460"><mxc:subfield code="t">Aya de Yopougon</mxc:subfield></mxc:datafield>
        </mxc:record>`;

      expect(parseIntermarcRecord(ayaIntXml, { includeIntegrals: false })).toBeNull();
      const kept = parseIntermarcRecord(ayaIntXml, { includeIntegrals: true });
      expect(kept).not.toBeNull();
      expect(kept?.isbn).toBe('9782070658787');
      expect(kept?.title).toContain('Intégrale 1');
      expect(kept?.isIntegral).toBe(true);
    });

    it('doit rejeter les DVD / Blu-ray / CD Audio dans parseIntermarcRecord (245$d et EAN non-livre)', () => {
      const dvdXml = `
        <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
          <mxc:controlfield tag="008">180515s 2018                 frfre     d  001 </mxc:controlfield>
          <mxc:datafield tag="038"><mxc:subfield code="a">3607483250686</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="245">
            <mxc:subfield code="a">La mort de Staline</mxc:subfield>
            <mxc:subfield code="d">Images animées</mxc:subfield>
          </mxc:datafield>
        </mxc:record>`;
      const cdXml = `
        <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
          <mxc:controlfield tag="008">180515s 2018                 frfre     d  001 </mxc:controlfield>
          <mxc:datafield tag="038"><mxc:subfield code="a">9782205063509</mxc:subfield></mxc:datafield>
          <mxc:datafield tag="245">
            <mxc:subfield code="a">Siegfried</mxc:subfield>
            <mxc:subfield code="d">Enregistrement sonore</mxc:subfield>
          </mxc:datafield>
        </mxc:record>`;

      expect(parseIntermarcRecord(dvdXml, { includeIntegrals: true })).toBeNull();
      expect(parseIntermarcRecord(cdXml, { includeIntegrals: true })).toBeNull();
    });

    it('doit filtrer les ISBN étrangers et noter 0 un manga non lié partageant uniquement le n° de tome', () => {
      expect(isFrancophoneBookIsbn13('9782070658787')).toBe(true);
      expect(isFrancophoneBookIsbn13('9791032700013')).toBe(true);
      expect(isFrancophoneBookIsbn13('3780833208992')).toBe(true);
      expect(isFrancophoneBookIsbn13('9788467928914')).toBe(false); // Espagnol
      expect(isFrancophoneBookIsbn13('9789069691329')).toBe(false); // Néerlandais
      expect(isFrancophoneBookIsbn13('3607483250686')).toBe(false); // DVD

      const unrelatedMangaScore = scoreHintMatch(
        {
          isbn: '9782811664510',
          title: 'Chihayafuru',
          series: 'Chihayafuru',
          seriesNumber: '44',
          authors: ['Yuki Suetsugu'],
          publisher: 'Pika',
          publishDate: '2023',
          _lang: 'fre',
          _hasPrimaryIsbn: true
        },
        {
          title: 'Boule et Bill',
          series: 'Boule et Bill',
          volumeNumber: '44',
          author: 'Cazenove'
        }
      );
      expect(unrelatedMangaScore).toBe(0);
    });

    it('doit bloquer les collections poches (Folio #7304, J\'ai lu #12281, Librio, Rivages poche, Libretto) y compris dans Dublin Core et privilégier T.1 sans n° sur tranche', async () => {
      for (const label of [
        'Folio',
        "J'ai lu",
        '10-18',
        'Babel',
        'Librio',
        'Libretto',
        'Rivages poche',
        'Météores',
        'Un endroit où aller'
      ]) {
        expect(isEditorialPaperbackCollectionName(label)).toBe(true);
      }

      // Simuler une réponse BnF Dublin Core contenant "Collection : Folio ; 7304" + InterMarc
      const dcXml = `
        <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <srw:numberOfRecords>1</srw:numberOfRecords>
          <srw:records><srw:record><srw:recordData>
            <oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/">
              <dc:title>Le roitelet</dc:title>
              <dc:creator>Beauchemin, Jean-François</dc:creator>
              <dc:publisher>Gallimard</dc:publisher>
              <dc:date>2023</dc:date>
              <dc:relation>Collection : Folio ; 7304</dc:relation>
            </oai_dc:dc>
          </srw:recordData></srw:record></srw:records>
        </srw:searchRetrieveResponse>`;
      const imXml = `
        <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
          <srw:numberOfRecords>1</srw:numberOfRecords>
          <srw:records><srw:record>
            <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
              <mxc:datafield tag="245"><mxc:subfield code="a">Le roitelet</mxc:subfield></mxc:datafield>
              <mxc:datafield tag="410"><mxc:subfield code="t">Folio</mxc:subfield><mxc:subfield code="v">7304</mxc:subfield></mxc:datafield>
            </mxc:record>
          </srw:record></srw:records>
        </srw:searchRetrieveResponse>`;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const u = String(input);
        return new Response(u.includes('schema=intermarc') ? imXml : dcXml, { status: 200 });
      });
      try {
        const res = await bnfResolver.resolve('9782073038159');
        expect(res).not.toBeNull();
        expect(res?.series).toBeUndefined();
        expect(res?.seriesNumber).toBeUndefined();
      } finally {
        fetchSpy.mockRestore();
      }

      // Les Éphémères : tranche sans numéro -> Tome 1 (2023) doit battre Tome 2 (2024)
      const t1Score = scoreHintMatch(
        {
          isbn: '9782754836531',
          title: 'Les éphémères',
          series: 'Les éphémères',
          seriesNumber: '1',
          authors: ['Jeff Lemire'],
          publishDate: '2023',
          _lang: 'fre',
          _hasPrimaryIsbn: true
        },
        { title: 'Les Éphémères', author: 'Jeff Lemire', rawSpineText: 'Jeff Lemire Les Éphémères' }
      );
      const t2Score = scoreHintMatch(
        {
          isbn: '9782754843775',
          title: 'Les éphémères',
          series: 'Les éphémères',
          seriesNumber: '2',
          authors: ['Jeff Lemire'],
          publishDate: '2024',
          _lang: 'fre',
          _hasPrimaryIsbn: true
        },
        { title: 'Les Éphémères', author: 'Jeff Lemire', rawSpineText: 'Jeff Lemire Les Éphémères' }
      );
      expect(t1Score).toBeGreaterThan(t2Score);
    });

    it('scoreHintMatch privilégie nettement l’éditeur demandé face à d’autres rééditions', () => {
      const hachetteScore = scoreHintMatch(
        {
          isbn: '9782012101333',
          title: 'Astérix le Gaulois',
          series: 'Astérix',
          seriesNumber: '1',
          authors: ['René Goscinny', 'Albert Uderzo'],
          publisher: 'Hachette',
          publishDate: '2024',
          _lang: 'fre',
          _hasPrimaryIsbn: true
        },
        { title: 'Astérix le Gaulois', series: 'Astérix', volumeNumber: '1', publisher: 'Dargaud' }
      );
      const dargaudScore = scoreHintMatch(
        {
          isbn: '9782205000962',
          title: 'Astérix le Gaulois',
          series: 'Astérix',
          seriesNumber: '1',
          authors: ['René Goscinny', 'Albert Uderzo'],
          publisher: 'Dargaud',
          publishDate: '1999',
          _lang: 'fre',
          _hasPrimaryIsbn: true
        },
        { title: 'Astérix le Gaulois', series: 'Astérix', volumeNumber: '1', publisher: 'Dargaud' }
      );
      expect(dargaudScore).toBeGreaterThan(hachetteScore);
    });

    it('extrait correctement le titre de tome depuis 200$i / 245$i (Animal Jack T.7 — UNIMARC Sudoc 9791034765959 et InterMarc BnF 9791034768738)', () => {
      const sudocUnimarcXml = `
        <record>
          <datafield tag="010"><subfield code="a">979-10-347-6595-9</subfield></datafield>
          <datafield tag="073"><subfield code="a">9791034765959</subfield></datafield>
          <datafield tag="100"><subfield code="a">20220915d2022    m  y0frey50      ba</subfield></datafield>
          <datafield tag="200">
            <subfield code="a">Animal Jack</subfield>
            <subfield code="h">7</subfield>
            <subfield code="i">Le plein d&apos;aventures</subfield>
          </datafield>
          <datafield tag="214"><subfield code="c">Dupuis</subfield><subfield code="d">DL 2022</subfield></datafield>
          <datafield tag="215"><subfield code="a">1 vol. (104 p.)</subfield></datafield>
          <datafield tag="225"><subfield code="a">Animal Jack</subfield><subfield code="v">7</subfield></datafield>
          <datafield tag="700"><subfield code="a">Kid Toussaint</subfield><subfield code="b">Thierry</subfield></datafield>
          <datafield tag="702"><subfield code="a">Miss Prickly</subfield></datafield>
        </record>
      `;
      const parsedSudoc = parseIntermarcRecord(sudocUnimarcXml);
      expect(parsedSudoc?.isbn).toBe('9791034765959');
      expect(parsedSudoc?.title).toBe("Le plein d'aventures");
      expect(parsedSudoc?.series).toBe('Animal Jack');
      expect(parsedSudoc?.seriesNumber).toBe('7');
      expect(parsedSudoc?.publisher).toBe('Dupuis');
      expect(parsedSudoc?.publishDate).toBe('2022');
      expect(parsedSudoc?.pageCount).toBe(104);
      expect(parsedSudoc?.authors).toEqual(['Kid Toussaint', 'Miss Prickly']);
    });
  });
});
