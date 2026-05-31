// src/core/resolvers/bnf.resolver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { 
  bnfResolver, 
  cleanTitle, 
  cleanAuthor, 
  cleanPublisher, 
  cleanPublishDate, 
  cleanPageCount,
  extractSeriesInfo,
  extractBnfCoverId
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

    it('doit résoudre les métadonnées sans couverture si l\'InterMarc n\'en a pas', async () => {
      const mockDcXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <oai_dc:dc xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:title>Celle qui brûle / Paula Hawkins</dc:title>
                <dc:creator>Hawkins, Paula. Auteur du texte</dc:creator>
              </oai_dc:dc>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const mockImXmlWithoutCover = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2" format="INTERMARC" id="ark:/12148/cb468521385" type="Bibliographic">
                <mxc:datafield tag="930" ind1=" " ind2=" "></mxc:datafield>
              </mxc:record>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const globalFetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('schema=intermarc')) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(mockImXmlWithoutCover)
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(mockDcXml)
        });
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const result = await bnfResolver.resolve('9782355848858');
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Celle qui brûle');
      expect(result?.coverUrl).toBeUndefined();
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
