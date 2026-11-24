// src/shared/bibliographic/collection-import.util.ts
// Parseur pur (zéro import Vue/Node/SQL/réseau) pour l'import de collections CSV, JSON et tableaux Excel (.xlsx).

import { isbnUtil } from './isbn.util';
import { parseIncludedVolumeNumbers } from './integral.util';
import type { OwnershipStatus, ReadingStatus } from '../types/domain.types';

export interface ImportedBookRow {
  rowNumber: number;
  isbn: string | null;
  title: string | null;
  series: string | null;
  volumeNumber: string | null;
  author: string | null;
  publisher: string | null;
  ownershipStatus: OwnershipStatus | null;
  isIntegral: boolean | null;
  includedVolumes: string[];
  readingStatus: ReadingStatus | null;
  rating: number | null;
  notes: string | null;
}

type ImportFieldKey =
  | 'isbn'
  | 'title'
  | 'series'
  | 'volumeNumber'
  | 'author'
  | 'publisher'
  | 'ownershipStatus'
  | 'isIntegral'
  | 'includedVolumes'
  | 'readingStatus'
  | 'rating'
  | 'notes';

const HEADER_ALIASES: Record<string, ImportFieldKey> = {
  // ISBN
  isbn: 'isbn',
  isbn13: 'isbn',
  isbn10: 'isbn',
  ean: 'isbn',
  ean13: 'isbn',
  codebarre: 'isbn',
  codebarres: 'isbn',
  barcode: 'isbn',
  primaryisbn13: 'isbn',
  // Titre
  titre: 'title',
  title: 'title',
  nom: 'title',
  name: 'title',
  livre: 'title',
  album: 'title',
  ouvrage: 'title',
  // Série
  serie: 'series',
  series: 'series',
  seriesname: 'series',
  saga: 'series',
  // Tome
  tome: 'volumeNumber',
  volume: 'volumeNumber',
  vol: 'volumeNumber',
  volumenumber: 'volumeNumber',
  volumelabel: 'volumeNumber',
  numero: 'volumeNumber',
  num: 'volumeNumber',
  number: 'volumeNumber',
  // Auteurs
  auteur: 'author',
  auteurs: 'author',
  author: 'author',
  authors: 'author',
  ecrivain: 'author',
  scenariste: 'author',
  dessinateur: 'author',
  // Éditeur
  editeur: 'publisher',
  publisher: 'publisher',
  maisonedition: 'publisher',
  // Statut foyer
  statut: 'ownershipStatus',
  statutfoyer: 'ownershipStatus',
  status: 'ownershipStatus',
  ownership: 'ownershipStatus',
  ownershipstatus: 'ownershipStatus',
  etat: 'ownershipStatus',
  possession: 'ownershipStatus',
  // Intégrale
  integrale: 'isIntegral',
  integral: 'isIntegral',
  isintegral: 'isIntegral',
  coffret: 'isIntegral',
  // Tomes inclus
  tomesinclus: 'includedVolumes',
  includedvolumes: 'includedVolumes',
  volumesinclus: 'includedVolumes',
  // Lecture perso
  lecture: 'readingStatus',
  lectureperso: 'readingStatus',
  reading: 'readingStatus',
  readingstatus: 'readingStatus',
  statutlecture: 'readingStatus',
  lu: 'readingStatus',
  // Note
  note: 'rating',
  noteperso: 'rating',
  rating: 'rating',
  etoiles: 'rating',
  stars: 'rating',
  // Notes perso
  notes: 'notes',
  notesperso: 'notes',
  notespersonnelles: 'notes',
  commentaire: 'notes',
  commentaires: 'notes',
  avis: 'notes',
  review: 'notes'
};

function normalizeHeaderKey(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cleanString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    const joined = raw.map((v) => String(v ?? '').trim()).filter(Boolean).join(', ');
    return joined || null;
  }
  const str = String(raw).trim();
  return str.length > 0 ? str : null;
}

function parseOwnershipStatus(raw: unknown): OwnershipStatus | null {
  const s = cleanString(raw);
  if (!s) return null;
  const key = normalizeHeaderKey(s);
  if (key === 'wish' || key === 'wishlist' || key === 'envie' || key === 'souhait' || key === 'souhaite' || key === 'aacheter') {
    return 'wish';
  }
  if (key === 'owned' || key === 'possede' || key === 'collection' || key === 'acquis' || key === 'oui' || key === 'yes') {
    return 'owned';
  }
  if (key === 'none' || key === 'unowned' || key === 'nonpossede' || key === 'manquant') {
    return 'none';
  }
  return null;
}

function parseReadingStatus(raw: unknown): ReadingStatus | null {
  const s = cleanString(raw);
  if (!s) return null;
  const key = normalizeHeaderKey(s);
  if (key === 'read' || key === 'lu' || key === 'termine' || key === 'fini' || key === 'oui' || key === 'yes') return 'read';
  if (key === 'reading' || key === 'encours') return 'reading';
  if (key === 'toread' || key === 'alire' || key === 'pal') return 'to_read';
  if (key === 'abandoned' || key === 'abandonne') return 'abandoned';
  if (key === 'none' || key === 'nonrenseigne' || key === 'non') return 'none';
  return null;
}

function parseBooleanValue(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  const s = cleanString(raw);
  if (!s) return null;
  const key = normalizeHeaderKey(s);
  if (key === 'oui' || key === 'yes' || key === 'true' || key === '1' || key === 'vrai') return true;
  if (key === 'non' || key === 'no' || key === 'false' || key === '0' || key === 'faux') return false;
  return null;
}

function parseRatingValue(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace(',', '.').trim());
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 5) return null;
  return rounded;
}

function detectCsvDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  let inQuotes = false;
  let semis = 0;
  let commas = 0;
  let tabs = 0;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (ch === ';') semis++;
      else if (ch === ',') commas++;
      else if (ch === '\t') tabs++;
    }
  }
  if (semis >= commas && semis >= tabs && semis > 0) return ';';
  if (commas >= tabs && commas > 0) return ',';
  if (tabs > 0) return '\t';
  return ';';
}

/**
 * Parse un fichier CSV/TSV RFC-4180 (détection auto `;`, `,` ou `\t`, suppression BOM UTF-8, guillemets échappés).
 */
export function parseCsvToMatrix(rawText: string): string[][] {
  const text = rawText.replace(/^\uFEFF/, '');
  const delimiter = detectCsvDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function buildRowFromRecord(record: Partial<Record<ImportFieldKey, unknown>>, rowNumber: number): ImportedBookRow | null {
  const isbn = cleanString(record.isbn);
  const title = cleanString(record.title);
  const series = cleanString(record.series);
  const volumeNumber = cleanString(record.volumeNumber);
  const author = cleanString(record.author);
  const publisher = cleanString(record.publisher);
  const ownershipStatus = parseOwnershipStatus(record.ownershipStatus);
  const isIntegral = parseBooleanValue(record.isIntegral);
  const rawIncluded = cleanString(record.includedVolumes);
  const includedVolumes = rawIncluded ? parseIncludedVolumeNumbers(rawIncluded) : [];
  const readingStatus = parseReadingStatus(record.readingStatus);
  const rating = parseRatingValue(record.rating);
  const notes = cleanString(record.notes);

  if (!isbn && !title && !series) return null;

  return {
    rowNumber,
    isbn,
    title,
    series,
    volumeNumber,
    author,
    publisher,
    ownershipStatus,
    isIntegral,
    includedVolumes,
    readingStatus,
    rating,
    notes
  };
}

/**
 * Transforme une matrice de cellules (issue d'un CSV ou d'une feuille Excel `.xlsx`) en lignes d'import typées.
 * Gère les en-têtes FR/EN souples ainsi que les listes brutes d'ISBN sans en-tête.
 */
export function parseImportRowsFromMatrix(matrix: string[][]): ImportedBookRow[] {
  const nonEmpty = matrix.filter((r) => r.some((c) => String(c ?? '').trim().length > 0));
  if (nonEmpty.length === 0) return [];

  const firstRow = nonEmpty[0];
  const columnMap = new Map<number, ImportFieldKey>();
  firstRow.forEach((header, idx) => {
    const key = HEADER_ALIASES[normalizeHeaderKey(header)];
    if (key && !Array.from(columnMap.values()).includes(key)) {
      columnMap.set(idx, key);
    }
  });

  // Cas particulier KISS : fichier brut d'ISBN (1 par ligne, sans ligne d'en-tête)
  if (columnMap.size === 0) {
    const firstNonBlankCell = firstRow.find((c) => String(c ?? '').trim().length > 0);
    if (firstNonBlankCell && isbnUtil.normalizeToIsbn13(firstNonBlankCell)) {
      const out: ImportedBookRow[] = [];
      for (let i = 0; i < nonEmpty.length; i++) {
        const cell = nonEmpty[i].find((c) => String(c ?? '').trim().length > 0);
        const built = buildRowFromRecord({ isbn: cell }, i + 1);
        if (built) out.push(built);
      }
      return out;
    }
    return [];
  }

  const out: ImportedBookRow[] = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const cells = nonEmpty[i];
    const rec: Partial<Record<ImportFieldKey, unknown>> = {};
    for (const [colIdx, field] of columnMap.entries()) {
      rec[field] = cells[colIdx];
    }
    const built = buildRowFromRecord(rec, i + 1);
    if (built) out.push(built);
  }
  return out;
}

/**
 * Parse un export JSON (`{ books: [...] }` ou `[...]`) en lignes d'import typées.
 */
export function parseImportJson(rawText: string): ImportedBookRow[] {
  const clean = rawText.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];
  const parsed: unknown = JSON.parse(clean);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { books?: unknown[] }).books)
      ? (parsed as { books: unknown[] }).books
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown[] }).items)
        ? (parsed as { items: unknown[] }).items
        : [];

  const out: ImportedBookRow[] = [];
  list.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') return;
    const rec: Partial<Record<ImportFieldKey, unknown>> = {};
    for (const [rawKey, value] of Object.entries(entry as Record<string, unknown>)) {
      const field = HEADER_ALIASES[normalizeHeaderKey(rawKey)];
      if (field && rec[field] === undefined) {
        rec[field] = value;
      }
    }
    const built = buildRowFromRecord(rec, idx + 1);
    if (built) out.push(built);
  });
  return out;
}
