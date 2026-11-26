// src/shared/bibliographic/benchmark-grading.util.ts
// Moteur pur (zéro import Vue/Node/SQL/réseau) de parsing du CSV de correction (vérité terrain),
// d'alignement, de notation automatique champ par champ et de génération du rapport Markdown.

import { parseCsvToMatrix } from './collection-import.util';
import { parseIncludedVolumeNumbers } from './integral.util';
import { isbnUtil } from './isbn.util';
import {
  extractFranchiseBaseName,
  isCompatibleSeriesName,
  isGenericVolumeTitle,
  matchesAuthorName,
  normalizeSeriesNumber,
  normalizeTextKey,
  tokenOverlapRatio
} from './text-normalize.util';
import type {
  AdminBenchmarkGradedReport,
  BenchmarkCheckField,
  BenchmarkFieldCheck,
  BenchmarkFieldStat,
  BenchmarkGradedActualState,
  BenchmarkGradedItem,
  BenchmarkRateBucket,
  BenchmarkSeriesAuditEntry,
  BenchmarkSeriesAuditFlag,
  BenchmarkSeriesVolumeSummary,
  BookMainCategory,
  CollectionImportComparisonItem,
  GroundTruthRow,
  OwnershipStatus,
  ReadingStatus
} from '../types/domain.types';

type GroundTruthFieldKey =
  | 'ligne'
  | 'fichierOrigine'
  | 'ligneFichier'
  | 'categorie'
  | 'profilEntree'
  | 'media'
  | 'isbnVerifie'
  | 'titreAttendu'
  | 'serieAttendue'
  | 'tomeAttendu'
  | 'auteurAttendu'
  | 'editeurAttendu'
  | 'collectionEditoriale'
  | 'integraleAttendue'
  | 'tomesInclusAttendus'
  | 'statutAttendu'
  | 'lectureAttendue'
  | 'noteAttendue'
  | 'notesAttendues'
  | 'regleVerification';

const GT_HEADER_ALIASES: Record<string, GroundTruthFieldKey> = {
  ligne: 'ligne',
  row: 'ligne',
  id: 'ligne',
  testid: 'ligne',
  fichierorigine: 'fichierOrigine',
  sourcefile: 'fichierOrigine',
  fichier: 'fichierOrigine',
  lignefichier: 'ligneFichier',
  filerow: 'ligneFichier',
  categorie: 'categorie',
  category: 'categorie',
  profilentree: 'profilEntree',
  profil: 'profilEntree',
  profile: 'profilEntree',
  media: 'media',
  type: 'media',
  maincategory: 'media',
  isbnverifie: 'isbnVerifie',
  isbnattendu: 'isbnVerifie',
  isbn: 'isbnVerifie',
  isbn13: 'isbnVerifie',
  titreattendu: 'titreAttendu',
  titre: 'titreAttendu',
  title: 'titreAttendu',
  serieattendue: 'serieAttendue',
  serie: 'serieAttendue',
  series: 'serieAttendue',
  tomeattendu: 'tomeAttendu',
  tome: 'tomeAttendu',
  volume: 'tomeAttendu',
  auteurattendu: 'auteurAttendu',
  auteursattendus: 'auteurAttendu',
  auteur: 'auteurAttendu',
  auteurs: 'auteurAttendu',
  editeurattendu: 'editeurAttendu',
  editeur: 'editeurAttendu',
  publisher: 'editeurAttendu',
  collectioneditoriale: 'collectionEditoriale',
  collection: 'collectionEditoriale',
  integraleattendue: 'integraleAttendue',
  integrale: 'integraleAttendue',
  tomesinclusattendus: 'tomesInclusAttendus',
  tomesinclus: 'tomesInclusAttendus',
  statut: 'statutAttendu',
  statutattendu: 'statutAttendu',
  lecture: 'lectureAttendue',
  lectureattendue: 'lectureAttendue',
  note: 'noteAttendue',
  noteattendue: 'noteAttendue',
  notes: 'notesAttendues',
  notesattendues: 'notesAttendues',
  regleverification: 'regleVerification',
  regle: 'regleVerification',
  regleqa: 'regleVerification'
};

const CATEGORY_LABELS: Record<string, string> = {
  cat1: 'cat1 — BD franco-belges',
  cat2: 'cat2 — Mangas/Comics redécoupage',
  cat3: 'cat3 — Intégrales & Coffrets',
  cat4: 'cat4 — Anti-fausses séries',
  cat5: 'cat5 — Séparation médias',
  cat6: 'cat6 — Cas piégeux',
  cat7: 'cat7 — Cycles & One-shots',
  cat8: 'cat8 — Cas de bord',
  surp: 'surp — Livres surprise'
};

const FIELD_LABELS_FR: Record<BenchmarkCheckField, string> = {
  resolved: 'Résolution (trouvé)',
  isbn: 'ISBN-13 vérifié',
  title: 'Titre canonique',
  series: 'Série / One-shot',
  collection_trap: 'Anti-fausse série (Collection)',
  volume: 'Numéro de tome',
  media: 'Média / Catégorie',
  author: 'Auteur(s)',
  publisher: 'Éditeur',
  integral: 'Intégrale & Tomes inclus',
  cover: 'Couverture WebP',
  user_data: 'Données perso (Statut/Lecture/Note/Notes)'
};

const ALL_CHECK_FIELDS: BenchmarkCheckField[] = [
  'resolved',
  'isbn',
  'title',
  'series',
  'collection_trap',
  'volume',
  'media',
  'author',
  'publisher',
  'integral',
  'cover',
  'user_data'
];

const SERIES_FLAG_LABELS_FR: Record<BenchmarkSeriesAuditFlag, string> = {
  mixed_media: 'Mélange médias',
  duplicate_volume_numbers: 'Doublon n° tome',
  volume_gaps: 'Trous numérotation',
  not_expanded: 'Non étendue',
  single_volume: '1 seul tome',
  missing_covers: 'Couv. manquantes',
  missing_isbns: 'Tomes sans ISBN',
  generic_titles: 'Titres génériques'
};

const SERIES_FLAG_SEVERITY: Record<BenchmarkSeriesAuditFlag, number> = {
  mixed_media: 100,
  duplicate_volume_numbers: 90,
  volume_gaps: 70,
  not_expanded: 60,
  single_volume: 50,
  generic_titles: 30,
  missing_isbns: 20,
  missing_covers: 10
};

export interface RawSeriesAuditInput {
  seriesId: string;
  canonicalName: string;
  editionSignature: string | null;
  franchiseName: string | null;
  wikidataQid: string | null;
  isCompleteExpanded: boolean;
  sourceRowNumbers: number[];
  volumes: Array<{
    bookId: string;
    title: string;
    volumeNumber: number | null;
    volumeLabel: string | null;
    sortOrder: number | null;
    isHorsSerie: boolean;
    isIntegral: boolean;
    includedVolumes: string[];
    primaryIsbn13: string | null;
    publisher: string | null;
    mainCategory: BookMainCategory;
    hasCover: boolean;
    authors: string[];
  }>;
}

function normalizeHeaderKey(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cleanStr(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

function parseIntOrNull(raw: unknown): number | null {
  const s = cleanStr(raw);
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseBoolOrNull(raw: unknown): boolean | null {
  const s = cleanStr(raw);
  if (!s) return null;
  const key = normalizeHeaderKey(s);
  if (key === 'oui' || key === 'yes' || key === 'true' || key === '1') return true;
  if (key === 'non' || key === 'no' || key === 'false' || key === '0') return false;
  return null;
}

function parseOwnership(raw: unknown): OwnershipStatus | null {
  const s = cleanStr(raw);
  if (!s) return null;
  const key = normalizeHeaderKey(s);
  if (key === 'possede' || key === 'owned' || key === 'collection') return 'owned';
  if (key === 'wishlist' || key === 'wish' || key === 'envie' || key === 'souhait') return 'wish';
  if (key === 'none' || key === 'nonpossede') return 'none';
  return null;
}

function parseReading(raw: unknown): ReadingStatus | null {
  const s = cleanStr(raw);
  if (!s) return null;
  const key = normalizeHeaderKey(s);
  if (key === 'lu' || key === 'read') return 'read';
  if (key === 'encours' || key === 'reading') return 'reading';
  if (key === 'alire' || key === 'toread' || key === 'pal') return 'to_read';
  if (key === 'abandonne' || key === 'abandoned') return 'abandoned';
  if (key === 'none' || key === 'non') return 'none';
  return null;
}

function parseRating(raw: unknown): number | null {
  const s = cleanStr(raw);
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= 0 && rounded <= 5 ? rounded : null;
}

function roundPct(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.round((num / den) * 1000) / 10;
}

/**
 * Parse un fichier CSV de correction (`reponses_complet_1080.csv` ou unitaire).
 */
export function parseGroundTruthCsv(rawText: string): GroundTruthRow[] {
  const matrix = parseCsvToMatrix(rawText);
  if (matrix.length < 2) return [];

  const headerRow = matrix[0];
  const colMap = new Map<number, GroundTruthFieldKey>();
  headerRow.forEach((h, idx) => {
    const mapped = GT_HEADER_ALIASES[normalizeHeaderKey(h)];
    if (mapped && !Array.from(colMap.values()).includes(mapped)) {
      colMap.set(idx, mapped);
    }
  });

  if (colMap.size === 0) return [];

  const out: GroundTruthRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i];
    const rec: Partial<Record<GroundTruthFieldKey, string>> = {};
    for (const [colIdx, field] of colMap.entries()) {
      rec[field] = cells[colIdx] ?? '';
    }

    const ligne = parseIntOrNull(rec.ligne) ?? i;
    const rawIncluded = cleanStr(rec.tomesInclusAttendus);
    const tomesInclusAttendus = rawIncluded ? parseIncludedVolumeNumbers(rawIncluded) : [];

    out.push({
      ligne,
      fichierOrigine: cleanStr(rec.fichierOrigine),
      ligneFichier: parseIntOrNull(rec.ligneFichier),
      categorie: cleanStr(rec.categorie),
      profilEntree: cleanStr(rec.profilEntree),
      media: cleanStr(rec.media),
      isbnVerifie: cleanStr(rec.isbnVerifie),
      titreAttendu: cleanStr(rec.titreAttendu),
      serieAttendue: cleanStr(rec.serieAttendue),
      tomeAttendu: cleanStr(rec.tomeAttendu),
      auteurAttendu: cleanStr(rec.auteurAttendu),
      editeurAttendu: cleanStr(rec.editeurAttendu),
      collectionEditoriale: cleanStr(rec.collectionEditoriale),
      integraleAttendue: parseBoolOrNull(rec.integraleAttendue),
      tomesInclusAttendus,
      statutAttendu: parseOwnership(rec.statutAttendu),
      lectureAttendue: parseReading(rec.lectureAttendue),
      noteAttendue: parseRating(rec.noteAttendue),
      notesAttendues: cleanStr(rec.notesAttendues),
      regleVerification: cleanStr(rec.regleVerification)
    });
  }

  return out;
}

/**
 * Aligne les lignes d'un import avec la vérité terrain :
 * - Si le nom du fichier importé (ex. `test_01.csv`) correspond à `Fichier_origine` dans le corrigé, aligne via `Ligne_fichier` (1..54).
 * - Sinon, aligne 1-pour-1 via `Ligne` (1..1080) sur l'index de ligne de données (`rowNumber - 1` hors en-tête).
 */
export function alignGroundTruthToItems(
  inputFilename: string,
  items: CollectionImportComparisonItem[],
  gtRows: GroundTruthRow[]
): {
  alignmentMode: 'fichier_origine' | 'ligne';
  pairs: Array<{ item: CollectionImportComparisonItem; dataLineNumber: number; expected: GroundTruthRow }>;
  unalignedCount: number;
} {
  const baseName = inputFilename.split(/[/\\]/).pop()?.trim().toLowerCase() ?? '';
  const matchingSourceRows = baseName
    ? gtRows.filter((r) => (r.fichierOrigine?.split(/[/\\]/).pop()?.trim().toLowerCase() ?? '') === baseName)
    : [];

  const useFileOrigin = matchingSourceRows.length > 0;
  const byKey = new Map<number, GroundTruthRow>();

  if (useFileOrigin) {
    matchingSourceRows.forEach((r, idx) => {
      const key = r.ligneFichier ?? idx + 1;
      byKey.set(key, r);
    });
  } else {
    gtRows.forEach((r, idx) => {
      const key = r.ligne || idx + 1;
      byKey.set(key, r);
    });
  }

  const pairs: Array<{ item: CollectionImportComparisonItem; dataLineNumber: number; expected: GroundTruthRow }> = [];
  let unalignedCount = 0;

  items.forEach((item, idx) => {
    // `item.rowNumber` est 1-based fichier CSV (2 = 1ère ligne de données après en-tête).
    const dataLineNumber = item.rowNumber >= 2 ? item.rowNumber - 1 : idx + 1;
    const gt = byKey.get(dataLineNumber) ?? byKey.get(idx + 1);
    if (gt) {
      pairs.push({ item, dataLineNumber, expected: gt });
    } else {
      unalignedCount++;
    }
  });

  return {
    alignmentMode: useFileOrigin ? 'fichier_origine' : 'ligne',
    pairs,
    unalignedCount
  };
}

/**
 * Table d'équivalence stricte entre `Media` du corrigé (14 valeurs) et `BookMainCategory` (10 catégories V2).
 * Garantit la séparation stricte entre BD, Manga, Comics et Roman d'une même franchise.
 */
export function mapExpectedMediaToAllowedCategories(expectedMedia: string): BookMainCategory[] {
  const key = normalizeHeaderKey(expectedMedia);
  if (key === 'bd' || key === 'bandedessinee') return ['BD'];
  if (key === 'manga') return ['Manga'];
  if (key === 'comics' || key === 'comic') return ['Comics'];
  if (key === 'roman' || key === 'fantasy' || key === 'nouvelles' || key === 'sf' || key === 'polar') {
    return ['Roman'];
  }
  if (key === 'classique') return ['Roman', 'Poésie / Théâtre'];
  if (key === 'contes' || key === 'conte') return ['Roman', 'Jeunesse'];
  if (key === 'jeunesse') return ['Jeunesse', 'Roman'];
  if (key === 'essai') return ['Essai'];
  if (key === 'biographie') return ['Essai', 'Roman'];
  if (key === 'theatre' || key === 'poesie' || key === 'poesietheatre') return ['Poésie / Théâtre'];
  if (key === 'pratique') return ['Pratique'];
  if (key === 'art' || key === 'artbeaulivre' || key === 'beaulivre') return ['Art / Beau livre'];
  return ['Autre'];
}

function titlesMatch(expectedTitle: string, actualTitle: string | null, actualSeriesName: string | null): boolean {
  if (!actualTitle) return false;
  const normExp = normalizeTextKey(expectedTitle);
  const normAct = normalizeTextKey(actualTitle);
  if (!normExp || !normAct) return false;
  if (normExp === normAct) return true;

  // Accepte si le titre attendu est préfixé par la série (ex: "Astérix : Astérix le Gaulois") ou vice-versa
  const fullActual = [actualSeriesName, actualTitle].filter(Boolean).join(' ');
  const normFull = normalizeTextKey(fullActual);
  if (normExp === normFull) return true;

  if (normExp.length >= 4 && normAct.length >= 4 && (normAct.includes(normExp) || normExp.includes(normAct))) {
    return true;
  }
  if (normExp.length >= 4 && normFull.includes(normExp)) {
    return true;
  }

  const forward = tokenOverlapRatio(expectedTitle, actualTitle);
  const backward = tokenOverlapRatio(actualTitle, expectedTitle);
  const withSeries = tokenOverlapRatio(expectedTitle, fullActual);
  return (forward >= 0.6 && backward >= 0.5) || (withSeries >= 0.7 && tokenOverlapRatio(actualTitle, expectedTitle) >= 0.5);
}

function seriesMatch(expectedSeries: string, actualSeries: string | null): boolean {
  if (!actualSeries) return false;
  if (isCompatibleSeriesName(actualSeries, expectedSeries)) return true;
  const expBase = extractFranchiseBaseName(expectedSeries).normalizedKey;
  const actBase = extractFranchiseBaseName(actualSeries).normalizedKey;
  if (expBase && actBase && expBase === actBase) return true;
  return (
    tokenOverlapRatio(expectedSeries, actualSeries) >= 0.7 &&
    tokenOverlapRatio(actualSeries, expectedSeries) >= 0.7
  );
}

function collectionMatchesSeries(collectionName: string, actualSeries: string): boolean {
  const normCol = normalizeTextKey(collectionName);
  const normSer = normalizeTextKey(actualSeries);
  if (!normCol || !normSer) return false;
  if (normCol === normSer) return true;
  if (normCol.length >= 4 && (normSer.includes(normCol) || normCol.includes(normSer))) return true;
  return tokenOverlapRatio(collectionName, actualSeries) >= 0.75 && tokenOverlapRatio(actualSeries, collectionName) >= 0.75;
}

function publishersMatch(expectedPublisher: string, actualPublishers: string[]): boolean {
  const normExp = normalizeTextKey(expectedPublisher)
    .replace(/^(?:editions?|les editions?|librairie)\s+/i, '')
    .trim();
  if (!normExp) return true;

  return actualPublishers.some((pub) => {
    const normAct = normalizeTextKey(pub)
      .replace(/^(?:editions?|les editions?|librairie)\s+/i, '')
      .trim();
    if (!normAct) return false;
    if (normAct === normExp) return true;
    if (normExp.length >= 3 && (normAct.includes(normExp) || normExp.includes(normAct))) return true;
    return tokenOverlapRatio(normExp, normAct) >= 0.6 || tokenOverlapRatio(normAct, normExp) >= 0.6;
  });
}

function authorsMatch(expectedAuthorStr: string, actualAuthors: string[]): boolean {
  if (actualAuthors.length === 0) return false;
  if (actualAuthors.some((a) => matchesAuthorName(a, expectedAuthorStr))) return true;

  // Découpe les co-auteurs séparés par virgule/point-virgule/slash/&/et (sans casser "Nom, Prénom")
  const segments = expectedAuthorStr
    .split(/\s*(?:\/|&|;|\bet\b|\band\b|,(?=\s*[A-ZÀ-ÿ][a-zà-ÿ]+\s+[A-ZÀ-ÿ]))\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length <= 1) return false;
  let hits = 0;
  for (const seg of segments) {
    if (actualAuthors.some((a) => matchesAuthorName(a, seg))) hits++;
  }
  return hits >= Math.ceil(segments.length / 2);
}

function includedVolumesMatch(expected: string[], actual: string[]): boolean {
  if (expected.length === 0) return true;
  const actualSet = new Set(actual.map((v) => normalizeSeriesNumber(v) || v.trim()));
  return expected.every((v) => actualSet.has(normalizeSeriesNumber(v) || v.trim()));
}

/**
 * Évalue une ligne d'import (état réel en base) face à sa ligne de correction attendue.
 */
export function evaluateBenchmarkItemAgainstGroundTruth(input: {
  item: CollectionImportComparisonItem;
  dataLineNumber: number;
  expected: GroundTruthRow;
  actual: BenchmarkGradedActualState;
}): BenchmarkGradedItem {
  const { item, dataLineNumber, expected, actual } = input;
  const checks: BenchmarkFieldCheck[] = [];

  // 1. Résolution
  if (!actual.resolved) {
    checks.push({
      field: 'resolved',
      status: 'fail',
      expected: expected.titreAttendu || expected.isbnVerifie || 'Trouvé',
      actual: `Non trouvé (${actual.unmatchedReason ?? 'unmatched'})`
    });
    return {
      rowNumber: item.rowNumber,
      dataLineNumber,
      input: item.input,
      expected,
      actual,
      checks,
      failedFields: ['resolved'],
      verdict: 'failed',
      passedChecksCount: 0,
      evaluatedChecksCount: 1
    };
  }

  checks.push({
    field: 'resolved',
    status: 'pass',
    expected: 'Trouvé',
    actual: actual.primaryIsbn13 ?? actual.bookId ?? 'Trouvé'
  });

  // 2. ISBN vérifié (uniquement quand renseigné dans le corrigé, i.e. les 200 lignes ISBN)
  if (expected.isbnVerifie) {
    const expIsbn = isbnUtil.normalizeToIsbn13(expected.isbnVerifie) ?? expected.isbnVerifie;
    const knownSet = new Set(
      [actual.primaryIsbn13, ...actual.knownIsbns]
        .filter((x): x is string => Boolean(x))
        .map((x) => isbnUtil.normalizeToIsbn13(x) ?? x)
    );
    const ok = knownSet.has(expIsbn);
    checks.push({
      field: 'isbn',
      status: ok ? 'pass' : 'fail',
      expected: expIsbn,
      actual: actual.primaryIsbn13 ?? Array.from(knownSet)[0] ?? '—'
    });
  } else {
    checks.push({ field: 'isbn', status: 'na', expected: '—', actual: actual.primaryIsbn13 ?? '—' });
  }

  // 3. Titre canonique
  if (expected.titreAttendu) {
    const ok = titlesMatch(expected.titreAttendu, actual.title, actual.seriesName);
    checks.push({
      field: 'title',
      status: ok ? 'pass' : 'fail',
      expected: expected.titreAttendu,
      actual: actual.title ?? '—'
    });
  } else {
    checks.push({ field: 'title', status: 'na', expected: '—', actual: actual.title ?? '—' });
  }

  // 4. Série attendue vs One-shot (toujours évalué : vide = doit être One-shot !)
  if (expected.serieAttendue) {
    const ok = seriesMatch(expected.serieAttendue, actual.seriesName);
    checks.push({
      field: 'series',
      status: ok ? 'pass' : 'fail',
      expected: expected.serieAttendue,
      actual: actual.seriesName ?? 'Aucune (One-shot)'
    });
  } else {
    const ok = !actual.seriesName;
    checks.push({
      field: 'series',
      status: ok ? 'pass' : 'fail',
      expected: 'Aucune (One-shot)',
      actual: actual.seriesName ?? 'Aucune (One-shot)',
      detail: !ok ? 'Fausse série créée sur une œuvre autonome' : undefined
    });
  }

  // 5. Anti-fausse série sur Collection_Editoriale
  if (expected.collectionEditoriale) {
    const seriesIsSameAsExpected =
      Boolean(expected.serieAttendue) &&
      collectionMatchesSeries(expected.collectionEditoriale, expected.serieAttendue!);
    if (seriesIsSameAsExpected) {
      checks.push({
        field: 'collection_trap',
        status: 'na',
        expected: expected.collectionEditoriale,
        actual: actual.seriesName ?? '—'
      });
    } else {
      const trapped = Boolean(actual.seriesName && collectionMatchesSeries(expected.collectionEditoriale, actual.seriesName));
      checks.push({
        field: 'collection_trap',
        status: trapped ? 'fail' : 'pass',
        expected: `Ne pas transformer « ${expected.collectionEditoriale} » en série`,
        actual: actual.seriesName ?? 'Aucune série',
        detail: trapped ? `Collection « ${expected.collectionEditoriale} » confondue avec une série` : undefined
      });
    }
  } else {
    checks.push({ field: 'collection_trap', status: 'na', expected: '—', actual: '—' });
  }

  // 6. Numéro de tome
  if (expected.tomeAttendu) {
    const normExp = normalizeSeriesNumber(expected.tomeAttendu);
    const parsedExp = /^\d+$/.test(normExp) ? parseInt(normExp, 10) : null;
    if (parsedExp !== null) {
      const coveredByIntegral =
        actual.effectiveIsIntegral && actual.effectiveIncludedVolumes.includes(String(parsedExp));
      const ok = actual.volumeNumber === parsedExp || coveredByIntegral;
      checks.push({
        field: 'volume',
        status: ok ? 'pass' : 'fail',
        expected: String(parsedExp),
        actual: actual.volumeNumber !== null ? String(actual.volumeNumber) : actual.effectiveIsIntegral ? `Intégrale [${actual.effectiveIncludedVolumes.join(',')}]` : '—'
      });
    } else {
      checks.push({ field: 'volume', status: 'na', expected: expected.tomeAttendu, actual: String(actual.volumeNumber ?? '—') });
    }
  } else if (!expected.serieAttendue && expected.integraleAttendue !== true) {
    // One-shot sans tome attendu : vérifie qu'un numéro parasite n'a pas été attaché
    const ok = actual.volumeNumber === null;
    checks.push({
      field: 'volume',
      status: ok ? 'pass' : 'fail',
      expected: 'Aucun',
      actual: actual.volumeNumber !== null ? String(actual.volumeNumber) : 'Aucun'
    });
  } else {
    checks.push({ field: 'volume', status: 'na', expected: '—', actual: String(actual.volumeNumber ?? '—') });
  }

  // 7. Média / Catégorie principale
  if (expected.media) {
    const allowed = mapExpectedMediaToAllowedCategories(expected.media);
    const ok = actual.mainCategory !== null && allowed.includes(actual.mainCategory);
    checks.push({
      field: 'media',
      status: ok ? 'pass' : 'fail',
      expected: `${expected.media} (${allowed.join(' / ')})`,
      actual: actual.mainCategory ?? '—'
    });
  } else {
    checks.push({ field: 'media', status: 'na', expected: '—', actual: actual.mainCategory ?? '—' });
  }

  // 8. Auteur(s)
  if (expected.auteurAttendu) {
    const ok = authorsMatch(expected.auteurAttendu, actual.authors);
    checks.push({
      field: 'author',
      status: ok ? 'pass' : 'fail',
      expected: expected.auteurAttendu,
      actual: actual.authors.join(', ') || '—'
    });
  } else {
    checks.push({ field: 'author', status: 'na', expected: '—', actual: actual.authors.join(', ') || '—' });
  }

  // 9. Éditeur
  if (expected.editeurAttendu) {
    const candidates = Array.from(
      new Set([actual.publisher, ...actual.allPublishers].filter((x): x is string => Boolean(x)))
    );
    const ok = publishersMatch(expected.editeurAttendu, candidates);
    checks.push({
      field: 'publisher',
      status: ok ? 'pass' : 'fail',
      expected: expected.editeurAttendu,
      actual: actual.publisher ?? candidates[0] ?? '—'
    });
  } else {
    checks.push({ field: 'publisher', status: 'na', expected: '—', actual: actual.publisher ?? '—' });
  }

  // 10. Intégrale & Tomes inclus
  if (expected.integraleAttendue !== null) {
    // Quand Integrale était vide en entrée, seul `catalogIsIntegral` prouve la détection auto du moteur.
    const actualIntegralFlag =
      item.input.isIntegral === true ? actual.effectiveIsIntegral : actual.catalogIsIntegral;
    const flagOk = actualIntegralFlag === expected.integraleAttendue;
    const volumesOk =
      !expected.integraleAttendue ||
      expected.tomesInclusAttendus.length === 0 ||
      includedVolumesMatch(expected.tomesInclusAttendus, actual.effectiveIncludedVolumes);
    const ok = flagOk && volumesOk;
    const expDesc = expected.integraleAttendue
      ? expected.tomesInclusAttendus.length > 0
        ? `Oui [${expected.tomesInclusAttendus.join(',')}]`
        : 'Oui'
      : 'Non';
    const actDesc = actualIntegralFlag
      ? actual.effectiveIncludedVolumes.length > 0
        ? `Oui [${actual.effectiveIncludedVolumes.join(',')}]`
        : 'Oui'
      : 'Non';
    checks.push({
      field: 'integral',
      status: ok ? 'pass' : 'fail',
      expected: expDesc,
      actual: actDesc,
      detail: !flagOk && expected.integraleAttendue ? 'Intégrale non détectée automatiquement' : !volumesOk ? 'Tomes inclus incomplets' : undefined
    });
  } else {
    checks.push({ field: 'integral', status: 'na', expected: '—', actual: actual.effectiveIsIntegral ? 'Oui' : 'Non' });
  }

  // 11. Couverture WebP
  checks.push({
    field: 'cover',
    status: actual.coverUrl ? 'pass' : 'fail',
    expected: 'Présente',
    actual: actual.coverUrl ? 'Présente' : 'Manquante'
  });

  // 12. Préservation des données utilisateur (Statut, Lecture, Note, Notes)
  const userDiffs: string[] = [];
  if (expected.statutAttendu && actual.ownershipStatus !== expected.statutAttendu) {
    userDiffs.push(`Statut(${expected.statutAttendu} ≠ ${actual.ownershipStatus ?? 'none'})`);
  }
  const expRead: ReadingStatus = expected.lectureAttendue ?? 'none';
  const actRead: ReadingStatus = actual.readingStatus ?? 'none';
  if (expRead !== 'none' && actRead !== expRead) {
    userDiffs.push(`Lecture(${expRead} ≠ ${actRead})`);
  }
  const expRating = expected.noteAttendue ?? 0;
  const actRating = actual.rating ?? 0;
  if (expRating > 0 && actRating !== expRating) {
    userDiffs.push(`Note(${expRating} ≠ ${actRating})`);
  }
  const expNotes = (expected.notesAttendues ?? '').trim();
  const actNotes = (actual.notes ?? '').trim();
  if (expNotes && actNotes !== expNotes) {
    userDiffs.push('Notes altérées');
  }

  const hasAnyExpectedUserData = Boolean(expected.statutAttendu || expRead !== 'none' || expRating > 0 || expNotes);
  if (hasAnyExpectedUserData) {
    checks.push({
      field: 'user_data',
      status: userDiffs.length === 0 ? 'pass' : 'fail',
      expected: 'Conservées à l’identique',
      actual: userDiffs.length === 0 ? 'OK' : userDiffs.join(', ')
    });
  } else {
    checks.push({ field: 'user_data', status: 'na', expected: '—', actual: '—' });
  }

  const evaluated = checks.filter((c) => c.status !== 'na');
  const failedFields = evaluated.filter((c) => c.status === 'fail').map((c) => c.field);
  const passedChecksCount = evaluated.length - failedFields.length;

  return {
    rowNumber: item.rowNumber,
    dataLineNumber,
    input: item.input,
    expected,
    actual,
    checks,
    failedFields,
    verdict: failedFields.length === 0 ? 'perfect' : 'partial',
    passedChecksCount,
    evaluatedChecksCount: evaluated.length
  };
}

function sortSeriesVolumes(
  volumes: RawSeriesAuditInput['volumes'],
  seriesName: string
): BenchmarkSeriesVolumeSummary[] {
  const bucket = (v: RawSeriesAuditInput['volumes'][number]): number => {
    if (v.isIntegral) return 2;
    if (v.isHorsSerie) return 1;
    return 0;
  };
  const firstIncludedNum = (arr: string[]): number => {
    for (const s of arr) {
      const n = parseInt(s, 10);
      if (Number.isFinite(n)) return n;
    }
    return 999999;
  };

  return [...volumes]
    .sort((a, b) => {
      const ba = bucket(a);
      const bb = bucket(b);
      if (ba !== bb) return ba - bb;
      const na = a.isIntegral
        ? (a.volumeNumber ?? firstIncludedNum(a.includedVolumes))
        : (a.volumeNumber ?? a.sortOrder ?? 999999);
      const nb = b.isIntegral
        ? (b.volumeNumber ?? firstIncludedNum(b.includedVolumes))
        : (b.volumeNumber ?? b.sortOrder ?? 999999);
      if (na !== nb) return na - nb;
      return a.title.localeCompare(b.title, 'fr');
    })
    .map((v) => ({
      bookId: v.bookId,
      title: v.title,
      volumeNumber: v.volumeNumber,
      volumeLabel: v.volumeLabel,
      isHorsSerie: v.isHorsSerie,
      isIntegral: v.isIntegral,
      includedVolumes: v.includedVolumes,
      primaryIsbn13: v.primaryIsbn13,
      publisher: v.publisher,
      mainCategory: v.mainCategory,
      hasCover: v.hasCover,
      authors: v.authors,
      isGenericTitle: !v.isIntegral && isGenericVolumeTitle(v.title, seriesName)
    }));
}

/**
 * Construit l'audit structuré de chaque série étendue (inventaire ordonné des tomes + signaux mécaniques évidents)
 * pour permettre la vérification humaine / IA de la qualité des extensions de séries.
 */
export function buildSeriesAuditEntries(rawList: RawSeriesAuditInput[]): BenchmarkSeriesAuditEntry[] {
  const entries: BenchmarkSeriesAuditEntry[] = rawList.map((raw) => {
    const volumes = sortSeriesVolumes(raw.volumes, raw.canonicalName);
    const regular = volumes.filter((v) => !v.isIntegral && !v.isHorsSerie);
    const horsSeries = volumes.filter((v) => v.isHorsSerie && !v.isIntegral);
    const integrals = volumes.filter((v) => v.isIntegral);

    const coversCount = volumes.filter((v) => v.hasCover).length;
    const missingIsbnCount = volumes.filter((v) => !v.primaryIsbn13).length;
    const genericTitlesCount = volumes.filter((v) => v.isGenericTitle).length;

    const numCounts = new Map<number, number>();
    for (const v of regular) {
      if (v.volumeNumber !== null && v.volumeNumber > 0) {
        numCounts.set(v.volumeNumber, (numCounts.get(v.volumeNumber) ?? 0) + 1);
      }
    }
    const duplicateVolumeNumbers = Array.from(numCounts.entries())
      .filter(([, cnt]) => cnt > 1)
      .map(([n]) => n)
      .sort((a, b) => a - b);

    const presentNums = Array.from(numCounts.keys()).sort((a, b) => a - b);
    const missingVolumeGaps: number[] = [];
    if (presentNums.length >= 2) {
      const maxCheck = Math.min(presentNums[presentNums.length - 1], 120);
      for (let n = 1; n <= maxCheck; n++) {
        if (!numCounts.has(n)) {
          missingVolumeGaps.push(n);
          if (missingVolumeGaps.length >= 25) break;
        }
      }
    }

    const distinctMedia = Array.from(new Set(volumes.map((v) => v.mainCategory)));
    const nonAutreMedia = distinctMedia.filter((m) => m !== 'Autre');

    const flags: BenchmarkSeriesAuditFlag[] = [];
    if (nonAutreMedia.length > 1) flags.push('mixed_media');
    if (duplicateVolumeNumbers.length > 0) flags.push('duplicate_volume_numbers');
    if (missingVolumeGaps.length > 0) flags.push('volume_gaps');
    if (!raw.isCompleteExpanded) flags.push('not_expanded');
    if (volumes.length <= 1) flags.push('single_volume');
    if (genericTitlesCount > 0) flags.push('generic_titles');
    if (missingIsbnCount > 0) flags.push('missing_isbns');
    if (coversCount < volumes.length) flags.push('missing_covers');

    return {
      seriesId: raw.seriesId,
      canonicalName: raw.canonicalName,
      editionSignature: raw.editionSignature,
      franchiseName: raw.franchiseName,
      wikidataQid: raw.wikidataQid,
      isCompleteExpanded: raw.isCompleteExpanded,
      totalCount: volumes.length,
      regularVolumesCount: regular.length,
      horsSerieCount: horsSeries.length,
      integralsCount: integrals.length,
      coversCount,
      missingIsbnCount,
      genericTitlesCount,
      duplicateVolumeNumbers,
      missingVolumeGaps,
      distinctMedia,
      flags,
      sourceRowNumbers: Array.from(new Set(raw.sourceRowNumbers)).sort((a, b) => a - b),
      volumes
    };
  });

  const severityScore = (e: BenchmarkSeriesAuditEntry): number =>
    e.flags.reduce((acc, f) => acc + SERIES_FLAG_SEVERITY[f], 0);

  return entries.sort((a, b) => {
    const sa = severityScore(a);
    const sb = severityScore(b);
    if (sa !== sb) return sb - sa;
    return a.canonicalName.localeCompare(b.canonicalName, 'fr');
  });
}

/**
 * Agrège tous les items notés en un rapport complet (KPIs, taux par champ, par catégorie, par profil d'entrée et audit séries).
 */
export function buildBenchmarkGradedReport(input: {
  jobId: string;
  inputFilename: string;
  groundTruthFilename: string;
  alignmentMode: 'fichier_origine' | 'ligne';
  activeCatalogJobsCount: number;
  unalignedRows: number;
  items: BenchmarkGradedItem[];
  seriesAudit?: BenchmarkSeriesAuditEntry[];
  generatedAt?: string;
}): AdminBenchmarkGradedReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const { items } = input;
  const evaluatedRows = items.length;
  let resolvedRows = 0;
  let perfectRows = 0;
  let partialRows = 0;
  let failedRows = 0;
  let totalPassedChecks = 0;
  let totalEvaluatedChecks = 0;
  let totalDurationMs = 0;

  const fieldAcc = new Map<BenchmarkCheckField, { passed: number; evaluated: number; failed: number }>();
  for (const f of ALL_CHECK_FIELDS) {
    fieldAcc.set(f, { passed: 0, evaluated: 0, failed: 0 });
  }

  const catAcc = new Map<string, { total: number; resolved: number; perfect: number; partial: number; failed: number }>();
  const profAcc = new Map<string, { total: number; resolved: number; perfect: number; partial: number; failed: number }>();

  const bumpBucket = (
    map: Map<string, { total: number; resolved: number; perfect: number; partial: number; failed: number }>,
    key: string,
    verdict: BenchmarkGradedItem['verdict']
  ) => {
    const cur = map.get(key) ?? { total: 0, resolved: 0, perfect: 0, partial: 0, failed: 0 };
    cur.total++;
    if (verdict === 'failed') {
      cur.failed++;
    } else {
      cur.resolved++;
      if (verdict === 'perfect') cur.perfect++;
      else cur.partial++;
    }
    map.set(key, cur);
  };

  for (const it of items) {
    totalDurationMs += it.actual.durationMs;
    totalPassedChecks += it.passedChecksCount;
    totalEvaluatedChecks += it.evaluatedChecksCount;

    if (it.verdict === 'failed') {
      failedRows++;
    } else {
      resolvedRows++;
      if (it.verdict === 'perfect') perfectRows++;
      else partialRows++;
    }

    for (const c of it.checks) {
      if (c.status === 'na') continue;
      const st = fieldAcc.get(c.field);
      if (!st) continue;
      st.evaluated++;
      if (c.status === 'pass') st.passed++;
      else st.failed++;
    }

    bumpBucket(catAcc, it.expected.categorie || 'sans_categorie', it.verdict);
    bumpBucket(profAcc, it.expected.profilEntree || it.input.inputProfile || 'autre', it.verdict);
  }

  const fieldStats: BenchmarkFieldStat[] = ALL_CHECK_FIELDS.map((field) => {
    const st = fieldAcc.get(field)!;
    return {
      field,
      passed: st.passed,
      evaluated: st.evaluated,
      failed: st.failed,
      passRatePct: roundPct(st.passed, st.evaluated)
    };
  });

  const toBuckets = (
    map: Map<string, { total: number; resolved: number; perfect: number; partial: number; failed: number }>,
    labelMap?: Record<string, string>
  ): BenchmarkRateBucket[] =>
    Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b, 'fr'))
      .map(([key, v]) => ({
        key,
        label: labelMap?.[key] ?? key,
        total: v.total,
        resolved: v.resolved,
        perfect: v.perfect,
        partial: v.partial,
        failed: v.failed,
        resolvedRatePct: roundPct(v.resolved, v.total),
        perfectRatePct: roundPct(v.perfect, v.total)
      }));

  return {
    jobId: input.jobId,
    inputFilename: input.inputFilename,
    groundTruthFilename: input.groundTruthFilename,
    alignmentMode: input.alignmentMode,
    generatedAt,
    activeCatalogJobsCount: input.activeCatalogJobsCount,
    totals: {
      evaluatedRows,
      unalignedRows: input.unalignedRows,
      resolvedRows,
      perfectRows,
      partialRows,
      failedRows,
      resolvedRatePct: roundPct(resolvedRows, evaluatedRows),
      perfectRatePct: roundPct(perfectRows, evaluatedRows),
      fieldAccuracyPct: roundPct(totalPassedChecks, totalEvaluatedChecks),
      avgDurationMs: evaluatedRows > 0 ? Math.round(totalDurationMs / evaluatedRows) : 0
    },
    fieldStats,
    byCategory: toBuckets(catAcc, CATEGORY_LABELS),
    byProfile: toBuckets(profAcc),
    seriesAudit: input.seriesAudit ?? [],
    items
  };
}

function escapeMdCell(raw: string): string {
  return String(raw ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function formatVolumeTag(v: BenchmarkSeriesVolumeSummary): string {
  if (v.isIntegral) {
    return v.includedVolumes.length > 0 ? `INT [${v.includedVolumes.join(',')}]` : 'INT';
  }
  if (v.isHorsSerie) {
    return v.volumeNumber !== null ? `HS.${v.volumeNumber}` : 'HS';
  }
  if (v.volumeNumber !== null) return `T.${v.volumeNumber}`;
  if (v.volumeLabel) return v.volumeLabel;
  return '—';
}

function formatSeriesFlagsInline(entry: BenchmarkSeriesAuditEntry): string {
  if (entry.flags.length === 0) return '✅ RAS';
  return entry.flags
    .map((f) => {
      if (f === 'duplicate_volume_numbers') {
        return `⚠️ Doublon n° (${entry.duplicateVolumeNumbers.slice(0, 6).join(',')})`;
      }
      if (f === 'volume_gaps') {
        const preview = entry.missingVolumeGaps.slice(0, 8).join(',');
        const suffix = entry.missingVolumeGaps.length > 8 ? '…' : '';
        return `⚠️ Trous (${preview}${suffix})`;
      }
      if (f === 'mixed_media') {
        return `❌ Médias mélangés (${entry.distinctMedia.join('/')})`;
      }
      return SERIES_FLAG_LABELS_FR[f];
    })
    .join(' · ');
}

/**
 * Génère la section Markdown d'audit des extensions de séries (tableau récapitulatif + liste compacte des tomes).
 */
export function generateSeriesAuditMarkdownSection(seriesAudit: BenchmarkSeriesAuditEntry[]): string {
  const lines: string[] = [];
  if (seriesAudit.length === 0) {
    lines.push('_Aucune série créée ou rattachée sur ce lot._');
    lines.push('');
    return lines.join('\n');
  }

  const flaggedCount = seriesAudit.filter((s) => s.flags.length > 0).length;
  const totalVols = seriesAudit.reduce((sum, s) => sum + s.totalCount, 0);
  const totalCovers = seriesAudit.reduce((sum, s) => sum + s.coversCount, 0);
  const totalMissingIsbn = seriesAudit.reduce((sum, s) => sum + s.missingIsbnCount, 0);

  lines.push(
    `- **Séries auditées :** ${seriesAudit.length} (${seriesAudit.length - flaggedCount} RAS · ${flaggedCount} avec signaux) · **Total tomes en base :** ${totalVols} · **Couvertures :** ${totalCovers}/${totalVols} (${roundPct(totalCovers, totalVols)} %) · **Sans ISBN :** ${totalMissingIsbn}`
  );
  lines.push('');
  lines.push('| Série (Franchise / découpage) | Étendue | Tomes | HS | Intégrales | Couv. | Sans ISBN | Signaux |');
  lines.push('| --- | :---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const s of seriesAudit) {
    const labelParts = [s.canonicalName];
    if (s.editionSignature) labelParts.push(`(${s.editionSignature})`);
    else if (s.franchiseName && normalizeTextKey(s.franchiseName) !== normalizeTextKey(s.canonicalName)) {
      labelParts.push(`[Franchise: ${s.franchiseName}]`);
    }
    lines.push(
      `| ${escapeMdCell(labelParts.join(' '))} | ${s.isCompleteExpanded ? '✅' : '⏳'} | ${s.regularVolumesCount} | ${s.horsSerieCount} | ${s.integralsCount} | ${s.coversCount}/${s.totalCount} | ${s.missingIsbnCount} | ${escapeMdCell(formatSeriesFlagsInline(s))} |`
    );
  }
  lines.push('');

  for (const s of seriesAudit) {
    const metaParts: string[] = [
      `\`${s.seriesId}\``,
      s.franchiseName ? `Franchise: ${s.franchiseName}` : null,
      s.editionSignature ? `Découpage: \`${s.editionSignature}\`` : null,
      s.wikidataQid ? `WD: \`${s.wikidataQid}\`` : null,
      `Étendue: ${s.isCompleteExpanded ? 'Oui' : 'Non'}`,
      `Tomes: ${s.regularVolumesCount}${s.horsSerieCount > 0 ? ` + ${s.horsSerieCount} HS` : ''}${s.integralsCount > 0 ? ` + ${s.integralsCount} Int.` : ''}`,
      `Couv: ${s.coversCount}/${s.totalCount}`
    ].filter((x): x is string => Boolean(x));

    lines.push(`### ${s.canonicalName} (${metaParts.join(' · ')})`);
    if (s.sourceRowNumbers.length > 0) {
      lines.push(`- **Déclenchée par ligne(s) CSV :** ${s.sourceRowNumbers.map((n) => `#${n}`).join(', ')}`);
    }
    if (s.flags.length > 0) {
      lines.push(`- **Signaux :** ${formatSeriesFlagsInline(s)}`);
    }
    for (const v of s.volumes) {
      const tag = formatVolumeTag(v);
      const isbnPart = v.primaryIsbn13 ? `\`${v.primaryIsbn13}\`` : '`sans ISBN`';
      const pubPart = v.publisher || '—';
      const covPart = v.hasCover ? '✅' : '❌';
      const genericTag = v.isGenericTitle ? ' _(titre générique)_' : '';
      lines.push(`- \`${tag}\` — **${v.title}**${genericTag} | ${isbnPart} | ${pubPart} | ${v.mainCategory} | Couv: ${covPart}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Génère un fichier Markdown dédié uniquement à l'audit des extensions de séries (`series-<jobId>.md`).
 */
export function generateBenchmarkSeriesStandaloneMarkdown(report: AdminBenchmarkGradedReport): string {
  const lines: string[] = [
    `# Audit des Extensions de Séries — \`${report.inputFilename}\``,
    '',
    `- **Job ID :** \`${report.jobId}\``,
    `- **Fichier corrigé :** \`${report.groundTruthFilename}\``,
    `- **Généré le :** ${report.generatedAt.slice(0, 19).replace('T', ' ')} UTC`,
    ...(report.activeCatalogJobsCount > 0
      ? [
          `- **⚠️ Attention :** ${report.activeCatalogJobsCount} tâche(s) de fond (déploiement séries / couvertures) étaient encore actives au moment du calcul.`
        ]
      : []),
    '',
    generateSeriesAuditMarkdownSection(report.seriesAudit)
  ];
  return lines.join('\n');
}

/**
 * Génère un rapport Markdown complet, lisible et prêt à archiver en log ou à partager pour analyse.
 */
export function generateBenchmarkMarkdownReport(report: AdminBenchmarkGradedReport): string {
  const lines: string[] = [];
  const { totals } = report;

  lines.push(`# Rapport de Benchmark Automatique — \`${report.inputFilename}\``);
  lines.push('');
  lines.push(`- **Job ID :** \`${report.jobId}\``);
  lines.push(`- **Fichier d'entrée :** \`${report.inputFilename}\``);
  lines.push(`- **Fichier corrigé :** \`${report.groundTruthFilename}\``);
  lines.push(
    `- **Alignement :** \`${report.alignmentMode === 'fichier_origine' ? 'Fichier_origine + Ligne_fichier' : 'Ligne (1..N)'}\`${totals.unalignedRows > 0 ? ` (${totals.unalignedRows} ligne(s) non alignée(s))` : ''}`
  );
  lines.push(`- **Généré le :** ${report.generatedAt.slice(0, 19).replace('T', ' ')} UTC`);
  if (report.activeCatalogJobsCount > 0) {
    lines.push(
      `- **⚠️ Attention :** ${report.activeCatalogJobsCount} tâche(s) de fond (déploiement séries / couvertures) étaient encore actives au moment du calcul.`
    );
  }
  lines.push('');

  // 1. Synthèse globale
  lines.push('## 1. Synthèse globale');
  lines.push('');
  lines.push('| Indicateur | Valeur | Taux |');
  lines.push('| --- | ---: | ---: |');
  lines.push(`| Lignes évaluées | **${totals.evaluatedRows}** | 100 % |`);
  lines.push(`| Livres trouvés (résolus) | **${totals.resolvedRows}** | **${totals.resolvedRatePct} %** |`);
  lines.push(`| Lignes parfaites (0 écart) | **${totals.perfectRows}** | **${totals.perfectRatePct} %** |`);
  lines.push(`| Lignes avec écarts (partiels) | **${totals.partialRows}** | ${roundPct(totals.partialRows, totals.evaluatedRows)} % |`);
  lines.push(`| Échecs (non trouvés) | **${totals.failedRows}** | ${roundPct(totals.failedRows, totals.evaluatedRows)} % |`);
  lines.push(`| Précision moyenne champ par champ | — | **${totals.fieldAccuracyPct} %** |`);
  lines.push(`| Durée moyenne par ligne | **${totals.avgDurationMs} ms** | — |`);
  lines.push('');

  // 2. Précision par champ
  lines.push('## 2. Précision par champ');
  lines.push('');
  lines.push('| Champ vérifié | Réussis | Échecs | Évalués | Précision |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const fs of report.fieldStats) {
    if (fs.evaluated === 0) continue;
    lines.push(
      `| ${FIELD_LABELS_FR[fs.field]} | ${fs.passed} | ${fs.failed} | ${fs.evaluated} | **${fs.passRatePct} %** |`
    );
  }
  lines.push('');

  // 3. Résultats par catégorie
  if (report.byCategory.length > 0) {
    lines.push('## 3. Résultats par catégorie de test');
    lines.push('');
    lines.push('| Catégorie | Total | Trouvés | Parfaits | Écarts | Non trouvés | Taux trouvé | Taux parfait |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const b of report.byCategory) {
      lines.push(
        `| ${escapeMdCell(b.label)} | ${b.total} | ${b.resolved} | ${b.perfect} | ${b.partial} | ${b.failed} | ${b.resolvedRatePct} % | **${b.perfectRatePct} %** |`
      );
    }
    lines.push('');
  }

  // 4. Résultats par profil d'entrée
  if (report.byProfile.length > 0) {
    lines.push('## 4. Résultats par profil d’entrée');
    lines.push('');
    lines.push('| Profil d’entrée | Total | Trouvés | Parfaits | Écarts | Non trouvés | Taux trouvé | Taux parfait |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const b of report.byProfile) {
      lines.push(
        `| \`${escapeMdCell(b.key)}\` | ${b.total} | ${b.resolved} | ${b.perfect} | ${b.partial} | ${b.failed} | ${b.resolvedRatePct} % | **${b.perfectRatePct} %** |`
      );
    }
    lines.push('');
  }

  // 5. Échecs de résolution (non trouvés)
  const failedItems = report.items.filter((it) => it.verdict === 'failed');
  lines.push(`## 5. Échecs de résolution (${failedItems.length})`);
  lines.push('');
  if (failedItems.length === 0) {
    lines.push('_Aucun échec de résolution — 100 % des ouvrages ont été trouvés._');
    lines.push('');
  } else {
    for (const it of failedItems) {
      const originTag = it.expected.fichierOrigine
        ? `${it.expected.fichierOrigine}:${it.expected.ligneFichier ?? '?'}`
        : `L.${it.dataLineNumber}`;
      lines.push(
        `### ❌ Ligne #${it.dataLineNumber} (\`${originTag}\` · \`${it.expected.categorie ?? '—'}\` · \`${it.expected.profilEntree ?? it.input.inputProfile}\`)`
      );
      const inParts = [
        it.input.isbn ? `ISBN=\`${it.input.isbn}\`` : null,
        it.input.title ? `Titre="${it.input.title}"` : null,
        it.input.series ? `Série="${it.input.series}"` : null,
        it.input.volumeNumber ? `Tome=${it.input.volumeNumber}` : null,
        it.input.author ? `Auteur="${it.input.author}"` : null,
        it.input.publisher ? `Éditeur="${it.input.publisher}"` : null
      ].filter(Boolean);
      lines.push(`- **Entrée :** ${inParts.join(' | ') || '—'}`);
      lines.push(
        `- **Attendu :** "${it.expected.titreAttendu ?? '—'}" | Série: ${it.expected.serieAttendue ?? 'Aucune'} | Tome: ${it.expected.tomeAttendu ?? '—'} | Auteur: ${it.expected.auteurAttendu ?? '—'} | Média: ${it.expected.media ?? '—'}${it.expected.isbnVerifie ? ` | ISBN: \`${it.expected.isbnVerifie}\`` : ''}`
      );
      lines.push(`- **Raison :** \`${it.actual.unmatchedReason ?? 'unmatched'}\` (${it.actual.durationMs} ms)`);
      if (it.expected.regleVerification) {
        lines.push(`- **Règle QA :** ${it.expected.regleVerification}`);
      }
      lines.push('');
    }
  }

  // 6. Lignes avec écarts (Attendu vs Trouvé)
  const partialItems = report.items.filter((it) => it.verdict === 'partial');
  lines.push(`## 6. Écarts détectés : Attendu vs Trouvé (${partialItems.length})`);
  lines.push('');
  if (partialItems.length === 0) {
    lines.push('_Aucun écart sur les livres trouvés._');
    lines.push('');
  } else {
    for (const it of partialItems) {
      const originTag = it.expected.fichierOrigine
        ? `${it.expected.fichierOrigine}:${it.expected.ligneFichier ?? '?'}`
        : `L.${it.dataLineNumber}`;
      const failedLabels = it.failedFields.map((f) => FIELD_LABELS_FR[f]).join(', ');
      lines.push(
        `### ⚠️ Ligne #${it.dataLineNumber} (\`${originTag}\` · \`${it.expected.categorie ?? '—'}\` · \`${it.expected.profilEntree ?? it.input.inputProfile}\`) — ${failedLabels}`
      );
      const inParts = [
        it.input.isbn ? `ISBN=\`${it.input.isbn}\`` : null,
        it.input.title ? `Titre="${it.input.title}"` : null,
        it.input.series ? `Série="${it.input.series}"` : null,
        it.input.volumeNumber ? `Tome=${it.input.volumeNumber}` : null,
        it.input.author ? `Auteur="${it.input.author}"` : null,
        it.input.publisher ? `Éditeur="${it.input.publisher}"` : null
      ].filter(Boolean);
      lines.push(`- **Entrée :** ${inParts.join(' | ') || '—'}`);
      lines.push(
        `- **Trouvé :** "${it.actual.title ?? '—'}" (\`bookId=${it.actual.bookId ?? '—'}\`, \`isbn13=${it.actual.primaryIsbn13 ?? '—'}\`, canal=\`${it.actual.resolutionChannel}\`, ${it.actual.durationMs} ms)`
      );
      if (it.expected.regleVerification) {
        lines.push(`- **Règle QA :** ${it.expected.regleVerification}`);
      }
      lines.push('');
      lines.push('| Champ en écart | Attendu | Trouvé | Détail |');
      lines.push('| --- | --- | --- | --- |');
      for (const chk of it.checks.filter((c) => c.status === 'fail')) {
        lines.push(
          `| ${escapeMdCell(FIELD_LABELS_FR[chk.field])} | ${escapeMdCell(chk.expected)} | ${escapeMdCell(chk.actual)} | ${escapeMdCell(chk.detail ?? '')} |`
        );
      }
      lines.push('');
    }
  }

  // 7. Audit des extensions de séries (tableau récapitulatif + liste complète des tomes)
  lines.push(`## 7. Extensions de séries — Inventaire des tomes (${report.seriesAudit.length})`);
  lines.push('');
  lines.push(generateSeriesAuditMarkdownSection(report.seriesAudit));

  return lines.join('\n');
}
