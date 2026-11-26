// src/shared/bibliographic/benchmark-grading.util.test.ts
import { describe, expect, it } from 'vitest';
import {
  alignGroundTruthToItems,
  buildBenchmarkGradedReport,
  buildSeriesAuditEntries,
  evaluateBenchmarkItemAgainstGroundTruth,
  generateBenchmarkMarkdownReport,
  generateBenchmarkSeriesStandaloneMarkdown,
  parseGroundTruthCsv
} from './benchmark-grading.util';
import type { BenchmarkGradedActualState, CollectionImportComparisonItem } from '../types/domain.types';

const SAMPLE_GT_CSV =
  '\uFEFFLigne;Fichier_origine;Ligne_fichier;Categorie;Profil_entree;Media;ISBN_Verifie;Titre_Attendu;Serie_Attendue;Tome_Attendu;Auteur_Attendu;Editeur_Attendu;Collection_Editoriale;Integrale_Attendue;Tomes_inclus_Attendus;Statut;Lecture;Note;Notes;Regle_Verification\r\n' +
  '1;test_01.csv;1;cat1;isbn_seul;BD;9782871293019;La Marque du diable;Le Scorpion;1;Stephen Desberg, Enrico Marini;Dargaud;;Non;;Possédé;Lu;5;"Note avec ; point-virgule";BD franco-belge classique T1\r\n' +
  '55;test_02.csv;1;cat4;titre_auteur;Roman;;L’Étranger;;;Albert Camus;Gallimard;Folio;Non;;Wishlist;À lire;;;"Folio est une collection éditoriale, jamais une série"\r\n';

function makeComparisonItem(rowNumber: number, isbn: string | null, title: string | null): CollectionImportComparisonItem {
  return {
    rowNumber,
    input: {
      isbn,
      title,
      series: null,
      volumeNumber: null,
      author: null,
      publisher: null,
      isIntegral: null,
      includedVolumes: [],
      testCategory: null,
      notes: null,
      inputProfile: isbn ? 'isbn_only' : 'title_author'
    },
    status: 'matched',
    resolutionChannel: isbn ? 'isbn_direct' : 'search_to_isbn',
    unmatchedReason: null,
    durationMs: 120,
    resolvedBookId: `bk_${rowNumber}`,
    resolvedIsbn13: isbn ?? '9782070360024',
    snapshot: null
  };
}

describe('benchmark-grading.util — Parsing corrigé 20 colonnes, alignement & rapport Markdown', () => {
  it('parse correctement les 20 colonnes et aligne automatiquement par Fichier_origine + Ligne_fichier ou par Ligne', () => {
    const gtRows = parseGroundTruthCsv(SAMPLE_GT_CSV);
    expect(gtRows).toHaveLength(2);
    expect(gtRows[0]).toMatchObject({
      ligne: 1,
      fichierOrigine: 'test_01.csv',
      ligneFichier: 1,
      categorie: 'cat1',
      profilEntree: 'isbn_seul',
      media: 'BD',
      isbnVerifie: '9782871293019',
      titreAttendu: 'La Marque du diable',
      serieAttendue: 'Le Scorpion',
      tomeAttendu: '1',
      integraleAttendue: false,
      statutAttendu: 'owned',
      lectureAttendue: 'read',
      noteAttendue: 5,
      notesAttendues: 'Note avec ; point-virgule'
    });
    expect(gtRows[1]).toMatchObject({
      ligne: 55,
      fichierOrigine: 'test_02.csv',
      ligneFichier: 1,
      categorie: 'cat4',
      serieAttendue: null,
      collectionEditoriale: 'Folio',
      statutAttendu: 'wish',
      lectureAttendue: 'to_read'
    });

    // Alignement sur un fichier unitaire (`test_02.csv` -> 1ère ligne de données rowNumber=2 -> Ligne 55!)
    const alignedUnit = alignGroundTruthToItems('test_02.csv', [makeComparisonItem(2, null, "L'Étranger")], gtRows);
    expect(alignedUnit.alignmentMode).toBe('fichier_origine');
    expect(alignedUnit.pairs).toHaveLength(1);
    expect(alignedUnit.pairs[0].expected.ligne).toBe(55);

    // Alignement sur fichier fusionné (`tests_fusionnes.csv` -> Ligne 1)
    const alignedMerged = alignGroundTruthToItems(
      'tests_fusionnes.csv',
      [makeComparisonItem(2, '9782871293019', null)],
      gtRows
    );
    expect(alignedMerged.alignmentMode).toBe('ligne');
    expect(alignedMerged.pairs).toHaveLength(1);
    expect(alignedMerged.pairs[0].expected.ligne).toBe(1);
  });

  it('détecte les fausses séries (Collection_Editoriale = Folio), génère les agrégats et un rapport Markdown complet', () => {
    const gtRows = parseGroundTruthCsv(SAMPLE_GT_CSV);

    const perfectActual: BenchmarkGradedActualState = {
      resolved: true,
      bookId: 'bk_1',
      primaryIsbn13: '9782871293019',
      knownIsbns: ['9782871293019'],
      title: 'La Marque du diable',
      seriesId: 'ser_1',
      seriesName: 'Le Scorpion',
      seriesTotalVolumes: 14,
      seriesExpanded: true,
      volumeNumber: 1,
      authors: ['Stephen Desberg', 'Enrico Marini'],
      publisher: 'Dargaud',
      allPublishers: ['Dargaud'],
      collectionName: null,
      mainCategory: 'BD',
      catalogIsIntegral: false,
      effectiveIsIntegral: false,
      effectiveIncludedVolumes: [],
      coverUrl: '/api/covers/cov_ok',
      ownershipStatus: 'owned',
      readingStatus: 'read',
      rating: 5,
      notes: 'Note avec ; point-virgule',
      resolutionChannel: 'isbn_direct',
      unmatchedReason: null,
      durationMs: 100
    };

    const trappedActual: BenchmarkGradedActualState = {
      resolved: true,
      bookId: 'bk_55',
      primaryIsbn13: '9782070360024',
      knownIsbns: ['9782070360024'],
      title: "L'Étranger",
      seriesId: 'ser_folio',
      seriesName: 'Folio', // PIÈGE : collection éditoriale transformée en série !
      seriesTotalVolumes: 5,
      seriesExpanded: false,
      volumeNumber: null,
      authors: ['Albert Camus'],
      publisher: 'Gallimard',
      allPublishers: ['Gallimard'],
      collectionName: 'Folio',
      mainCategory: 'BD', // PIÈGE : mauvais média (BD au lieu de Roman)
      catalogIsIntegral: false,
      effectiveIsIntegral: false,
      effectiveIncludedVolumes: [],
      coverUrl: '/api/covers/cov_2',
      ownershipStatus: 'wish',
      readingStatus: 'to_read',
      rating: 0,
      notes: '',
      resolutionChannel: 'search_to_isbn',
      unmatchedReason: null,
      durationMs: 200
    };

    const g1 = evaluateBenchmarkItemAgainstGroundTruth({
      item: makeComparisonItem(2, '9782871293019', null),
      dataLineNumber: 1,
      expected: gtRows[0],
      actual: perfectActual
    });
    expect(g1.verdict).toBe('perfect');
    expect(g1.failedFields).toEqual([]);

    const g2 = evaluateBenchmarkItemAgainstGroundTruth({
      item: makeComparisonItem(56, null, "L'Étranger"),
      dataLineNumber: 55,
      expected: gtRows[1],
      actual: trappedActual
    });
    expect(g2.verdict).toBe('partial');
    expect(g2.failedFields).toEqual(expect.arrayContaining(['series', 'collection_trap', 'media']));

    const report = buildBenchmarkGradedReport({
      jobId: 'imp_test01',
      inputFilename: 'tests_fusionnes.csv',
      groundTruthFilename: 'reponses_complet_1080.csv',
      alignmentMode: 'ligne',
      activeCatalogJobsCount: 0,
      unalignedRows: 0,
      items: [g1, g2]
    });

    expect(report.totals.evaluatedRows).toBe(2);
    expect(report.totals.perfectRows).toBe(1);
    expect(report.totals.partialRows).toBe(1);
    expect(report.totals.perfectRatePct).toBe(50);

    const md = generateBenchmarkMarkdownReport(report);
    expect(md).toContain('# Rapport de Benchmark Automatique');
    expect(md).toContain('## 2. Précision par champ');
    expect(md).toContain('## 3. Résultats par catégorie de test');
    expect(md).toContain('cat4 — Anti-fausses séries');
    expect(md).toContain('## 6. Écarts détectés : Attendu vs Trouvé (1)');
    expect(md).toContain('Folio est une collection éditoriale, jamais une série');
    expect(md).toContain('Anti-fausse série (Collection)');
  });

  it('construit l’audit des extensions de séries (ordre T.1..N -> HS -> INT, doublons, trous, mélange médias) et génère le Markdown dédié', () => {
    const seriesAudit = buildSeriesAuditEntries([
      {
        seriesId: 'ser_clean',
        canonicalName: 'Astérix',
        editionSignature: null,
        franchiseName: 'Astérix',
        wikidataQid: 'Q42490',
        isCompleteExpanded: true,
        sourceRowNumbers: [1],
        volumes: [
          {
            bookId: 'b2',
            title: 'La Serpe d’or',
            volumeNumber: 2,
            volumeLabel: '2',
            sortOrder: 2,
            isHorsSerie: false,
            isIntegral: false,
            includedVolumes: [],
            primaryIsbn13: '9782012101340',
            publisher: 'Hachette',
            mainCategory: 'BD',
            hasCover: true,
            authors: ['René Goscinny', 'Albert Uderzo']
          },
          {
            bookId: 'b1',
            title: 'Astérix le Gaulois',
            volumeNumber: 1,
            volumeLabel: '1',
            sortOrder: 1,
            isHorsSerie: false,
            isIntegral: false,
            includedVolumes: [],
            primaryIsbn13: '9782012101333',
            publisher: 'Hachette',
            mainCategory: 'BD',
            hasCover: true,
            authors: ['René Goscinny', 'Albert Uderzo']
          }
        ]
      },
      {
        seriesId: 'ser_bug',
        canonicalName: 'Série Suspecte',
        editionSignature: null,
        franchiseName: 'Série Suspecte',
        wikidataQid: null,
        isCompleteExpanded: true,
        sourceRowNumbers: [12, 45],
        volumes: [
          {
            bookId: 's_int',
            title: 'Intégrale 1',
            volumeNumber: 1,
            volumeLabel: '1',
            sortOrder: 1,
            isHorsSerie: false,
            isIntegral: true,
            includedVolumes: ['1', '2', '3'],
            primaryIsbn13: '9780000000009',
            publisher: 'Éditeur',
            mainCategory: 'BD',
            hasCover: true,
            authors: ['Auteur']
          },
          {
            bookId: 's_hs',
            title: 'Spécial Noël',
            volumeNumber: null,
            volumeLabel: 'HS',
            sortOrder: 100,
            isHorsSerie: true,
            isIntegral: false,
            includedVolumes: [],
            primaryIsbn13: null,
            publisher: 'Éditeur',
            mainCategory: 'BD',
            hasCover: false,
            authors: ['Auteur']
          },
          {
            bookId: 's_t1a',
            title: 'Premier album',
            volumeNumber: 1,
            volumeLabel: '1',
            sortOrder: 1,
            isHorsSerie: false,
            isIntegral: false,
            includedVolumes: [],
            primaryIsbn13: '9780000000001',
            publisher: 'Éditeur',
            mainCategory: 'BD',
            hasCover: true,
            authors: ['Auteur']
          },
          {
            bookId: 's_t1b',
            title: 'Version Roman intruse',
            volumeNumber: 1,
            volumeLabel: '1',
            sortOrder: 1,
            isHorsSerie: false,
            isIntegral: false,
            includedVolumes: [],
            primaryIsbn13: '9780000000002',
            publisher: 'Éditeur',
            mainCategory: 'Roman',
            hasCover: true,
            authors: ['Auteur']
          },
          {
            bookId: 's_t4',
            title: 'Tome 4',
            volumeNumber: 4,
            volumeLabel: '4',
            sortOrder: 4,
            isHorsSerie: false,
            isIntegral: false,
            includedVolumes: [],
            primaryIsbn13: null,
            publisher: null,
            mainCategory: 'BD',
            hasCover: false,
            authors: ['Auteur']
          }
        ]
      }
    ]);

    // La série avec signaux critiques remonte en 1er devant la série propre
    expect(seriesAudit[0].seriesId).toBe('ser_bug');
    expect(seriesAudit[0].flags).toEqual(
      expect.arrayContaining(['mixed_media', 'duplicate_volume_numbers', 'volume_gaps', 'missing_covers', 'missing_isbns', 'generic_titles'])
    );
    expect(seriesAudit[0].duplicateVolumeNumbers).toEqual([1]);
    expect(seriesAudit[0].missingVolumeGaps).toEqual([2, 3]);
    // Ordre des tomes : T.1, T.1, T.4, HS, INT
    expect(seriesAudit[0].volumes.map((v) => v.bookId)).toEqual(['s_t1a', 's_t1b', 's_t4', 's_hs', 's_int']);

    expect(seriesAudit[1].seriesId).toBe('ser_clean');
    expect(seriesAudit[1].flags).toEqual([]);

    const report = buildBenchmarkGradedReport({
      jobId: 'imp_ser01',
      inputFilename: 'tests_fusionnes.csv',
      groundTruthFilename: 'reponses_complet_1080.csv',
      alignmentMode: 'ligne',
      activeCatalogJobsCount: 0,
      unalignedRows: 0,
      items: [],
      seriesAudit
    });

    const standaloneMd = generateBenchmarkSeriesStandaloneMarkdown(report);
    expect(standaloneMd).toContain('# Audit des Extensions de Séries');
    expect(standaloneMd).toContain('### Série Suspecte');
    expect(standaloneMd).toContain('`T.1` — **Premier album**');
    expect(standaloneMd).toContain('`HS` — **Spécial Noël**');
    expect(standaloneMd).toContain('`INT [1,2,3]` — **Intégrale 1**');
    expect(standaloneMd).toContain('Médias mélangés (BD/Roman)');
    expect(standaloneMd).toContain('Trous (2,3)');
  });
});
