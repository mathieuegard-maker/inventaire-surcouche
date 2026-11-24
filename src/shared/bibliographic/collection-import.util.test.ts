// src/shared/bibliographic/collection-import.util.test.ts
import { describe, expect, it } from 'vitest';
import {
  parseCsvToMatrix,
  parseImportJson,
  parseImportRowsFromMatrix
} from './collection-import.util';

describe('collection-import.util — Parseur pur CSV / JSON / matrice Excel', () => {
  it('parse un CSV point-virgule avec BOM UTF-8 et guillemets échappés (format export V2)', () => {
    const csv =
      '\uFEFFID;Titre;Série;Tome;Intégrale;Tomes inclus;Auteurs;Éditeur;ISBN;Statut;Lecture;Note;Notes personnelles\r\n' +
      'bk_1;"Astérix ""le Gaulois""";Astérix;1;Non;;René Goscinny, Albert Uderzo;Dargaud;9782012101333;owned;read;5;"Super; classique"\r\n' +
      'bk_2;Tome manquant;Astérix;2;Non;;Goscinny;Dargaud;9782012101340;none;none;0;\r\n';

    const matrix = parseCsvToMatrix(csv);
    const rows = parseImportRowsFromMatrix(matrix);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      isbn: '9782012101333',
      title: 'Astérix "le Gaulois"',
      series: 'Astérix',
      volumeNumber: '1',
      author: 'René Goscinny, Albert Uderzo',
      publisher: 'Dargaud',
      ownershipStatus: 'owned',
      isIntegral: false,
      readingStatus: 'read',
      rating: 5,
      notes: 'Super; classique'
    });
    expect(rows[1].ownershipStatus).toBe('none');
  });

  it('parse un CSV virgule en anglais, une liste brute d’ISBN sans en-tête et un JSON export V2 ou tableau brut', () => {
    // 1. CSV virgule EN
    const csvEn = 'Title,Author,Status,Reading,Rating\nDune,Frank Herbert,Wishlist,En cours,4\n';
    const rowsEn = parseImportRowsFromMatrix(parseCsvToMatrix(csvEn));
    expect(rowsEn).toHaveLength(1);
    expect(rowsEn[0]).toMatchObject({
      isbn: null,
      title: 'Dune',
      author: 'Frank Herbert',
      ownershipStatus: 'wish',
      readingStatus: 'reading',
      rating: 4
    });

    // 2. Liste brute d'ISBN sans ligne d'en-tête
    const rawIsbns = '978-2-01-210133-3\n9782205051230\n';
    const rowsRaw = parseImportRowsFromMatrix(parseCsvToMatrix(rawIsbns));
    expect(rowsRaw.map((r) => r.isbn)).toEqual(['978-2-01-210133-3', '9782205051230']);

    // 3. JSON export V2 ({ books: [...] })
    const jsonExport = JSON.stringify({
      exportedAt: '2026-11-24T00:00:00Z',
      count: 1,
      books: [
        {
          titre: 'Blacksad',
          isbn: '9782205051230',
          integrale: 'Oui',
          tomesInclus: '1 à 3',
          statutFoyer: 'owned',
          lecturePerso: 'read',
          notePerso: 5,
          notesPerso: 'Magnifique'
        }
      ]
    });
    const rowsJson = parseImportJson(jsonExport);
    expect(rowsJson).toHaveLength(1);
    expect(rowsJson[0]).toMatchObject({
      isbn: '9782205051230',
      title: 'Blacksad',
      isIntegral: true,
      includedVolumes: ['1', '2', '3'],
      ownershipStatus: 'owned',
      readingStatus: 'read',
      rating: 5,
      notes: 'Magnifique'
    });

    // 4. JSON tableau brut
    const rowsArr = parseImportJson(JSON.stringify([{ isbn13: '9782871293019', status: 'wish' }]));
    expect(rowsArr).toHaveLength(1);
    expect(rowsArr[0]).toMatchObject({ isbn: '9782871293019', ownershipStatus: 'wish' });
  });
});
