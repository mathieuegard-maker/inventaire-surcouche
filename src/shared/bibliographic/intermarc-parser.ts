// src/shared/bibliographic/intermarc-parser.ts
// Parseur unique InterMarc (BnF) + UNIMARC (SUDOC) — seule source de vérité partagée V2.

import { isbnUtil } from './isbn.util';
import {
  cleanAuthor,
  cleanPageCount,
  cleanPublishDate,
  cleanPublisher,
  cleanSeriesName,
  cleanTitle,
  normalizeSeriesNumber
} from './text-normalize.util';

export interface MarcSubfield {
  code: string;
  value: string;
}

export interface MarcField {
  tag: string;
  subfields: MarcSubfield[];
}

export interface ParsedMarcRecord {
  isbn13: string;
  title: string;
  subtitle?: string;
  /** Série issue d'une notice d'ensemble MARC (`460`/`461` ou `245$a` + `$h/$i`, `200$a` + `$h/$i`). */
  ensembleSeriesName?: string;
  ensembleVolumeNumber?: string;
  /** Vrai uniquement si le champ structuré `460$v`/`461$v` portait un vrai numéro de tome (pas vide, pas une année type 2023). */
  hasStructuredEnsembleVolume?: boolean;
  bnfEnsembleId?: string;
  /** Collection éditoriale issue de `225`/`410`/`290` (distinction structurelle anti-fausses séries). */
  collectionName?: string;
  collectionNumber?: string;
  authors: string[];
  scriptwriters: string[];
  illustrators: string[];
  publisher?: string;
  publishYear?: string;
  pageCount?: number;
  description?: string;
  language?: string;
  deweyCode?: string;
  rawSubjects: string[];
  bnfCoverUrl?: string;
  isNonBook: boolean;
  isIntegralHint: boolean;
  rawFormat?: string;
  /** Signal structurel ISO/RDA 051 / illustrateurs : distingue BD/albums illustrés vs romans purement textuels. */
  contentKind?: 'illustrated' | 'text_only';
}

const NON_BOOK_MARC_TYPE_RE =
  /\b(images?\s+anim[ée]es?|enregistrement\s+sonore|ressource\s+[ée]lectronique|document\s+[ée]lectronique|multim[ée]dia(?:\s+multisupport)?|musique\s+imprim[ée]e|musique|image\s+fixe|objet|dvd|blu-?ray|cd-?rom|vid[ée]o|audio)\b/i;

/** Codes RDA 051$a BnF désignant des supports non-livres (vidéo, audio, musique, logiciel). */
const NON_BOOK_RDA_CODES = new Set(['tdi', 'tdm', 'prm', 'spw', 'snd', 'cod', 'cop', 'tdf']);

const INTEGRAL_TITLE_RE =
  /\b(int[ée]grale|coffret|omnibus|compendium|l['’]int[ée]grale)\b|\btomes?\s*\d+\s*(?:-|–|à)\s*\d+\b/i;

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .trim();
}

export function parseMarcFields(xml: string): MarcField[] {
  const fields: MarcField[] = [];
  const dfRegex = /<(?:[\w-]+:)?datafield\s+[^>]*tag="(\d+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?datafield>/gi;
  let dfMatch: RegExpExecArray | null;
  while ((dfMatch = dfRegex.exec(xml)) !== null) {
    const tag = dfMatch[1];
    const inner = dfMatch[2];
    const subfields: MarcSubfield[] = [];
    const sfRegex = /<(?:[\w-]+:)?subfield\s+[^>]*code="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?subfield>/gi;
    let sfMatch: RegExpExecArray | null;
    while ((sfMatch = sfRegex.exec(inner)) !== null) {
      subfields.push({
        code: sfMatch[1],
        value: decodeXmlEntities(sfMatch[2])
      });
    }
    fields.push({ tag, subfields });
  }
  return fields;
}

export function getSubfield(field: MarcField, code: string): string | undefined {
  return field.subfields.find((s) => s.code === code)?.value;
}

export function extractControlField(xml: string, tag: string): string {
  const match = new RegExp(
    `<(?:[\\w-]+:)?controlfield\\s+[^>]*tag="${tag}"[^>]*>([^<]*)<\\/(?:[\\w-]+:)?controlfield>`,
    'i'
  ).exec(xml);
  return match ? match[1] : '';
}

export function extractBnfCoverId(xml: string): string | null {
  const tag950Regex = /<(?:[\w-]+:)?datafield\s+[^>]*tag="950"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?datafield>/i;
  const match950 = tag950Regex.exec(xml);
  if (!match950) return null;
  const subfieldARegex = /<(?:[\w-]+:)?subfield\s+[^>]*code="a"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?subfield>/i;
  const matchSubfieldA = subfieldARegex.exec(match950[1]);
  return matchSubfieldA ? matchSubfieldA[1].trim() : null;
}

/**
 * Parse une notice XML InterMarc (BnF) ou UNIMARC (SUDOC) en métadonnées normalisées.
 * Préserve la distinction structurelle MARC :
 * - `ensembleSeriesName` (460/461 ou 245/200 $a+$h/$i)
 * - `collectionName` (225/410/290)
 * Rejette automatiquement l'en-tête technique UNIMARC 100$a.
 */
export function parseMarcRecord(recordXml: string, fallbackIsbn13?: string): ParsedMarcRecord | null {
  const fields = parseMarcFields(recordXml);
  if (fields.length === 0) return null;

  let isbn13 = '';
  let title = '';
  let subtitle: string | undefined;
  let ensembleSeriesName: string | undefined;
  let ensembleVolumeNumber: string | undefined;
  let hasStructuredEnsembleVolume = false;
  let bnfEnsembleId: string | undefined;
  let collectionName: string | undefined;
  let collectionNumber: string | undefined;
  let publisher: string | undefined;
  let publishYear: string | undefined;
  let pageCount: number | undefined;
  let rawFormat: string | undefined;
  let description: string | undefined;
  let deweyCode: string | undefined;
  let isNonBook = false;
  let hasRdaStillImage = false;
  let hasRdaText = false;
  let hasInteriorIllustrations = false;

  const authors: string[] = [];
  const scriptwriters: string[] = [];
  const illustrators: string[] = [];
  const rawSubjects: string[] = [];

  // Langue depuis 008 (InterMarc) ou 101$a (UNIMARC)
  const cf008 = extractControlField(recordXml, '008');
  let language = cf008.length >= 38 ? cf008.slice(35, 38).trim().toLowerCase() : undefined;

  for (const f of fields) {
    const sf = (code: string) => getSubfield(f, code)?.trim() || '';

    // Type de contenu RDA BnF (`051$a`) : `txt` (texte), `sti` (image fixe / BD), `tdi`/`prm`/`spw` (vidéo/DVD/audio -> non-livre)
    if (f.tag === '051') {
      for (const sub of f.subfields) {
        if (sub.code !== 'a') continue;
        const codeVal = sub.value.trim().toLowerCase();
        if (NON_BOOK_RDA_CODES.has(codeVal)) isNonBook = true;
        else if (codeVal === 'sti') hasRdaStillImage = true;
        else if (codeVal === 'txt') hasRdaText = true;
      }
    }

    if (f.tag === '101' && !language) {
      const lang101 = sf('a').toLowerCase();
      if (lang101) language = lang101;
    }

    // ISBN / EAN : 020$a, 038$a (InterMarc) ; 010$a, 073$a (UNIMARC)
    if (!isbn13 && (f.tag === '020' || f.tag === '038' || f.tag === '010' || f.tag === '073')) {
      const candidate = isbnUtil.normalizeToIsbn13(sf('a'));
      if (candidate) isbn13 = candidate;
    }

    // Titre principal : 245 (InterMarc) ou 200 (UNIMARC)
    if (f.tag === '245' || f.tag === '200') {
      const docType = sf('d') || sf('b');
      if (docType && NON_BOOK_MARC_TYPE_RE.test(docType)) {
        isNonBook = true;
      }
      const a = cleanTitle(sf('a'));
      const e = cleanTitle(sf('e'));
      const h = normalizeSeriesNumber(sf('h') || sf('n'));
      const iPart = cleanTitle(sf('i') || sf('p'));
      const u = cleanTitle(sf('u'));

      if (iPart && a) {
        // Structure "Série + N° + Titre d'album" (ex: Animal Jack / 7 / Le plein d'aventures)
        if (!ensembleSeriesName) ensembleSeriesName = cleanSeriesName(a);
        if (h && !ensembleVolumeNumber) ensembleVolumeNumber = h;
        title = title || iPart;
      } else {
        title = title || a;
        if (h && !ensembleVolumeNumber) ensembleVolumeNumber = h;
      }
      if (e && !subtitle) subtitle = e;
      if (u && !subtitle) subtitle = u;
    }

    // Ensemble bibliographique / Série : 460 / 461 (InterMarc & UNIMARC)
    if (f.tag === '460' || f.tag === '461') {
      const t = cleanSeriesName(sf('t') || sf('a'));
      const v = normalizeSeriesNumber(sf('v'));
      const id3 = sf('3').replace(/\D/g, '');
      if (t && !ensembleSeriesName) ensembleSeriesName = t;
      if (v) {
        if (!hasStructuredEnsembleVolume) {
          ensembleVolumeNumber = v;
          hasStructuredEnsembleVolume = true;
        }
      }
      if (/^[34]\d{6,}$/.test(id3) && !bnfEnsembleId) bnfEnsembleId = id3;
    }

    // Collection éditoriale : 225 / 410 / 290 (séparée de l'ensemble 460 !)
    if (f.tag === '225' || f.tag === '410' || f.tag === '290') {
      const col = cleanSeriesName(sf('t') || sf('a'));
      const num = normalizeSeriesNumber(sf('v'));
      if (col && !collectionName) collectionName = col;
      if (num && !collectionNumber) collectionNumber = num;
    }

    // Auteurs : 100, 700, 701, 702 (cleanAuthor rejette automatiquement UNIMARC 100$a codé)
    if (f.tag === '100' || f.tag === '700' || f.tag === '701' || f.tag === '702') {
      const last = sf('a');
      const firstM = sf('m');
      const firstB = sf('b');
      const first = firstM || (!last.includes(' ') ? firstB : '');
      const cleaned = cleanAuthor([last, first].filter(Boolean).join(', '));
      if (cleaned) {
        if (!authors.includes(cleaned)) authors.push(cleaned);
        const role = sf('4').toLowerCase();
        if (role.includes('440') || role.includes('ill') || role.includes('dessin')) {
          if (!illustrators.includes(cleaned)) illustrators.push(cleaned);
        } else if (role.includes('690') || role.includes('070') || role.includes('scén')) {
          if (!scriptwriters.includes(cleaned)) scriptwriters.push(cleaned);
        }
      }
    }

    // Éditeur & Date : 260 (InterMarc), 214/210 (UNIMARC)
    if (f.tag === '260' || f.tag === '214' || f.tag === '210') {
      const pub = cleanPublisher(sf('c') || sf('b'));
      const yr = cleanPublishDate(sf('d'));
      if (pub && !publisher) publisher = pub;
      if (yr && !publishYear) publishYear = yr;
    }

    // Pagination & illustrations : 280 (InterMarc), 215 (UNIMARC)
    if (f.tag === '280' || f.tag === '215') {
      const raw280 = sf('a');
      if (raw280) {
        if (!rawFormat) rawFormat = raw280;
        const pages = cleanPageCount(raw280);
        if (pages && !pageCount) pageCount = pages;
      }
      // Sous-zone $c (norme ISBD/MARC) : "couv. ill." désigne uniquement la couverture (roman/texte),
      // tandis que "ill." intérieur ("ill. en coul.", "ill. en noir et en coul.") caractérise une BD ou un album illustré
      // (indispensable pour les notices BnF pré-2015 où 051$a ne porte que `txt` sans `sti`).
      const rawIll = sf('c');
      if (rawIll) {
        const withoutCoverOnly = rawIll.replace(/\b(?:couv(?:erture)?|jaquette|[ée]tui)\.?\s+ill\.?[^,;]*/gi, '');
        if (/(?:^|[\s,(;])ill\.(?=[\s,);]|$)|\billustrations?\b/i.test(withoutCoverOnly)) {
          hasInteriorIllustrations = true;
        }
      }
    }

    // Résumé : 830 (InterMarc) / 330 (UNIMARC)
    if ((f.tag === '830' || f.tag === '330') && !description) {
      const desc = sf('a');
      if (desc.length >= 15) description = desc;
    }

    // Dewey & Sujets RAMEAU
    if (f.tag === '676' && !deweyCode) {
      deweyCode = sf('a') || undefined;
    }
    if (f.tag === '606' || f.tag === '608' || f.tag === '610') {
      const a = sf('a');
      const x = sf('x');
      if (a) rawSubjects.push(a);
      if (x) rawSubjects.push(x);
    }
  }

  if (!isbn13 && fallbackIsbn13) {
    isbn13 = isbnUtil.normalizeToIsbn13(fallbackIsbn13) || '';
  }
  if (!title) return null;

  const coverId = extractBnfCoverId(recordXml);
  const bnfCoverUrl = coverId
    ? `https://catalogue.bnf.fr/couverture?idImage=${coverId}&couverture=1&appName=NE`
    : undefined;

  const fullTitleText = `${title} ${subtitle || ''}`.trim();
  const isMultiVolumeBoxSet = /\b(?:[2-9]|\d{2})\s*vol\.?\b/i.test(rawFormat ?? '');
  const isIntegralHint =
    (INTEGRAL_TITLE_RE.test(fullTitleText) || isMultiVolumeBoxSet) && !/\btexte\s+int[ée]gral\b/i.test(fullTitleText);

  const graphicSubjectText = [deweyCode ?? '', ...rawSubjects].join(' ');
  const hasProseDewey = Boolean(deweyCode && /^8\d\d/.test(deweyCode));
  const isExplicitGraphic =
    hasRdaStillImage ||
    (hasInteriorIllustrations && !hasProseDewey) ||
    illustrators.length > 0 ||
    Boolean(deweyCode && deweyCode.startsWith('741.5')) ||
    /\b(bandes?\s+dessin[ée]es?|comics?|mangas?|romans?\s+graphiques?)\b/i.test(graphicSubjectText);
  const contentKind: ParsedMarcRecord['contentKind'] = isExplicitGraphic
    ? 'illustrated'
    : hasRdaText
      ? 'text_only'
      : undefined;

  return {
    isbn13,
    title,
    subtitle,
    ensembleSeriesName,
    ensembleVolumeNumber,
    hasStructuredEnsembleVolume,
    bnfEnsembleId,
    collectionName,
    collectionNumber,
    authors,
    scriptwriters,
    illustrators,
    publisher,
    publishYear,
    pageCount,
    description,
    language,
    deweyCode,
    rawSubjects,
    bnfCoverUrl,
    isNonBook,
    isIntegralHint,
    rawFormat,
    contentKind
  };
}
