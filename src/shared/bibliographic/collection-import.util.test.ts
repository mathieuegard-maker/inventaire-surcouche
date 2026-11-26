// src/shared/bibliographic/collection-import.util.test.ts
import { describe, expect, it } from 'vitest';
import {
  detectHasHeaderRow,
  inspectJsonForImport,
  inspectMatrixForImport,
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

  it('inspecte et propose une bijection sur en-têtes composites BD/librairies, fusionne Scénariste+Dessinateur et désambiguïse Note/Statut par le contenu', () => {
    const csv = [
      "Code EAN-13;Titre de l'album;Nom de la série;N° de tome;Scénariste;Dessinateur;Maison d'édition;Date achat;Note;Statut",
      '9782012101333;Astérix le Gaulois;Astérix;1;René Goscinny;Albert Uderzo;Dargaud;2024-03-10;Excellent album fondateur très drôle;Lu',
      '9782012101340;La Serpe d’or;Astérix;2;René Goscinny;Albert Uderzo;Dargaud;2024-03-11;Un grand classique plein de gags;En cours'
    ].join('\n');

    const matrix = parseCsvToMatrix(csv);
    expect(detectHasHeaderRow(matrix)).toBe(true);

    const preview = inspectMatrixForImport(matrix, { format: 'csv' });
    expect(preview.hasHeaderRow).toBe(true);
    expect(preview.totalDataRows).toBe(2);
    expect(preview.hasPivotField).toBe(true);

    const byIdx = Object.fromEntries(preview.columns.map((c) => [c.columnKey, c]));
    expect(byIdx['0'].suggestedField).toBe('isbn');
    expect(byIdx['1'].suggestedField).toBe('title');
    expect(byIdx['2'].suggestedField).toBe('series');
    expect(byIdx['3'].suggestedField).toBe('volumeNumber');
    // Multi-colonnes autorisées sur Auteur (Scénariste + Dessinateur)
    expect(byIdx['4'].suggestedField).toBe('author');
    expect(byIdx['5'].suggestedField).toBe('author');
    expect(byIdx['6'].suggestedField).toBe('publisher');
    // "Date achat" doit être ignorée automatiquement
    expect(byIdx['7'].suggestedField).toBeNull();
    // "Note" avec du texte long -> basculée automatiquement vers "notes" (pas rating !)
    expect(byIdx['8'].suggestedField).toBe('notes');
    // "Statut" rempli de "Lu" / "En cours" -> basculé automatiquement vers "readingStatus"
    expect(byIdx['9'].suggestedField).toBe('readingStatus');

    const rows = parseImportRowsFromMatrix(matrix);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      isbn: '9782012101333',
      title: 'Astérix le Gaulois',
      series: 'Astérix',
      volumeNumber: '1',
      author: 'René Goscinny, Albert Uderzo',
      publisher: 'Dargaud',
      notes: 'Excellent album fondateur très drôle',
      readingStatus: 'read'
    });
  });

  it('détecte un fichier sans ligne d’en-tête par analyse de contenu et respecte un mapping explicite JSON / CSV', () => {
    const headerlessCsv = [
      'Astérix le Gaulois;René Goscinny;1;9782012101333',
      'La Serpe d’or;René Goscinny;2;9782012101340'
    ].join('\n');

    const matrix = parseCsvToMatrix(headerlessCsv);
    expect(detectHasHeaderRow(matrix)).toBe(false);

    const preview = inspectMatrixForImport(matrix, { format: 'csv' });
    expect(preview.hasHeaderRow).toBe(false);
    expect(preview.totalDataRows).toBe(2);
    expect(preview.columns.map((c) => c.suggestedField)).toEqual(['title', 'author', 'volumeNumber', 'isbn']);

    // Mapping personnalisé explicite (ex. l'utilisateur corrige col 0 en Série et col 1 en Auteur)
    const customRows = parseImportRowsFromMatrix(matrix, {
      hasHeaderRow: false,
      columnMapping: { '0': 'series', '1': 'author', '2': 'volumeNumber', '3': 'isbn' }
    });
    expect(customRows).toHaveLength(2);
    expect(customRows[0]).toMatchObject({
      rowNumber: 1,
      series: 'Astérix le Gaulois',
      title: null,
      author: 'René Goscinny',
      volumeNumber: '1',
      isbn: '9782012101333'
    });

    // JSON avec clés libres & objet auteur imbriqué + mapping explicite
    const exoticJson = JSON.stringify([
      { champA: 'Dune', champB: { name: 'Frank Herbert' }, code: '9782266320481', maNote: '4.5/5' }
    ]);
    const jsonPrev = inspectJsonForImport(exoticJson);
    expect(jsonPrev.format).toBe('json');
    expect(jsonPrev.canToggleHeaderRow).toBe(false);
    expect(jsonPrev.columns.find((c) => c.columnKey === 'code')?.suggestedField).toBe('isbn');
    expect(jsonPrev.columns.find((c) => c.columnKey === 'maNote')?.suggestedField).toBe('rating');

    const mappedJson = parseImportJson(exoticJson, {
      columnMapping: { champA: 'title', champB: 'author', code: 'isbn', maNote: 'rating' }
    });
    expect(mappedJson).toHaveLength(1);
    expect(mappedJson[0]).toMatchObject({
      title: 'Dune',
      author: 'Frank Herbert',
      isbn: '9782266320481',
      rating: 5
    });
  });
});
