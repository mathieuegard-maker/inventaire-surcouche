// src/shared/bibliographic/collection-import.util.ts
// Parseur pur (zéro import Vue/Node/SQL/réseau) pour l'import de collections CSV, JSON et tableaux Excel (.xlsx),
// avec détection automatique d'en-tête, inférence par contenu et pré-proposition de bijection de colonnes.

import { isbnUtil } from './isbn.util';
import { parseIncludedVolumeNumbers } from './integral.util';
import type { ImportInputProfileCode, OwnershipStatus, ReadingStatus } from '../types/domain.types';

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
  testCategory?: string | null;
}

export type ImportFieldKey =
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
  | 'notes'
  | 'testCategory';

export type ImportMappingConfidence = 'high' | 'medium' | 'none';
export type ImportColumnMatchReason = 'header_exact' | 'header_fuzzy' | 'content_inferred' | 'unmapped';

export interface ImportColumnPreview {
  /** Clé source : index string ("0", "1"...) pour CSV/Excel, ou nom de propriété pour JSON. */
  columnKey: string;
  /** Position 1-based pour l'affichage utilisateur ("Col. 1", "Col. 2"...). */
  columnIndex: number;
  /** Libellé d'en-tête détecté (ou clé JSON ; vide si fichier sans ligne d'en-tête). */
  sourceLabel: string;
  /** Jusqu'à 3 valeurs d'exemple non vides (tronquées à 90 caractères). */
  sampleValues: string[];
  /** Champ Biblio pré-proposé par bijection (ou null = Ignorer). */
  suggestedField: ImportFieldKey | null;
  /** Confiance de la pré-proposition. */
  confidence: ImportMappingConfidence;
  /** Méthode ayant conduit à la pré-proposition. */
  matchReason: ImportColumnMatchReason;
}

export interface ImportFilePreview {
  format: 'csv' | 'json' | 'xlsx';
  hasHeaderRow: boolean;
  canToggleHeaderRow: boolean;
  totalDataRows: number;
  columns: ImportColumnPreview[];
  hasPivotField: boolean;
  availableFields: ImportFieldKey[];
}

export type ImportColumnMapping = Record<string, ImportFieldKey | null>;

/** Champs présentés à l'utilisateur dans la modale de correspondance (ordre logique). */
export const USER_MAPPABLE_IMPORT_FIELDS: readonly ImportFieldKey[] = [
  'isbn',
  'title',
  'series',
  'volumeNumber',
  'author',
  'publisher',
  'ownershipStatus',
  'isIntegral',
  'includedVolumes',
  'readingStatus',
  'rating',
  'notes'
] as const;

/** Champs qui peuvent accepter plusieurs colonnes sources fusionnées (ex. Scénariste + Dessinateur, ou plusieurs colonnes vers Notes personnelles). */
export const MULTI_COLUMN_IMPORT_FIELDS = new Set<ImportFieldKey>(['author', 'notes']);

/** Champs pivots : au moins un d'entre eux est requis pour identifier chaque livre. */
export const PIVOT_IMPORT_FIELDS = new Set<ImportFieldKey>(['isbn', 'title', 'series']);

const HEADER_ALIASES: Record<string, ImportFieldKey> = {
  // ISBN
  isbn: 'isbn',
  isbn13: 'isbn',
  isbn10: 'isbn',
  ean: 'isbn',
  ean13: 'isbn',
  gtin: 'isbn',
  gtin13: 'isbn',
  codebarre: 'isbn',
  codebarres: 'isbn',
  barcode: 'isbn',
  primaryisbn13: 'isbn',
  codeisbn: 'isbn',
  codeisbn13: 'isbn',
  codeean: 'isbn',
  codeean13: 'isbn',
  numisbn: 'isbn',
  numeroisbn: 'isbn',
  identifiantisbn: 'isbn',
  // Titre
  titre: 'title',
  title: 'title',
  nom: 'title',
  name: 'title',
  livre: 'title',
  album: 'title',
  ouvrage: 'title',
  titrelivre: 'title',
  titredulivre: 'title',
  titrealbum: 'title',
  titredelalbum: 'title',
  nomdulivre: 'title',
  nomdelalbum: 'title',
  booktitle: 'title',
  albumtitle: 'title',
  worktitle: 'title',
  originaltitle: 'title',
  titreoriginal: 'title',
  intitule: 'title',
  // Série
  serie: 'series',
  series: 'series',
  seriesname: 'series',
  serietitle: 'series',
  nomserie: 'series',
  nomdelaserie: 'series',
  titreserie: 'series',
  titredelaserie: 'series',
  saga: 'series',
  cycle: 'series',
  franchise: 'series',
  univers: 'series',
  bdserie: 'series',
  // Tome
  tome: 'volumeNumber',
  volume: 'volumeNumber',
  vol: 'volumeNumber',
  volumenumber: 'volumeNumber',
  volumelabel: 'volumeNumber',
  numero: 'volumeNumber',
  num: 'volumeNumber',
  number: 'volumeNumber',
  n: 'volumeNumber',
  no: 'volumeNumber',
  numtome: 'volumeNumber',
  numerotome: 'volumeNumber',
  numerodetome: 'volumeNumber',
  notome: 'volumeNumber',
  ntome: 'volumeNumber',
  tomenum: 'volumeNumber',
  tomenumber: 'volumeNumber',
  volnum: 'volumeNumber',
  issue: 'volumeNumber',
  issuenumber: 'volumeNumber',
  // Auteurs
  auteur: 'author',
  auteurs: 'author',
  author: 'author',
  authors: 'author',
  authorname: 'author',
  authorlf: 'author',
  additionalauthors: 'author',
  ecrivain: 'author',
  ecrivains: 'author',
  writer: 'author',
  writers: 'author',
  scenariste: 'author',
  scenaristes: 'author',
  scenario: 'author',
  dessinateur: 'author',
  dessinateurs: 'author',
  dessin: 'author',
  illustrateur: 'author',
  illustrateurs: 'author',
  mangaka: 'author',
  createur: 'author',
  createurs: 'author',
  nomauteur: 'author',
  prenomauteur: 'author',
  auteurprincipal: 'author',
  // Éditeur
  editeur: 'publisher',
  editeurs: 'publisher',
  publisher: 'publisher',
  publishers: 'publisher',
  maisonedition: 'publisher',
  maisondedition: 'publisher',
  imprint: 'publisher',
  // Statut foyer
  statut: 'ownershipStatus',
  statutfoyer: 'ownershipStatus',
  status: 'ownershipStatus',
  ownership: 'ownershipStatus',
  ownershipstatus: 'ownershipStatus',
  etat: 'ownershipStatus',
  possession: 'ownershipStatus',
  etagere: 'ownershipStatus',
  etageres: 'ownershipStatus',
  bookshelf: 'ownershipStatus',
  bookshelves: 'ownershipStatus',
  exclusiveshelf: 'ownershipStatus',
  shelf: 'ownershipStatus',
  wishlist: 'ownershipStatus',
  possede: 'ownershipStatus',
  // Intégrale
  integrale: 'isIntegral',
  integral: 'isIntegral',
  isintegral: 'isIntegral',
  estintegrale: 'isIntegral',
  coffret: 'isIntegral',
  omnibus: 'isIntegral',
  boxset: 'isIntegral',
  // Tomes inclus
  tomesinclus: 'includedVolumes',
  includedvolumes: 'includedVolumes',
  volumesinclus: 'includedVolumes',
  tomescouverts: 'includedVolumes',
  plagetomes: 'includedVolumes',
  // Lecture perso
  lecture: 'readingStatus',
  lectureperso: 'readingStatus',
  reading: 'readingStatus',
  readingstatus: 'readingStatus',
  statutlecture: 'readingStatus',
  etatlecture: 'readingStatus',
  readstatus: 'readingStatus',
  lu: 'readingStatus',
  lus: 'readingStatus',
  // Note
  note: 'rating',
  noteperso: 'rating',
  manote: 'rating',
  rating: 'rating',
  myrating: 'rating',
  etoiles: 'rating',
  stars: 'rating',
  evaluation: 'rating',
  note5: 'rating',
  notesur5: 'rating',
  // Notes perso
  notes: 'notes',
  notesperso: 'notes',
  notespersonnelles: 'notes',
  commentaire: 'notes',
  commentaires: 'notes',
  commentaireperso: 'notes',
  commentairepersonnel: 'notes',
  avis: 'notes',
  monavis: 'notes',
  review: 'notes',
  myreview: 'notes',
  remarque: 'notes',
  remarques: 'notes',
  critique: 'notes',
  privatenotes: 'notes',
  memo: 'notes',
  // Catégorie / Profil de test (fichiers CSV benchmark IA)
  categorie: 'testCategory',
  categorietest: 'testCategory',
  castest: 'testCategory',
  category: 'testCategory',
  groupe: 'testCategory',
  typetest: 'testCategory',
  profil: 'testCategory',
  typeentree: 'testCategory',
  attendu: 'testCategory',
  scenario_test: 'testCategory'
};

/** En-têtes intrinsèquement ambigus (à confirmer visuellement par l'utilisateur). */
const AMBIGUOUS_HEADER_KEYS = new Set<string>([
  'nom',
  'name',
  'numero',
  'num',
  'number',
  'n',
  'no',
  'note',
  'etat',
  'statut',
  'status',
  'etagere',
  'shelf'
]);

/** En-têtes connus de fichiers livres/tableurs qu'on ignore volontairement mais qui confirment une ligne d'en-tête. */
const KNOWN_NON_IMPORT_HEADER_KEYS = new Set<string>([
  'id',
  'bookid',
  'identifiant',
  'date',
  'dateajout',
  'dateachat',
  'dateadded',
  'dateread',
  'datelecture',
  'datepublication',
  'dateparution',
  'parution',
  'publication',
  'annee',
  'year',
  'yearpublished',
  'originalpublicationyear',
  'pages',
  'nbpages',
  'nombredepages',
  'numberofpages',
  'pagination',
  'prix',
  'price',
  'devise',
  'currency',
  'langue',
  'language',
  'format',
  'binding',
  'reliure',
  'genre',
  'genres',
  'tags',
  'etiquettes',
  'collection',
  'resume',
  'synopsis',
  'description',
  'couverture',
  'cover',
  'coverurl',
  'image',
  'url',
  'lien',
  'link',
  'source',
  'pret',
  'prete',
  'emprunteur',
  'edition',
  'average',
  'averagerating',
  'notemoyenne',
  'readcount',
  'ownedcopies',
  'soustitre',
  'subtitle',
  'traducteur',
  'translator',
  'coloriste',
  'lieu',
  'emplacement',
  'etagerephysique'
]);

function normalizeHeaderKey(raw: string): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function tokenizeHeaderLabel(raw: string): string[] {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function cleanString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    const joined = raw
      .map((v) => cleanString(v))
      .filter((v): v is string => Boolean(v))
      .join(', ');
    return joined || null;
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const candidateKey of ['name', 'nom', 'label', 'title', 'titre', 'value']) {
      const candidate = cleanString(obj[candidateKey]);
      if (candidate) return candidate;
    }
    return null;
  }
  const str = String(raw).trim();
  return str.length > 0 ? str : null;
}

function truncateSample(raw: string, maxLen = 90): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1)}…`;
}

function parseOwnershipStatus(raw: unknown): OwnershipStatus | null {
  const s = cleanString(raw);
  if (!s) return null;
  const key = normalizeHeaderKey(s);
  if (
    key === 'wish' ||
    key === 'wishlist' ||
    key === 'envie' ||
    key === 'souhait' ||
    key === 'souhaite' ||
    key === 'aacheter' ||
    key === 'tobuy'
  ) {
    return 'wish';
  }
  if (
    key === 'owned' ||
    key === 'possede' ||
    key === 'collection' ||
    key === 'acquis' ||
    key === 'bibliotheque' ||
    key === 'oui' ||
    key === 'yes'
  ) {
    return 'owned';
  }
  if (key === 'none' || key === 'unowned' || key === 'nonpossede' || key === 'manquant') {
    return 'none';
  }
  return null;
}

function isDistinctiveOwnershipValue(raw: string): boolean {
  const key = normalizeHeaderKey(raw);
  return (
    key === 'wish' ||
    key === 'wishlist' ||
    key === 'envie' ||
    key === 'souhait' ||
    key === 'souhaite' ||
    key === 'aacheter' ||
    key === 'owned' ||
    key === 'possede' ||
    key === 'collection' ||
    key === 'acquis' ||
    key === 'nonpossede' ||
    key === 'manquant'
  );
}

function parseReadingStatus(raw: unknown): ReadingStatus | null {
  const s = cleanString(raw);
  if (!s) return null;
  const key = normalizeHeaderKey(s);
  if (key === 'read' || key === 'lu' || key === 'termine' || key === 'fini' || key === 'oui' || key === 'yes') return 'read';
  if (key === 'reading' || key === 'encours' || key === 'currentlyreading') return 'reading';
  if (key === 'toread' || key === 'alire' || key === 'pal') return 'to_read';
  if (key === 'abandoned' || key === 'abandonne' || key === 'dnf') return 'abandoned';
  if (key === 'none' || key === 'nonrenseigne' || key === 'non' || key === 'nonlu') return 'none';
  return null;
}

function isDistinctiveReadingValue(raw: string): boolean {
  const key = normalizeHeaderKey(raw);
  return (
    key === 'read' ||
    key === 'lu' ||
    key === 'termine' ||
    key === 'fini' ||
    key === 'reading' ||
    key === 'encours' ||
    key === 'currentlyreading' ||
    key === 'toread' ||
    key === 'alire' ||
    key === 'pal' ||
    key === 'abandoned' ||
    key === 'abandonne' ||
    key === 'nonlu'
  );
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
  const str = String(raw).trim();
  const slashMatch = str.match(/^(\d+(?:[.,]\d+)?)\s*\/\s*5$/);
  const numericStr = slashMatch ? slashMatch[1] : str;
  const n = Number(numericStr.replace(',', '.'));
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

function matchHeaderToField(
  rawHeader: string
): { field: ImportFieldKey; confidence: ImportMappingConfidence; reason: 'header_exact' | 'header_fuzzy' } | null {
  const normKey = normalizeHeaderKey(rawHeader);
  if (!normKey) return null;

  // 1. Correspondance exacte dans le dictionnaire normalisé
  const exact = HEADER_ALIASES[normKey];
  if (exact) {
    return {
      field: exact,
      confidence: AMBIGUOUS_HEADER_KEYS.has(normKey) ? 'medium' : 'high',
      reason: 'header_exact'
    };
  }

  // Rejeter explicitement les colonnes non importées fréquentes (dates, prix, pages, URL, note moyenne...)
  if (KNOWN_NON_IMPORT_HEADER_KEYS.has(normKey)) {
    return null;
  }

  // 2. Correspondance souple par jetons normalisés pour les en-têtes composites
  const tokens = tokenizeHeaderLabel(rawHeader);
  if (tokens.length === 0) return null;
  const has = (...words: string[]) => words.some((w) => tokens.includes(w));
  const hasPrefix = (...prefixes: string[]) => prefixes.some((p) => tokens.some((t) => t.startsWith(p)));

  // Exclusions explicites sur composites (ex. "Date de lecture", "Nombre de pages", "Note moyenne", "Prix achat", "Sous-titre")
  if (
    has('date', 'annee', 'year', 'prix', 'price', 'page', 'pages', 'url', 'lien', 'link', 'cover', 'couverture', 'image', 'langue', 'language', 'format', 'moyenne', 'average', 'traducteur', 'translator') ||
    normKey.includes('soustitre') ||
    normKey.includes('subtitle')
  ) {
    return null;
  }

  if (has('isbn', 'isbn13', 'isbn10', 'ean', 'ean13', 'gtin', 'barcode') || (has('code') && has('barre', 'barres'))) {
    return { field: 'isbn', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (has('tomes', 'volumes') && has('inclus', 'included', 'couverts', 'plage')) {
    return { field: 'includedVolumes', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (has('integrale', 'integral', 'coffret', 'omnibus', 'boxset')) {
    return { field: 'isIntegral', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (has('serie', 'series', 'saga', 'cycle', 'franchise')) {
    return { field: 'series', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (
    has('auteur', 'auteurs', 'author', 'authors', 'ecrivain', 'writer', 'scenariste', 'scenario', 'dessinateur', 'dessin', 'illustrateur', 'mangaka')
  ) {
    return { field: 'author', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (has('editeur', 'editeurs', 'publisher', 'publishers', 'imprint') || (has('maison') && hasPrefix('edit'))) {
    return { field: 'publisher', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (has('tome', 'volume', 'vol', 'issue') || (has('n', 'no', 'num', 'numero', 'number') && !has('id', 'ref', 'reference', 'ordre', 'ligne'))) {
    return {
      field: 'volumeNumber',
      confidence: has('tome', 'volume', 'vol', 'issue') ? 'high' : 'medium',
      reason: 'header_fuzzy'
    };
  }
  if (has('lecture', 'reading', 'lu', 'lus')) {
    return { field: 'readingStatus', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (has('commentaire', 'commentaires', 'avis', 'review', 'remarque', 'remarques', 'critique', 'memo')) {
    return { field: 'notes', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (has('notes') && has('perso', 'personnelle', 'personnelles', 'prive', 'privee', 'private')) {
    return { field: 'notes', confidence: 'high', reason: 'header_fuzzy' };
  }
  if (has('note', 'rating', 'etoile', 'etoiles', 'stars', 'evaluation')) {
    return { field: 'rating', confidence: 'medium', reason: 'header_fuzzy' };
  }
  if (has('statut', 'status', 'possession', 'ownership', 'wishlist', 'etagere', 'shelf', 'bookshelf', 'bookshelves')) {
    return { field: 'ownershipStatus', confidence: 'medium', reason: 'header_fuzzy' };
  }
  if (has('titre', 'title', 'album', 'livre', 'ouvrage', 'intitule')) {
    return { field: 'title', confidence: 'high', reason: 'header_fuzzy' };
  }

  return null;
}

function looksLikeHeaderToken(raw: string): boolean {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return false;
  if (isbnUtil.normalizeToIsbn13(trimmed)) return false;
  const norm = normalizeHeaderKey(trimmed);
  if (!norm) return false;
  if (KNOWN_NON_IMPORT_HEADER_KEYS.has(norm)) return true;
  if (matchHeaderToField(trimmed) !== null) return true;
  return false;
}

/**
 * Détermine automatiquement si la 1re ligne d'une matrice CSV/Excel est une ligne d'en-têtes.
 */
export function detectHasHeaderRow(matrix: string[][]): boolean {
  const nonEmpty = matrix.filter((r) => r.some((c) => String(c ?? '').trim().length > 0));
  if (nonEmpty.length === 0) return false;

  const firstRow = nonEmpty[0];
  const nonBlankFirst = firstRow.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (nonBlankFirst.length === 0) return false;

  // Une ligne d'en-tête ne contient jamais un ISBN-10/13 réel
  if (nonBlankFirst.some((cell) => Boolean(isbnUtil.normalizeToIsbn13(cell)))) {
    return false;
  }

  // Si la majorité des cellules de la ligne 1 sont des nombres purs, ce sont des données
  const pureNumberCount = nonBlankFirst.filter((c) => /^\d+(?:[.,]\d+)?$/.test(c)).length;
  if (pureNumberCount > 0 && pureNumberCount >= Math.ceil(nonBlankFirst.length / 2)) {
    return false;
  }

  let matchedHeaders = 0;
  for (const cell of nonBlankFirst) {
    if (looksLikeHeaderToken(cell)) {
      matchedHeaders++;
    }
  }

  if (matchedHeaders >= 2) return true;
  if (matchedHeaders === 1) {
    // Si 1 seul mot-clé d'en-tête sur 1 colonne unique (ex. "ISBN\n9782..."), c'est bien un en-tête ;
    // si plusieurs colonnes, vérifier qu'il y a bien des lignes dessous et que le texte est court (< 35 car.)
    if (nonBlankFirst.length === 1) {
      return nonBlankFirst[0].length <= 35;
    }
    return nonEmpty.length >= 2 && nonBlankFirst.every((c) => c.length <= 45);
  }

  return false;
}

function inferFieldFromColumnSamples(
  samples: string[]
): { field: ImportFieldKey; confidence: ImportMappingConfidence } | null {
  const cleaned = samples.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;

  const total = cleaned.length;

  // 1. ISBN-10 / ISBN-13 valides
  const isbnHits = cleaned.filter((v) => Boolean(isbnUtil.normalizeToIsbn13(v))).length;
  if (isbnHits / total >= 0.6) {
    return { field: 'isbn', confidence: 'high' };
  }

  // 2. Statut foyer distinctif (Possédé / Wishlist / Collection...)
  const ownHits = cleaned.filter((v) => isDistinctiveOwnershipValue(v)).length;
  if (ownHits / total >= 0.6) {
    return { field: 'ownershipStatus', confidence: 'high' };
  }

  // 3. Statut de lecture distinctif (Lu / En cours / À lire...)
  const readHits = cleaned.filter((v) => isDistinctiveReadingValue(v)).length;
  if (readHits / total >= 0.6) {
    return { field: 'readingStatus', confidence: 'high' };
  }

  // 4. Note /5 explicite (ex. "4/5" ou notes décimales/entières 0..5 qui ne sont pas uniquement 1..N croissants)
  const explicitSlashRatings = cleaned.filter((v) => /^\d(?:[.,]\d+)?\s*\/\s*5$/.test(v)).length;
  if (explicitSlashRatings / total >= 0.6) {
    return { field: 'rating', confidence: 'high' };
  }

  // 5. Numéro de tome (ex. "1", "12", "T.3", "Vol 2" — hors années 1900..2099 et montants €/$)
  const volRegex = /^(?:(?:t(?:ome)?|vol(?:ume)?|n°?|#)\.?\s*)?(\d{1,3}(?:\.\d+)?)$/i;
  const volHits = cleaned.filter((v) => {
    const m = v.match(volRegex);
    if (!m) return false;
    const num = Number(m[1]);
    return Number.isFinite(num) && num >= 0 && num <= 250;
  }).length;
  if (volHits / total >= 0.7) {
    return { field: 'volumeNumber', confidence: 'medium' };
  }

  // 6. Notes personnelles longues (commentaires libres > 65 caractères en moyenne)
  const avgLen = cleaned.reduce((acc, v) => acc + v.length, 0) / total;
  const longCount = cleaned.filter((v) => v.length >= 60).length;
  if (avgLen >= 65 && longCount / total >= 0.5) {
    return { field: 'notes', confidence: 'medium' };
  }

  return null;
}

function refineHeaderMatchWithSamples(
  headerMatch: { field: ImportFieldKey; confidence: ImportMappingConfidence; reason: 'header_exact' | 'header_fuzzy' },
  samples: string[]
): { field: ImportFieldKey; confidence: ImportMappingConfidence; reason: 'header_exact' | 'header_fuzzy' } {
  const cleaned = samples.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return headerMatch;

  // "Note" avec du texte libre non numérique -> bascule vers "notes" (commentaires)
  if (headerMatch.field === 'rating') {
    const validRatings = cleaned.filter((v) => parseRatingValue(v) !== null).length;
    const textLike = cleaned.filter((v) => v.length >= 12 && /[a-zA-ZÀ-ÿ]{3,}/.test(v)).length;
    if (validRatings === 0 && textLike / cleaned.length >= 0.5) {
      return { field: 'notes', confidence: 'medium', reason: headerMatch.reason };
    }
  }

  // "Statut" / "État" rempli avec Lu / En cours / À lire -> bascule vers "readingStatus"
  if (headerMatch.field === 'ownershipStatus') {
    const readHits = cleaned.filter((v) => isDistinctiveReadingValue(v)).length;
    const ownHits = cleaned.filter((v) => isDistinctiveOwnershipValue(v)).length;
    if (readHits > ownHits && readHits / cleaned.length >= 0.5) {
      return { field: 'readingStatus', confidence: 'high', reason: headerMatch.reason };
    }
  }

  // En-tête ambigu ("N°", "Numéro") rempli d'ISBN -> bascule vers "isbn"
  if (headerMatch.field === 'volumeNumber') {
    const isbnHits = cleaned.filter((v) => Boolean(isbnUtil.normalizeToIsbn13(v))).length;
    if (isbnHits / cleaned.length >= 0.6) {
      return { field: 'isbn', confidence: 'high', reason: headerMatch.reason };
    }
  }

  return headerMatch;
}

interface ColumnCandidateInput {
  columnKey: string;
  columnIndex: number;
  sourceLabel: string;
  allSamples: string[];
}

function buildPreviewColumns(
  inputs: ColumnCandidateInput[],
  hasHeaderRow: boolean,
  includeInternalFields: boolean
): ImportColumnPreview[] {
  const proposals: Array<{
    input: ColumnCandidateInput;
    field: ImportFieldKey | null;
    confidence: ImportMappingConfidence;
    reason: ImportColumnMatchReason;
    priority: number;
  }> = [];

  for (const input of inputs) {
    let field: ImportFieldKey | null = null;
    let confidence: ImportMappingConfidence = 'none';
    let reason: ImportColumnMatchReason = 'unmapped';
    let priority = 0;

    if (hasHeaderRow && input.sourceLabel.trim()) {
      const headerMatch = matchHeaderToField(input.sourceLabel);
      if (headerMatch && (includeInternalFields || headerMatch.field !== 'testCategory')) {
        const refined = refineHeaderMatchWithSamples(headerMatch, input.allSamples);
        field = refined.field;
        confidence = refined.confidence;
        reason = refined.reason;
        priority =
          (refined.reason === 'header_exact' ? 30 : 20) +
          (refined.confidence === 'high' ? 10 : 5);
      }
    }

    // Signal 2 : inférence par contenu si l'en-tête n'a rien reconnu (ou pas d'en-tête)
    // Exception : ne jamais forcer une inférence sur un en-tête explicitement reconnu comme hors-champ (ex. "Pages", "Année", "Prix", "ID")
    const isExplicitNonImportHeader =
      hasHeaderRow && input.sourceLabel.trim().length > 0 && KNOWN_NON_IMPORT_HEADER_KEYS.has(normalizeHeaderKey(input.sourceLabel));

    if (!field && !isExplicitNonImportHeader) {
      const inferred = inferFieldFromColumnSamples(input.allSamples);
      if (inferred) {
        field = inferred.field;
        confidence = inferred.confidence;
        reason = 'content_inferred';
        priority = inferred.confidence === 'high' ? 15 : 8;
      }
    }

    proposals.push({ input, field, confidence, reason, priority });
  }

  // Résolution de bijection : chaque champ unique (hors `author`) ne peut être attribué qu'une seule fois (meilleure priorité gagnante)
  const claimed = new Set<ImportFieldKey>();
  const sortedByPriority = proposals
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => b.p.priority - a.p.priority || a.idx - b.idx);

  for (const { p } of sortedByPriority) {
    if (!p.field) continue;
    if (MULTI_COLUMN_IMPORT_FIELDS.has(p.field)) {
      claimed.add(p.field);
      continue;
    }
    if (claimed.has(p.field)) {
      // Cas particulier : "Titre" déjà pris et une autre colonne s'appelle "Nom" -> proposer "author" en confiance moyenne
      const normLbl = normalizeHeaderKey(p.input.sourceLabel);
      if (p.field === 'title' && (normLbl === 'nom' || normLbl === 'name') && !claimed.has('author')) {
        p.field = 'author';
        p.confidence = 'medium';
        p.reason = 'header_fuzzy';
        claimed.add('author');
      } else {
        p.field = null;
        p.confidence = 'none';
        p.reason = 'unmapped';
      }
    } else {
      claimed.add(p.field);
    }
  }

  // Fichier sans ligne d'en-tête : si aucune colonne pivot texte (`title`/`series`) n'a été inférée mais qu'il existe
  // des colonnes texte non assignées (hors ISBN seul), proposer la 1re colonne texte libre en `title` (et la 2e en `author`) à vérifier
  if (!hasHeaderRow && !claimed.has('title') && !claimed.has('series')) {
    const freeTextCols = proposals.filter((p) => {
      if (p.field !== null) return false;
      const samples = p.input.allSamples.filter((s) => s.trim().length > 0);
      if (samples.length === 0) return false;
      const textHits = samples.filter((s) => /[a-zA-ZÀ-ÿ]{2,}/.test(s)).length;
      return textHits / samples.length >= 0.6;
    });
    if (freeTextCols[0]) {
      freeTextCols[0].field = 'title';
      freeTextCols[0].confidence = 'medium';
      freeTextCols[0].reason = 'content_inferred';
      claimed.add('title');
    }
    if (freeTextCols[1] && !claimed.has('author')) {
      freeTextCols[1].field = 'author';
      freeTextCols[1].confidence = 'medium';
      freeTextCols[1].reason = 'content_inferred';
      claimed.add('author');
    }
  }

  return proposals.map(({ input, field, confidence, reason }) => ({
    columnKey: input.columnKey,
    columnIndex: input.columnIndex,
    sourceLabel: hasHeaderRow ? input.sourceLabel : '',
    sampleValues: input.allSamples
      .map((s) => truncateSample(s))
      .filter(Boolean)
      .slice(0, 3),
    suggestedField: field,
    confidence,
    matchReason: reason
  }));
}

function mergeAuthorValues(parts: Array<{ label: string; value: string }>): string | null {
  const valid = parts.filter((p) => p.value.trim().length > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0].value.trim();

  // Si on fusionne explicitement Prénom + Nom (ex. "Prénom auteur" + "Nom auteur"), joindre par un espace
  const labels = valid.map((p) => normalizeHeaderKey(p.label));
  const hasFirstName = labels.some((l) => l.includes('prenom') || l.includes('firstname'));
  const hasLastName = labels.some((l) => l === 'nom' || l.includes('nomauteur') || l.includes('lastname'));
  if (valid.length === 2 && hasFirstName && hasLastName) {
    return valid.map((p) => p.value.trim()).join(' ');
  }

  return valid.map((p) => p.value.trim()).join(', ');
}

function isPlainNotesHeaderLabel(label: string): boolean {
  const key = normalizeHeaderKey(label);
  if (!key) return true;
  if (key === 'note' || key === 'noteperso' || key === 'manote') return true;
  return HEADER_ALIASES[key] === 'notes';
}

function mergeNotesValues(parts: Array<{ label: string; value: string }>): string | null {
  const valid = parts.filter((p) => p.value.trim().length > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1 && isPlainNotesHeaderLabel(valid[0].label)) {
    return valid[0].value.trim();
  }
  return valid
    .map((p) => {
      const cleanLabel = p.label.trim();
      const cleanVal = p.value.trim();
      if (!cleanLabel || isPlainNotesHeaderLabel(cleanLabel)) {
        return cleanVal;
      }
      return `${cleanLabel} : ${cleanVal}`;
    })
    .join('\n');
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
  const testCategory = cleanString(record.testCategory);

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
    notes,
    testCategory
  };
}

/**
 * Classe le profil d'entrée d'une ligne importée (ISBN seul, Série + Tome, Titre + Auteur, etc.)
 * sous forme de code typé pour l'analyse de benchmark.
 */
export function describeImportInputProfile(
  row: Pick<ImportedBookRow, 'isbn' | 'title' | 'series' | 'volumeNumber' | 'author'>
): ImportInputProfileCode {
  const hasIsbn = Boolean(row.isbn && row.isbn.trim());
  const hasTitle = Boolean(row.title && row.title.trim());
  const hasSeries = Boolean(row.series && row.series.trim());
  const hasVol = Boolean(row.volumeNumber && row.volumeNumber.trim());
  const hasAuthor = Boolean(row.author && row.author.trim());

  if (hasIsbn) {
    if (!hasTitle && !hasSeries && !hasAuthor) return 'isbn_only';
    if (hasSeries && hasVol) return 'isbn_series_vol';
    if (hasTitle) return 'isbn_title';
    return 'isbn_meta';
  }
  if (hasSeries && hasVol) {
    return hasTitle ? 'series_vol_title' : 'series_vol';
  }
  if (hasSeries) {
    return hasAuthor ? 'series_author' : 'series_only';
  }
  if (hasTitle && hasVol) {
    return hasAuthor ? 'title_vol_author' : 'title_vol';
  }
  if (hasTitle && hasAuthor) return 'title_author';
  if (hasTitle) return 'title_only';
  return 'other';
}

/**
 * Inspecte une matrice CSV ou Excel (.xlsx) pour produire un aperçu complet des colonnes,
 * échantillons et pré-propositions de correspondance avant import.
 */
export function inspectMatrixForImport(
  matrix: string[][],
  options?: { format?: 'csv' | 'xlsx'; hasHeaderRow?: boolean; includeInternalFields?: boolean }
): ImportFilePreview {
  const format = options?.format ?? 'csv';
  const nonEmpty = matrix.filter((r) => r.some((c) => String(c ?? '').trim().length > 0));
  const detectedHeader = detectHasHeaderRow(nonEmpty);
  const hasHeaderRow = options?.hasHeaderRow !== undefined ? options.hasHeaderRow : detectedHeader;

  if (nonEmpty.length === 0) {
    return {
      format,
      hasHeaderRow,
      canToggleHeaderRow: true,
      totalDataRows: 0,
      columns: [],
      hasPivotField: false,
      availableFields: [...USER_MAPPABLE_IMPORT_FIELDS]
    };
  }

  const dataRows = hasHeaderRow ? nonEmpty.slice(1) : nonEmpty;
  const maxCols = nonEmpty.reduce((max, row) => Math.max(max, row.length), 0);
  const headerRow = nonEmpty[0] ?? [];

  const inputs: ColumnCandidateInput[] = [];
  for (let colIdx = 0; colIdx < maxCols; colIdx++) {
    const sourceLabel = hasHeaderRow ? String(headerRow[colIdx] ?? '').trim() : '';
    const allSamples: string[] = [];
    for (let r = 0; r < dataRows.length && allSamples.length < 15; r++) {
      const val = String(dataRows[r]?.[colIdx] ?? '').trim();
      if (val) allSamples.push(val);
    }
    // Ignorer les colonnes complètement vides (ni en-tête ni aucune valeur)
    if (!sourceLabel && allSamples.length === 0) continue;
    inputs.push({
      columnKey: String(colIdx),
      columnIndex: colIdx + 1,
      sourceLabel,
      allSamples
    });
  }

  const columns = buildPreviewColumns(inputs, hasHeaderRow, Boolean(options?.includeInternalFields));
  const hasPivotField = columns.some((c) => c.suggestedField !== null && PIVOT_IMPORT_FIELDS.has(c.suggestedField));

  return {
    format,
    hasHeaderRow,
    canToggleHeaderRow: true,
    totalDataRows: dataRows.length,
    columns,
    hasPivotField,
    availableFields: [...USER_MAPPABLE_IMPORT_FIELDS]
  };
}

function extractJsonRecordList(rawText: string): Array<Record<string, unknown>> {
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
  return list.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

/**
 * Inspecte un fichier JSON (`{ books: [...] }`, `{ items: [...] }` ou `[...]`) pour produire
 * le même aperçu standardisé des propriétés et pré-propositions de correspondance.
 */
export function inspectJsonForImport(
  rawText: string,
  options?: { includeInternalFields?: boolean }
): ImportFilePreview {
  const records = extractJsonRecordList(rawText);
  if (records.length === 0) {
    return {
      format: 'json',
      hasHeaderRow: true,
      canToggleHeaderRow: false,
      totalDataRows: 0,
      columns: [],
      hasPivotField: false,
      availableFields: [...USER_MAPPABLE_IMPORT_FIELDS]
    };
  }

  const orderedKeys: string[] = [];
  const seenKeys = new Set<string>();
  const sampleLimit = Math.min(records.length, 40);
  for (let i = 0; i < sampleLimit; i++) {
    for (const key of Object.keys(records[i])) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        orderedKeys.push(key);
      }
    }
  }

  const inputs: ColumnCandidateInput[] = orderedKeys.map((key, idx) => {
    const allSamples: string[] = [];
    for (let r = 0; r < records.length && allSamples.length < 15; r++) {
      const val = cleanString(records[r][key]);
      if (val) allSamples.push(val);
    }
    return {
      columnKey: key,
      columnIndex: idx + 1,
      sourceLabel: key,
      allSamples
    };
  });

  const columns = buildPreviewColumns(inputs, true, Boolean(options?.includeInternalFields));
  const hasPivotField = columns.some((c) => c.suggestedField !== null && PIVOT_IMPORT_FIELDS.has(c.suggestedField));

  return {
    format: 'json',
    hasHeaderRow: true,
    canToggleHeaderRow: false,
    totalDataRows: records.length,
    columns,
    hasPivotField,
    availableFields: [...USER_MAPPABLE_IMPORT_FIELDS]
  };
}

/**
 * Transforme une matrice de cellules (issue d'un CSV ou d'une feuille Excel `.xlsx`) en lignes d'import typées.
 * Accepte une correspondance explicite validée par l'utilisateur (`columnMapping`, `hasHeaderRow`) ou utilise
 * automatiquement la détection intelligente multi-signaux.
 */
export function parseImportRowsFromMatrix(
  matrix: string[][],
  options?: { hasHeaderRow?: boolean; columnMapping?: ImportColumnMapping }
): ImportedBookRow[] {
  const nonEmpty = matrix.filter((r) => r.some((c) => String(c ?? '').trim().length > 0));
  if (nonEmpty.length === 0) return [];

  const preview = inspectMatrixForImport(nonEmpty, {
    hasHeaderRow: options?.hasHeaderRow,
    includeInternalFields: true
  });
  const hasHeaderRow = preview.hasHeaderRow;
  const headerRow = hasHeaderRow ? nonEmpty[0] : [];

  const columnEntries: Array<{ colIdx: number; label: string; field: ImportFieldKey }> = [];
  if (options?.columnMapping) {
    for (const [colKey, field] of Object.entries(options.columnMapping)) {
      if (!field) continue;
      const colIdx = Number(colKey);
      if (!Number.isInteger(colIdx) || colIdx < 0) continue;
      columnEntries.push({
        colIdx,
        label: hasHeaderRow ? String(headerRow[colIdx] ?? '').trim() : '',
        field
      });
    }
  } else {
    for (const col of preview.columns) {
      if (!col.suggestedField) continue;
      const colIdx = Number(col.columnKey);
      if (!Number.isInteger(colIdx) || colIdx < 0) continue;
      columnEntries.push({
        colIdx,
        label: col.sourceLabel,
        field: col.suggestedField
      });
    }
  }

  if (columnEntries.length === 0) return [];

  const startRow = hasHeaderRow ? 1 : 0;
  const out: ImportedBookRow[] = [];
  for (let i = startRow; i < nonEmpty.length; i++) {
    const cells = nonEmpty[i];
    const rec: Partial<Record<ImportFieldKey, unknown>> = {};
    const authorParts: Array<{ label: string; value: string }> = [];
    const notesParts: Array<{ label: string; value: string }> = [];

    for (const entry of columnEntries) {
      const rawVal = cells[entry.colIdx];
      if (entry.field === 'author') {
        const cleaned = cleanString(rawVal);
        if (cleaned) authorParts.push({ label: entry.label, value: cleaned });
      } else if (entry.field === 'notes') {
        const cleaned = cleanString(rawVal);
        if (cleaned) notesParts.push({ label: entry.label, value: cleaned });
      } else if (rec[entry.field] === undefined || cleanString(rec[entry.field]) === null) {
        rec[entry.field] = rawVal;
      }
    }

    if (authorParts.length > 0) {
      rec.author = mergeAuthorValues(authorParts);
    }
    if (notesParts.length > 0) {
      rec.notes = mergeNotesValues(notesParts);
    }

    const built = buildRowFromRecord(rec, i + 1);
    if (built) out.push(built);
  }
  return out;
}

/**
 * Parse un export JSON (`{ books: [...] }`, `{ items: [...] }` ou `[...]`) en lignes d'import typées.
 * Accepte une correspondance explicite validée par l'utilisateur (`columnMapping`) ou la détection automatique.
 */
export function parseImportJson(
  rawText: string,
  options?: { columnMapping?: ImportColumnMapping }
): ImportedBookRow[] {
  const records = extractJsonRecordList(rawText);
  if (records.length === 0) return [];

  const keyEntries: Array<{ key: string; field: ImportFieldKey }> = [];
  if (options?.columnMapping) {
    for (const [key, field] of Object.entries(options.columnMapping)) {
      if (!field) continue;
      keyEntries.push({ key, field });
    }
  } else {
    const preview = inspectJsonForImport(rawText, { includeInternalFields: true });
    for (const col of preview.columns) {
      if (!col.suggestedField) continue;
      keyEntries.push({ key: col.columnKey, field: col.suggestedField });
    }
  }

  if (keyEntries.length === 0) return [];

  const out: ImportedBookRow[] = [];
  records.forEach((entry, idx) => {
    const rec: Partial<Record<ImportFieldKey, unknown>> = {};
    const authorParts: Array<{ label: string; value: string }> = [];
    const notesParts: Array<{ label: string; value: string }> = [];

    for (const { key, field } of keyEntries) {
      const rawVal = entry[key];
      if (field === 'author') {
        const cleaned = cleanString(rawVal);
        if (cleaned) authorParts.push({ label: key, value: cleaned });
      } else if (field === 'notes') {
        const cleaned = cleanString(rawVal);
        if (cleaned) notesParts.push({ label: key, value: cleaned });
      } else if (rec[field] === undefined || cleanString(rec[field]) === null) {
        rec[field] = rawVal;
      }
    }

    if (authorParts.length > 0) {
      rec.author = mergeAuthorValues(authorParts);
    }
    if (notesParts.length > 0) {
      rec.notes = mergeNotesValues(notesParts);
    }

    const built = buildRowFromRecord(rec, idx + 1);
    if (built) out.push(built);
  });
  return out;
}
