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
  normalizeSeriesNumber,
  normalizeTextKey
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
  colorists: string[];
  publisher?: string;
  publishYear?: string;
  pageCount?: number;
  description?: string;
  language?: string;
  /** Langue originale de l'œuvre (InterMarc `041$h` ou UNIMARC `101$c`, ex. `jpn`, `kor`, `eng`). */
  originalLanguage?: string;
  deweyCode?: string;
  rawSubjects: string[];
  bnfCoverUrl?: string;
  isNonBook: boolean;
  isIntegralHint: boolean;
  /** Notes bibliographiques MARC (250/205 édition, 300/311/327 contenu/dépouillement) utiles à la détection des intégrales. */
  integralNotes?: string;
  rawFormat?: string;
  /** Signal structurel ISO/RDA 051 / illustrateurs : distingue BD/albums illustrés vs romans purement textuels. */
  contentKind?: 'illustrated' | 'text_only';
}

const NON_BOOK_MARC_TYPE_RE =
  /\b(images?\s+anim[ée]es?|enregistrement\s+sonore|ressource\s+[ée]lectronique|document\s+[ée]lectronique|multim[ée]dia(?:\s+multisupport)?|musique\s+imprim[ée]e|musique|image\s+fixe|objet|dvd|blu-?ray|cd-?rom|vid[ée]o|audio)\b/i;

/** Codes RDA 051$a BnF désignant des supports non-livres (vidéo, audio, musique, logiciel). */
const NON_BOOK_RDA_CODES = new Set(['tdi', 'tdm', 'prm', 'spw', 'snd', 'cod', 'cop', 'tdf']);

const INTEGRAL_TITLE_RE =
  /\b(l['’]int[ée]grale|coffret\s+int[ée]gral|monovolume\s+int[ée]grale?|int[ée]grale|coffret|omnibus|compendium)\b|\btomes?\s*\d{1,2}\s*(?:-|–|à)\s*\d{1,2}\b/i;

const UNABRIDGED_PROSE_MENTION_RE =
  /(?:^|[^a-zA-ZÀ-ÿ])(?:texte|version|[ée]dition|ed\.?|œuvre)\s+int[ée]grale?(?![a-zA-ZÀ-ÿ])/i;

const COMPILATION_NOTE_RE =
  /\b(?:r[ée]unit\s+(?:les\s+)?(?:tomes?|vol\.?|volumes?|albums?|livres?|[0-9]+\s+tomes?|(?:deux|trois|quatre|cinq|six|sept|huit|neuf|dix|douze)\s+(?:premiers?\s+)?(?:tomes?|albums?|volumes?))|r[ée]unit\s*:|contient\s+(?:les\s+)?(?:tomes?|vol\.?|volumes?|albums?)|int[ée]grale\s+(?:des\s+tomes?|du\s+cycle|tomes?)|coffret\s+int[ée]gral|monovolume\s+int[ée]grale?)\b/i;

const EXCLUDED_RESP_CLAUSE_RE =
  /^(?:\[?\s*)?(?:d['’]apr[èe]s|adapt(?:[ée]e?s?|ation)|trad(?:uit[es]?|uction|\.)|pr[ée]face|postface|avant-propos|lettrage|maquette|couverture|photographies?|photos?|sous\s+la\s+direction|dirig[ée]|coordonn[ée]|[ée]dit[ée]|pr[ée]sent[ée]|conception|supervision|encrage|story-?board|avec\s+la\s+(?:collaboration|participation)|en\s+collaboration|assist[ée]|d[ée]cors?)\b/i;

const RESP_ROLE_TOKEN_PATTERN =
  '(?:mises?\\s+en\\s+coule(?:ur|ru)s?|sc[ée]narios?|sc[ée]naristes?|textes?|r[ée]cits?|dialogues?|dessins?|dessinat(?:eur|rice)s?|illustrations?|illustrat(?:eur|rice)s?|coule(?:ur|ru)s?|coloristes?|colorisations?)';

const RESP_ROLE_CLAUSE_RE = new RegExp(
  `^(${RESP_ROLE_TOKEN_PATTERN}(?:\\s*(?:,|\\bet\\b|&|/|\\+)\\s*${RESP_ROLE_TOKEN_PATTERN}){0,2})\\s*(?:[:,]\\s*(?:(?:de|par)\\s+|d['’])?|(?:de|par)\\s+|d['’])(.+)$`,
  'i'
);

const RESP_TRAILING_CUT_RE =
  /\b(?:d['’]apr[èe]s|traduit[es]?|traduction|adapt[ée]e?s?|avec\s+la\s+(?:collaboration|participation)|en\s+collaboration|pr[ée]face|postface|lettrage|d[ée]cors?)\b/i;

const INVALID_RESP_PERSON_RE =
  /\b(?:quadrichromie|bichromie|noir\s+et\s+blanc|n\s*&\s*b|coule(?:ur|ru)s?|ind[ée]termin[ée]e?|anonyme|collectif|inconnue?|divers|non\s+pr[ée]cis[ée]|sans\s+mention|[ée]ditions?|librairie|album|tome|vol\.?|volume|roman|r[ée]cit|oeuvre|œuvre|bande\s+dessin[ée]e|manga|comics|illustration|dessin|sc[ée]nario|texte)\b/i;

const LEADING_NON_NAME_WORD_RE =
  /^(?:de|du|des|d['’]|le|la|les|l['’]|un|une|pour|avec|par|dans|sur|sous|chez|au|aux|en|et|ou|sans|selon|tr[èe]s|plus)\b/i;

interface ResponsibilityRoleExtraction {
  scriptwriters: string[];
  textAuthors: string[];
  illustrators: string[];
  colorists: string[];
  hasExplicitScenario: boolean;
}

function pushUniqueNormalized(target: string[], value: string): void {
  const clean = value.trim();
  const key = normalizeTextKey(clean);
  if (!key) return;
  if (!target.some((existing) => normalizeTextKey(existing) === key)) {
    target.push(clean);
  }
}

function reconcileWithKnownAuthors(rawName: string, knownAuthors: string[]): string | null {
  const normRaw = normalizeTextKey(rawName);
  if (!normRaw || knownAuthors.length === 0) return null;

  // 1. Correspondance exacte normalisée
  const exact = knownAuthors.find((a) => normalizeTextKey(a) === normRaw);
  if (exact) return exact;

  // 2. Correspondance par nom de famille + initiale / diminutif (ex. "Fred Bernard" <-> "Frédéric Bernard", "M. Cuvillier" <-> "Maurice Cuvillier")
  const rawParts = normRaw.split(' ').filter(Boolean);
  if (rawParts.length === 0) return null;
  const rawLast = rawParts[rawParts.length - 1];
  if (rawLast.length < 3) return null;

  const matches = knownAuthors.filter((known) => {
    const knownParts = normalizeTextKey(known).split(' ').filter(Boolean);
    if (knownParts.length === 0) return false;
    const knownLast = knownParts[knownParts.length - 1];
    if (knownLast !== rawLast) return false;
    if (rawParts.length === 1 || knownParts.length === 1) return true;
    const rFirst = rawParts[0];
    const kFirst = knownParts[0];
    return kFirst.startsWith(rFirst) || rFirst.startsWith(kFirst);
  });

  return matches.length === 1 ? matches[0] : null;
}

function parseResponsibilityPersonName(rawPart: string, knownAuthors: string[]): string | null {
  let cleaned = rawPart
    .replace(/\[?\s*et\s+al\.?\s*\]?/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  const reconciled = reconcileWithKnownAuthors(cleaned, knownAuthors);
  if (reconciled) return reconciled;

  cleaned = cleanAuthor(cleaned);
  if (!cleaned || cleaned.length < 2 || cleaned.length > 55) return null;
  if (/\d/.test(cleaned)) return null;
  if (LEADING_NON_NAME_WORD_RE.test(cleaned)) return null;
  if (INVALID_RESP_PERSON_RE.test(cleaned)) return null;
  if (/^(?:studio|atelier)$/i.test(cleaned)) return null;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return null;
  if (!/[a-zA-ZÀ-ÿ]{2}/.test(cleaned)) return null;

  return cleaned;
}

/**
 * Extrait les rôles explicites (scénario, dessin, couleur) depuis les mentions ISBD `245$f` / `245$g` / `200$f` / `200$g`.
 * Ne modifie jamais `authors` (réservé aux champs normalisés MARC `100/700`) afin de préserver l'intégrité des séries.
 */
function extractCreatorRolesFromResponsibility(
  mentions: string[],
  knownAuthors: string[]
): ResponsibilityRoleExtraction {
  const scriptwriters: string[] = [];
  const textAuthors: string[] = [];
  const illustrators: string[] = [];
  const colorists: string[] = [];
  let hasExplicitScenario = false;

  for (const mention of mentions) {
    const clauses = mention
      .split(/[;|]/)
      .map((c) => c.trim())
      .filter(Boolean);

    for (const rawClause of clauses) {
      if (EXCLUDED_RESP_CLAUSE_RE.test(rawClause)) continue;

      const normalizedClause = rawClause
        .replace(/\[?\s*et\s+al\.?\s*\]?/gi, '')
        .replace(/[\[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalizedClause || EXCLUDED_RESP_CLAUSE_RE.test(normalizedClause)) continue;

      const match = RESP_ROLE_CLAUSE_RE.exec(normalizedClause);
      if (!match) continue;

      const roleHeader = match[1].toLowerCase();
      let namesSegment = match[2].trim();
      const cutMatch = RESP_TRAILING_CUT_RE.exec(namesSegment);
      if (cutMatch) {
        namesSegment = namesSegment.slice(0, cutMatch.index).trim();
      }
      if (!namesSegment) continue;

      const hasScenario = /\b(?:sc[ée]narios?|sc[ée]naristes?|dialogues?)\b/i.test(roleHeader);
      const hasText = /\b(?:textes?|r[ée]cits?)\b/i.test(roleHeader);
      const hasDrawing = /\b(?:dessins?|dessinat(?:eur|rice)s?|illustrations?|illustrat(?:eur|rice)s?)\b/i.test(
        roleHeader
      );
      const hasColor = /\b(?:mises?\s+en\s+coule(?:ur|ru)s?|coule(?:ur|ru)s?|coloristes?|colorisations?)\b/i.test(
        roleHeader
      );

      if (!hasScenario && !hasText && !hasDrawing && !hasColor) continue;

      const nameParts = namesSegment
        .split(/\s+(?:et|&)\s+|,\s*/i)
        .map((p) => parseResponsibilityPersonName(p, knownAuthors))
        .filter((n): n is string => Boolean(n));

      if (nameParts.length === 0) continue;

      if (hasScenario) hasExplicitScenario = true;
      for (const name of nameParts) {
        if (hasScenario) pushUniqueNormalized(scriptwriters, name);
        else if (hasText) pushUniqueNormalized(textAuthors, name);
        if (hasDrawing) pushUniqueNormalized(illustrators, name);
        if (hasColor) pushUniqueNormalized(colorists, name);
      }
    }
  }

  return { scriptwriters, textAuthors, illustrators, colorists, hasExplicitScenario };
}

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

export function splitMarcSruRecords(xml: string): string[] {
  const records: string[] = [];
  const regex = /<srw:recordData>([\s\S]*?)<\/srw:recordData>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    records.push(match[1]);
  }
  return records;
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
  let hasColorIllustrations = false;

  const authors: string[] = [];
  const genericTextAuthors: string[] = [];
  const scriptwriters: string[] = [];
  const illustrators: string[] = [];
  const colorists: string[] = [];
  const rawSubjects: string[] = [];
  const editionStatements: string[] = [];
  const noteClauses: string[] = [];
  const responsibilityMentions: string[] = [];

  // Langue depuis 008 (InterMarc), 041$a/$h (InterMarc) ou 101$a/$c (UNIMARC)
  const cf008 = extractControlField(recordXml, '008');
  let language = cf008.length >= 38 ? cf008.slice(35, 38).trim().toLowerCase() : undefined;
  let originalLanguage: string | undefined;

  const parseIsoLangCode = (raw: string): string | undefined => {
    const clean = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (clean.length < 2) return undefined;
    return clean.length >= 3 ? clean.slice(0, 3) : clean;
  };

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

    if (f.tag === '041') {
      if (!language) {
        const lang041 = parseIsoLangCode(sf('a'));
        if (lang041) language = lang041;
      }
      if (!originalLanguage) {
        const orig041 = parseIsoLangCode(sf('h'));
        if (orig041) originalLanguage = orig041;
      }
    }

    if (f.tag === '101') {
      if (!language) {
        const lang101 = parseIsoLangCode(sf('a'));
        if (lang101) language = lang101;
      }
      if (!originalLanguage) {
        const orig101 = parseIsoLangCode(sf('c'));
        if (orig101) originalLanguage = orig101;
      }
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
      for (const sub of f.subfields) {
        if (sub.code === 'f' || sub.code === 'g') {
          const val = sub.value.trim();
          if (val) responsibilityMentions.push(val);
        }
      }
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
    // Lit TOUTES les sous-zones `$4` (un auteur complet BD peut cumuler `0070` + `0440` sur la même entrée MARC).
    if (f.tag === '100' || f.tag === '700' || f.tag === '701' || f.tag === '702') {
      const last = sf('a');
      const firstM = sf('m');
      const firstB = sf('b');
      const first = firstM || (!last.includes(' ') ? firstB : '');
      const cleaned = cleanAuthor([last, first].filter(Boolean).join(', '));
      if (cleaned) {
        if (!authors.includes(cleaned)) authors.push(cleaned);
        const roles = f.subfields
          .filter((s) => s.code === '4')
          .map((s) => s.value.trim().toLowerCase())
          .filter(Boolean);
        for (const role of roles) {
          if (role.includes('212') || role.includes('clr') || role.includes('color')) {
            pushUniqueNormalized(colorists, cleaned);
          }
          if (role.includes('440') || role.includes('ill') || role.includes('dessin')) {
            pushUniqueNormalized(illustrators, cleaned);
          }
          if (role.includes('690') || role.includes('scén') || role.includes('scen')) {
            pushUniqueNormalized(scriptwriters, cleaned);
          } else if (role.includes('070')) {
            pushUniqueNormalized(genericTextAuthors, cleaned);
          }
        }
      }
    }

    // Mention d'édition : 250 (InterMarc) / 205 (UNIMARC) — ex. "Éd. intégrale", "Coffret intégral"
    if (f.tag === '250' || f.tag === '205') {
      const edStmt = sf('a');
      if (edStmt) editionStatements.push(edStmt);
    }

    // Notes générales & dépouillement : 300, 311, 327 (ex. "Réunit les tomes 1 à 4", "Réunit : 1, ... ; 2, ...")
    if (f.tag === '300' || f.tag === '311' || f.tag === '327') {
      const noteText = f.subfields
        .filter((s) => s.code === 'a' || s.code === 'e' || s.code === 't')
        .map((s) => s.value.trim())
        .filter(Boolean)
        .join(' ');
      if (noteText) noteClauses.push(noteText);
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
          if (/\ben\s+coul(?:eur|eurs|\.)?\b/i.test(withoutCoverOnly)) {
            hasColorIllustrations = true;
          }
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

  const respRoles = extractCreatorRolesFromResponsibility(responsibilityMentions, authors);
  for (const name of respRoles.scriptwriters) pushUniqueNormalized(scriptwriters, name);
  for (const name of respRoles.illustrators) pushUniqueNormalized(illustrators, name);
  for (const name of respRoles.colorists) pushUniqueNormalized(colorists, name);

  // Si la BnF a classé un coloriste sous le code générique `0440` (illustrateur) alors que `245$g` le désigne
  // uniquement à la couleur (sans dessin/illustration), le retirer des dessinateurs pour éviter un doublon erroné.
  if (respRoles.colorists.length > 0) {
    const respColorKeys = new Set(respRoles.colorists.map((n) => normalizeTextKey(n)));
    const respIllKeys = new Set(respRoles.illustrators.map((n) => normalizeTextKey(n)));
    for (let idx = illustrators.length - 1; idx >= 0; idx--) {
      const key = normalizeTextKey(illustrators[idx]);
      if (respColorKeys.has(key) && !respIllKeys.has(key)) {
        illustrators.splice(idx, 1);
      }
    }
  }

  const graphicSubjectText = [deweyCode ?? '', ...rawSubjects].join(' ');
  const hasProseOrEssayDewey = Boolean(deweyCode && !deweyCode.startsWith('741.5') && /^[0-9]/.test(deweyCode));
  // Un roman ou essai de > 112 pages avec quelques photos/cartes ("ill." noir et blanc sans illustrateur)
  // ne doit pas être confondu avec une BD ; les BD pré-2015 portent "ill. en coul." ou un format album (<= 112 p.).
  const isStrongInteriorIllustration =
    hasInteriorIllustrations &&
    !hasProseOrEssayDewey &&
    (hasColorIllustrations || (pageCount !== undefined && pageCount <= 112));
  const isExplicitGraphic =
    hasRdaStillImage ||
    isStrongInteriorIllustration ||
    illustrators.length > 0 ||
    colorists.length > 0 ||
    respRoles.hasExplicitScenario ||
    Boolean(deweyCode && deweyCode.startsWith('741.5')) ||
    /\b(bandes?\s+dessin[ée]es?|comics?|mangas?|romans?\s+graphiques?)\b/i.test(graphicSubjectText);

  // Ne promouvoir les auteurs génériques texte (`0070` / `245 texte`) en Scénaristes que sur les œuvres graphiques/illustrées,
  // afin de ne jamais étiqueter un romancier ou essayiste comme « Scénariste ».
  if (isExplicitGraphic) {
    for (const name of respRoles.textAuthors) {
      pushUniqueNormalized(scriptwriters, name);
    }
    const respExplicitlyNamedWriters =
      respRoles.scriptwriters.length > 0 || respRoles.textAuthors.length > 0;
    const respGraphicOnlyKeys = respExplicitlyNamedWriters
      ? new Set(
          [...respRoles.illustrators, ...respRoles.colorists]
            .map((n) => normalizeTextKey(n))
            .filter(
              (k) =>
                !respRoles.scriptwriters.some((s) => normalizeTextKey(s) === k) &&
                !respRoles.textAuthors.some((s) => normalizeTextKey(s) === k)
            )
        )
      : new Set<string>();
    for (const name of genericTextAuthors) {
      const key = normalizeTextKey(name);
      if (respGraphicOnlyKeys.has(key)) continue;
      pushUniqueNormalized(scriptwriters, name);
    }
  }

  const contentKind: ParsedMarcRecord['contentKind'] = isExplicitGraphic
    ? 'illustrated'
    : hasRdaText
      ? 'text_only'
      : undefined;

  const fullTitleText = `${title} ${subtitle || ''}`.trim();
  const editionStmtText = editionStatements.join(' ').trim();
  const notesText = noteClauses.join(' ; ').trim();
  const integralNotes = [editionStmtText, notesText].filter(Boolean).join(' ; ') || undefined;

  // Secours norme ISBD (`245$f`/`200$g`/`300$a`) si 041$h / 101$c absent : "traduit(e) du japonais / coréen / anglais / chinois"
  if (!originalLanguage) {
    const isbdTranslationText = [responsibilityMentions.join(' '), notesText].join(' ');
    if (/\btrad(?:uit[es]?|uction|\.)?\s+du\s+japonais\b/i.test(isbdTranslationText)) {
      originalLanguage = 'jpn';
    } else if (/\btrad(?:uit[es]?|uction|\.)?\s+du\s+cor[ée]en\b/i.test(isbdTranslationText)) {
      originalLanguage = 'kor';
    } else if (/\btrad(?:uit[es]?|uction|\.)?\s+de\s+l['’](?:anglais|am[ée]ricain)\b/i.test(isbdTranslationText)) {
      originalLanguage = 'eng';
    } else if (/\btrad(?:uit[es]?|uction|\.)?\s+du\s+chinois\b/i.test(isbdTranslationText)) {
      originalLanguage = 'chi';
    }
  }

  // Distinguer strictement "texte intégral / version intégrale / édition intégrale" sur un roman isolé
  // d'une vraie intégrale multi-tomes (BD/Manga/Comics ou compilation explicite "Réunit les tomes...").
  const isUnabridgedProse =
    !isExplicitGraphic &&
    (UNABRIDGED_PROSE_MENTION_RE.test(fullTitleText) || UNABRIDGED_PROSE_MENTION_RE.test(editionStmtText));
  const isMultiVolumeBoxSet =
    /\b(?:[2-9]|\d{2})\s*vol\.?\b/i.test(rawFormat ?? '') &&
    (isExplicitGraphic || Boolean(ensembleSeriesName)) &&
    !isUnabridgedProse;

  const seriesOrColIntegralHint =
    (isExplicitGraphic || Boolean(ensembleSeriesName)) &&
    INTEGRAL_TITLE_RE.test(`${ensembleSeriesName ?? ''} ${collectionName ?? ''}`);

  const editionIntegralHint =
    isExplicitGraphic &&
    /\b(?:int[ée]grale?|coffret|omnibus|compendium)\b/i.test(editionStmtText) &&
    !/\btexte\s+int[ée]gral\b/i.test(editionStmtText);

  const noteOrDescCompilationHint =
    COMPILATION_NOTE_RE.test(notesText) || COMPILATION_NOTE_RE.test(description ?? '');

  const titleHasIntegralSignal =
    INTEGRAL_TITLE_RE.test(fullTitleText) && !UNABRIDGED_PROSE_MENTION_RE.test(fullTitleText);

  const isIntegralHint = Boolean(
    !isUnabridgedProse &&
      (titleHasIntegralSignal ||
        isMultiVolumeBoxSet ||
        seriesOrColIntegralHint ||
        editionIntegralHint ||
        noteOrDescCompilationHint)
  );

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
    colorists,
    publisher,
    publishYear,
    pageCount,
    description,
    language,
    originalLanguage,
    deweyCode,
    rawSubjects,
    bnfCoverUrl,
    isNonBook,
    isIntegralHint,
    integralNotes,
    rawFormat,
    contentKind
  };
}
