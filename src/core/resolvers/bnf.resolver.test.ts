// src/core/resolvers/bnf.resolver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { 
  bnfResolver, 
  cleanTitle, 
  cleanAuthor, 
  cleanPublisher, 
  cleanPublishDate, 
  cleanPageCount 
} from './bnf.resolver';

describe('BNF Resolver & Parsers', () => {

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
    it('doit résoudre les métadonnées BNF d\'un XML de réponse valide', async () => {
      const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
      <srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
        <srw:numberOfRecords>1</srw:numberOfRecords>
        <srw:records>
          <srw:record>
            <srw:recordData>
              <oai_dc:dc xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:title>Celle qui brûle / Paula Hawkins</dc:title>
                <dc:creator>Hawkins, Paula (1972-....). Auteur du texte</dc:creator>
                <dc:publisher>Sonatine éditions (Paris)</dc:publisher>
                <dc:date>2021</dc:date>
                <dc:format>1 vol. (346 p.) ; 22 cm</dc:format>
              </oai_dc:dc>
            </srw:recordData>
          </srw:record>
        </srw:records>
      </srw:searchRetrieveResponse>`;

      const globalFetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockXml)
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const result = await bnfResolver.resolve('9782355848858');
      expect(result).not.toBeNull();
      expect(result?.title).toBe('Celle qui brûle');
      expect(result?.authors).toEqual(['Paula Hawkins']);
      expect(result?.publisher).toBe('Sonatine éditions');
      expect(result?.publishDate).toBe('2021');
      expect(result?.pageCount).toBe(346);
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
