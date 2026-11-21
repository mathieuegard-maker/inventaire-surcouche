// src/core/resolvers/bnf.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';
import { isbnUtil } from '../utils/isbn.util';
import { getLevenshteinDistance } from '../utils/string.util';

const JUNK_SERIES_REGEX = /\b(intégrale|coffret|box\s*set|pack|compilation)\b|tomes?\s*\d+\s*[-–à]\s*\d+|vols?\s*\d+\s*[-–à]\s*\d+/i;

const NON_BOOK_MARC_TYPE_RE =
  /\b(images?\s+anim[ée]es?|enregistrement\s+sonore|ressource\s+[ée]lectronique|document\s+[ée]lectronique|musique\s+imprim[ée]e|musique|image\s+fixe|objet|dvd|blu-?ray|cd-?rom|vid[ée]o|audio)\b/i;

/**
 * Vérifie qu'un identifiant EAN-13 correspond bien à un livre imprimé (ISBN 978/979)
 * ou à un fascicule/presse FR (330/378/977) — exclut les codes-barres DVD/CD/Blu-ray (3607, 00289, 40351...).
 */
export function isBookOrPressEan13(rawIsbn?: string): boolean {
  const clean = (rawIsbn || '').replace(/[^0-9]/g, '');
  if (clean.length !== 13) return false;
  return /^(978|979|330|378|977)/.test(clean);
}

/**
 * Vérifie qu'un ISBN-13 / EAN-13 appartient à la zone francophone (978-2, 979-10)
 * ou à la presse FR (330, 378, 977). Écarte les éditions étrangères (978-84 ES, 978-90 NL, 978-3 DE, 978-0/1 EN, 979-8 KDP...).
 */
export function isFrancophoneBookIsbn13(rawIsbn?: string): boolean {
  const clean = (rawIsbn || '').replace(/[^0-9]/g, '');
  if (clean.length !== 13) return false;
  return /^(9782|97910|330|378|977)/.test(clean);
}

export function isNonBookMarcType(docTypeRaw?: string): boolean {
  if (!docTypeRaw) return false;
  return NON_BOOK_MARC_TYPE_RE.test(docTypeRaw);
}

export function normalizeTextKey(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’".,:;!?()\[\]-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSeriesNumber(raw?: string): string {
  if (!raw) return '';
  const cleaned = raw
    .replace(/^\[|\]$/g, '')
    .replace(/^(tome|vol\.?|volume|t\.?|n°|#)\s*/i, '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .trim();
  if (cleaned.length > 12 || /\s/.test(cleaned)) return '';
  const numeric = /^\d+$/.test(cleaned) ? String(parseInt(cleaned, 10)) : cleaned;
  return numeric;
}

/**
 * Note la qualité et la fraîcheur d'une édition (langue française, ISBN FR, couverture, année récente).
 */
export function scoreEditionCandidate(
  c: ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean }
): number {
  let score = 0;
  if (c._lang === 'fre') score += 20;
  else if (c._lang && c._lang !== 'fre') score -= 30;
  if (c.isbn.startsWith('9782') || c.isbn.startsWith('97910')) score += 15;
  if (c.coverUrl) score += 12;
  if (c._hasPrimaryIsbn) score += 6;
  if (c.authors.length > 0) score += 5;
  if (c.publisher) score += 2;
  if (c.publishDate) {
    score += 2;
    const yearNum = parseInt(c.publishDate, 10);
    if (!Number.isNaN(yearNum)) {
      const clampedYear = Math.min(Math.max(yearNum, 1900), 2035);
      score += (clampedYear - 1900) * 0.25;
    }
  }
  return score;
}

function tokenOverlapRatio(needle: string, haystack: string): number {
  const needleTokens = normalizeTextKey(needle).split(' ').filter((t) => t.length >= 2);
  const hayTokens = new Set(normalizeTextKey(haystack).split(' ').filter((t) => t.length >= 2));
  if (needleTokens.length === 0 || hayTokens.size === 0) return 0;
  let hits = 0;
  for (const tok of needleTokens) {
    if (hayTokens.has(tok)) hits++;
  }
  return hits / needleTokens.length;
}

export interface BnfHintQuery {
  title?: string;
  subtitle?: string;
  series?: string;
  volumeNumber?: string;
  author?: string;
  illustrator?: string;
  publisher?: string;
  collection?: string;
  rawSpineText?: string;
}

/**
 * Évalue la pertinence d'une notice BnF (ou d'un candidat multi-source) face aux indices extraits par l'IA.
 */
export function scoreHintMatch(
  cand: ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean },
  hints: BnfHintQuery
): number {
  let score = 0;

  const hintTitleNorm = normalizeTextKey([hints.title, hints.subtitle].filter(Boolean).join(' '));
  const hintMainTitleNorm = normalizeTextKey(hints.title || '');
  const hintSeriesNorm = normalizeTextKey(hints.series || '');
  const candTitleNorm = normalizeTextKey(cand.title || '');
  const candSeriesNorm = normalizeTextKey(cand.series || '');
  const combinedCandText = `${cand.series || ''} ${cand.title || ''}`.trim();

  // 1. Titre & série (calculé AVANT le bonus de tome pour éviter qu'un manga non lié #44 score sur le seul numéro !)
  let textMatchScore = 0;
  if (hintMainTitleNorm) {
    if (candTitleNorm === hintMainTitleNorm || candTitleNorm === hintTitleNorm) textMatchScore += 42;
    else if (candTitleNorm.includes(hintMainTitleNorm) || hintMainTitleNorm.includes(candTitleNorm)) textMatchScore += 30;
    else textMatchScore += Math.round(tokenOverlapRatio(hints.title || '', combinedCandText) * 32);
  }

  if (hintSeriesNorm) {
    if (candSeriesNorm === hintSeriesNorm) textMatchScore += 32;
    else if (candSeriesNorm.includes(hintSeriesNorm) || candTitleNorm.includes(hintSeriesNorm)) textMatchScore += 22;
    else textMatchScore += Math.round(tokenOverlapRatio(hints.series || '', combinedCandText) * 22);
  }
  score += textMatchScore;

  // 2. Auteur & dessinateur (pénalité modérée si désaccord, pour rattraper les mauvais auteurs lus par l'IA)
  let authorMatchScore = 0;
  const hintPeople = [hints.author, hints.illustrator].filter((v) => v && v.trim()).join(' ');
  if (hintPeople && cand.authors.length > 0) {
    const candAuthorsJoined = cand.authors.join(' ');
    const ratio = Math.max(
      hints.author ? tokenOverlapRatio(hints.author, candAuthorsJoined) : 0,
      hints.illustrator ? tokenOverlapRatio(hints.illustrator, candAuthorsJoined) : 0
    );
    if (ratio >= 0.5) authorMatchScore = 24;
    else if (ratio > 0) authorMatchScore = 12;
    else authorMatchScore = -8;
    score += authorMatchScore;
  }

  // 3. Recoupement avec le texte brut intégral lu sur la tranche
  let rawSpineScore = 0;
  if (hints.rawSpineText?.trim()) {
    const candAllText = `${combinedCandText} ${cand.authors.join(' ')} ${cand.publisher || ''}`;
    const rawRatio = tokenOverlapRatio(hints.rawSpineText, candAllText);
    rawSpineScore = Math.round(rawRatio * 18);
    score += rawSpineScore;
  }

  // Garde anti-hors-sujet :
  // 1) Si un titre/série était demandé mais qu'AUCUN token de titre, série ni auteur ne correspond,
  //    ne JAMAIS attribuer le bonus de numéro de tome ni le bonus d'édition (évite Chihayafuru #44 pour Boule & Bill #44).
  const hasAnyTitleOrSeriesHint = Boolean(hintMainTitleNorm || hintSeriesNorm);
  const hasSemanticAnchor = textMatchScore > 0 || authorMatchScore > 0 || rawSpineScore >= 6;
  if (hasAnyTitleOrSeriesHint && !hasSemanticAnchor) {
    return 0;
  }

  // 2) Si un titre ou une série explicite (>= 4 car.) était demandé mais ne matche PAS DU TOUT (textMatchScore === 0),
  //    l'auteur seul (ex: Goscinny commun à Astérix, Lucky Luke et Le Petit Nicolas) ne doit PAS déclencher le bonus de tome !
  const hasExplicitTitleOrSeries = hintMainTitleNorm.length >= 4 || hintSeriesNorm.length >= 4;
  if (hasExplicitTitleOrSeries && textMatchScore === 0) {
    score -= 35;
  }

  // 4. Numéro de tome (uniquement si un ancrage titre/série est confirmé, ou si aucun titre/série explicite n'était fourni)
  const hintVol = normalizeSeriesNumber(hints.volumeNumber);
  if (hintVol) {
    const candVol = normalizeSeriesNumber(cand.seriesNumber);
    if (candVol === hintVol) {
      if (!hasExplicitTitleOrSeries || textMatchScore > 0) {
        score += 42;
      }
    } else if (candVol && candVol !== hintVol) {
      score -= 55;
    } else if (!hasExplicitTitleOrSeries || textMatchScore > 0) {
      // Sur Google Books / Open Library, le numéro de tome figure souvent dans le titre
      const escapedVol = hintVol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b0*${escapedVol}\\b`, 'i').test(cand.title || '')) {
        score += 22;
      }
    }
  }

  // 5. Éditeur & collection
  const hintPublisherJoined = [hints.publisher, hints.collection].filter(Boolean).join(' ');
  if (hintPublisherJoined.trim() && cand.publisher) {
    const ratio = tokenOverlapRatio(hintPublisherJoined, cand.publisher);
    if (ratio > 0) score += 12;
  }

  // 6. Qualité et récence de l'édition ("meilleure édition, la dernière")
  score += scoreEditionCandidate(cand) * 0.45;
  return score;
}

export interface MarcSubfield {
  code: string;
  value: string;
}

export interface MarcField {
  tag: string;
  subfields: MarcSubfield[];
}

/**
 * Extrait le contenu de toutes les balises ayant le nom spécifié
 */
function extractTagContents(xml: string, tagName: string): string[] {
  const escapedTagName = tagName.replace(/:/g, '\\:');
  const regex = new RegExp(`<${escapedTagName}[^>]*>([\\s\\S]*?)<\\/${escapedTagName}>`, 'g');
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const content = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    results.push(content);
  }
  return results;
}

/**
 * Extrait uniquement le titre principal avant le premier slash '/'
 */
export function cleanTitle(rawTitle: string): string {
  if (!rawTitle) return '';
  return rawTitle.replace(/\|/g, '').split('/')[0].trim();
}

/**
 * Nettoie les auteurs (inversion Nom, Prénom, suppression des dates et rôles)
 */
export function cleanAuthor(rawAuthor: string): string {
  if (!rawAuthor) return '';
  // 1. Supprime le rôle à la fin (ex: ". Auteur du texte", ". Illustrateur")
  let cleaned = rawAuthor.replace(/\.\s*[^.]*$/, '').trim();
  // 2. Supprime les parenthèses de dates (ex: "(1972-....)" ou "(1926-1977)")
  cleaned = cleaned.replace(/\s*\([^)]*\)/g, '').trim();
  // 3. Supprime tout point ou espace résiduel à la fin
  cleaned = cleaned.replace(/[.\s]+$/, '').trim();
  // 4. Inverser Nom, Prénom si une virgule est présente
  if (cleaned.includes(',')) {
    const parts = cleaned.split(',');
    const lastName = parts[0].trim();
    const firstName = parts.slice(1).join(',').trim();
    return `${firstName} ${lastName}`.trim();
  }
  return cleaned;
}

/**
 * Supprime la ville de publication entre parenthèses
 */
export function cleanPublisher(rawPublisher: string): string {
  if (!rawPublisher) return '';
  return rawPublisher.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Extrait la première série de 4 chiffres consécutifs correspondant à l'année
 */
export function cleanPublishDate(rawDate: string): string {
  if (!rawDate) return '';
  const match = rawDate.match(/\d{4}/);
  return match ? match[0] : '';
}

/**
 * Extrait la pagination de la notice
 */
export function cleanPageCount(rawFormat: string): number | undefined {
  if (!rawFormat) return undefined;
  const match = rawFormat.match(/(\d+)\s*p\./);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Nettoie le nom de la série (retire les parenthèses de disambiguation géographique ou de date)
 */
export function cleanSeriesName(series: string): string {
  if (!series) return '';
  return series
    .replace(/\|/g, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\.+$/, '')
    .trim();
}

/**
 * Tente d'extraire le nom de la série et le numéro à partir des relations BNF
 */
export function extractSeriesInfo(relations: string[]): { series?: string; seriesNumber?: string } {
  for (const relation of relations) {
    // Cas 1: Collection principale : (Nom ; Numéro) ou Collection : (Nom ; Numéro)
    const matchParentheses = relation.match(/Collection\s*(?:principale)?\s*:\s*\(([^;)]+)(?:\s*;\s*([^)]+))?\)/i);
    if (matchParentheses) {
      return {
        series: cleanSeriesName(matchParentheses[1].trim()),
        seriesNumber: matchParentheses[2] ? matchParentheses[2].trim() : undefined
      };
    }

    // Cas 2: Collection principale : Nom ou Collection : Nom
    const matchSimple = relation.match(/Collection\s*(?:principale)?\s*:\s*([^;(\n]+)/i);
    if (matchSimple) {
      return {
        series: cleanSeriesName(matchSimple[1].trim())
      };
    }
  }
  return {};
}

/**
 * Extrait le nom de la série et le numéro à partir d'une chaîne relationnelle/description brute
 */
export function parseSeriesFromString(text: string): { series?: string; seriesNumber?: string } | null {
  if (!text) return null;
  const prefixRegex = /^(?:Titre d'ensemble|Collection(?:\s+principale)?)\s*:\s*(.*)$/i;
  const matchPrefix = text.match(prefixRegex);
  if (!matchPrefix) return null;
  
  let content = matchPrefix[1].trim();
  if (content.startsWith('(') && content.endsWith(')')) {
    content = content.substring(1, content.length - 1).trim();
  }
  
  // Parenthèses à la fin : "Thorgal (tome 24)" ou "Thorgal (24)"
  const parenthesisRegex = /\s*\((?:tome|t\.|volume|vol\.|n°|no\.?|v)?\s*(\d+|[A-Z]+)\)$/i;
  const matchParenthesis = content.match(parenthesisRegex);
  if (matchParenthesis) {
    const series = cleanSeriesName(content.replace(parenthesisRegex, ''));
    const seriesNumber = matchParenthesis[1].trim();
    return { series, seriesNumber };
  }
  
  // Designateur de volume : "Docteur Bonheur, Tome 1"
  const volumeDesignatorRegex = /(?:[;,.\s]+)?\b(tome|t\.|volume|vol\.|n°|no\.?|v)\b\s*(\d+|[A-Z]+)/i;
  const matchDesignator = content.match(volumeDesignatorRegex);
  if (matchDesignator) {
    const series = cleanSeriesName(content.substring(0, matchDesignator.index));
    const seriesNumber = matchDesignator[2].trim();
    return { series, seriesNumber };
  }
  
  // Separateur suivi d'un nombre : "Thorgal ; 24"
  const numberSeparatorRegex = /[;,]\s*(\d+|[A-Z]+)$/;
  const matchNumberSep = content.match(numberSeparatorRegex);
  if (matchNumberSep) {
    const series = cleanSeriesName(content.substring(0, matchNumberSep.index));
    const seriesNumber = matchNumberSep[1].trim();
    return { series, seriesNumber };
  }
  
  return { series: cleanSeriesName(content) };
}

/**
 * Extrait le titre propre, la série et son numéro depuis le titre principal si présent
 */
export function parseSeriesFromTitle(title: string): { title: string; series?: string; seriesNumber?: string } {
  let clean = title.trim();
  
  // Pattern 1: "Tome 1, Le nom de la série"
  const prefixTomeRegex = /^(?:Tome|T\.|Volume|Vol\.|N°|No\.?)\s*(\d+|[A-Z]+)\s*,\s*(.+)$/i;
  const matchPrefix = clean.match(prefixTomeRegex);
  if (matchPrefix) {
    const seriesNumber = matchPrefix[1].trim();
    const series = matchPrefix[2].trim();
    return {
      title: series,
      series,
      seriesNumber
    };
  }
  
  // Pattern 2: "Docteur Bonheur. Tome 1"
  const suffixTomeRegex = /^(.+?)(?:\s*[\.,\s]\s*)\b(tome|t\.|volume|vol\.|n°|no\.?|v)\b\s*(\d+|[A-Z]+)$/i;
  const matchSuffix = clean.match(suffixTomeRegex);
  if (matchSuffix) {
    const series = matchSuffix[1].trim();
    const seriesNumber = matchSuffix[3].trim();
    return {
      title: series,
      series,
      seriesNumber
    };
  }
  
  return { title: clean };
}

/**
 * Parseur d'enregistrements InterMarc XML en champs et sous-zones structurés
 */
export function parseMarcFields(xml: string): MarcField[] {
  const fields: MarcField[] = [];
  const tagRegex = /<[^:>]*:datafield[^>]*tag="(\d+)"[^>]*>([\s\S]*?)<\/[^:>]*:datafield>/g;
  let match;
  while ((match = tagRegex.exec(xml)) !== null) {
    const tag = match[1];
    const content = match[2];
    
    const subfields: MarcSubfield[] = [];
    const subfieldRegex = /<[^:>]*:subfield[^>]*code="([a-z0-9])"[^>]*>([\s\S]*?)<\/[^:>]*:subfield>/g;
    let subMatch;
    while ((subMatch = subfieldRegex.exec(content)) !== null) {
      subfields.push({
        code: subMatch[1],
        value: subMatch[2]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim()
      });
    }
    fields.push({ tag, subfields });
  }
  return fields;
}

/**
 * Extrait la valeur d'une sous-zone spécifique d'un champ MARC
 */
export function getSubfield(field: MarcField, code: string): string | undefined {
  const sf = field.subfields.find(s => s.code === code);
  return sf ? sf.value : undefined;
}

/**
 * Extrait l'identifiant d'image de couverture depuis le XML au format InterMarc
 */
export function extractBnfCoverId(xml: string): string | null {
  const tag950Regex = /<[^:>]*:datafield[^>]*tag="950"[^>]*>([\s\S]*?)<\/[^:>]*:datafield>/;
  const match950 = tag950Regex.exec(xml);
  if (!match950) return null;

  const content950 = match950[1];
  const subfieldARegex = /<[^:>]*:subfield[^>]*code="a"[^>]*>([\s\S]*?)<\/[^:>]*:subfield>/;
  const matchSubfieldA = subfieldARegex.exec(content950);
  
  return matchSubfieldA ? matchSubfieldA[1].trim() : null;
}

function extractControlField(xml: string, tag: string): string {
  const match = new RegExp(`<[^:>]*:controlfield[^>]*tag="${tag}"[^>]*>([^<]*)<\\/[^:>]*:controlfield>`).exec(xml);
  return match ? match[1] : '';
}

function isPaperbackCollectionLabel(raw?: string): boolean {
  const norm = normalizeTextKey(raw || '');
  return /^(?:(?:la )?collection )?(?:folio(?: bd| cadets| junior| sf| policier)?|livre de poche|le livre de poche|pocket(?: bd)?|j ai lu|10 18|points|babel|flammarion|gallimard|dupuis|dargaud|le lombard|glenat|delcourt|soleil|casterman|hachette|rombaldi|france loisirs|aire libre|long courrier|signe|reperages|troisieme vague|poisson pilote)$/.test(
    norm
  );
}

function isPlausibleFallbackSeriesNumber(rawVol?: string): boolean {
  const norm = normalizeSeriesNumber(rawVol);
  if (!norm) return false;
  const num = Number(norm);
  return Number.isFinite(num) ? num > 0 && num <= 150 : norm.length <= 6;
}

export function parseIntermarcRecord(
  recordXml: string,
  options?: { includeIntegrals?: boolean }
): (ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean; _bnfEnsembleId?: string; _isIntegral?: boolean }) | null {
  const fields = parseMarcFields(recordXml);
  if (fields.length === 0) return null;

  // 1. ISBN (038$a EAN-13 ou 020$a prioritaire sur 020$z)
  const f038List = fields.filter(f => f.tag === '038');
  const f020List = fields.filter(f => f.tag === '020');
  let rawIsbn = '';
  let hasPrimaryIsbn = false;
  for (const f038 of f038List) {
    const a = getSubfield(f038, 'a');
    if (a && isbnUtil.isValidFormat(a)) {
      rawIsbn = a;
      hasPrimaryIsbn = true;
      break;
    }
  }
  if (!rawIsbn) {
    for (const f020 of f020List) {
      const a = getSubfield(f020, 'a');
      if (a && isbnUtil.isValidFormat(a)) {
        rawIsbn = a;
        hasPrimaryIsbn = true;
        break;
      }
    }
  }
  if (!rawIsbn) {
    for (const f020 of f020List) {
      const z = getSubfield(f020, 'z');
      if (z && isbnUtil.isValidFormat(z)) {
        rawIsbn = z;
        break;
      }
    }
  }
  if (!rawIsbn) return null;
  const cleanIsbn = isbnUtil.normalize(rawIsbn);
  const isbn = cleanIsbn.length === 10 ? isbnUtil.toIsbn13(cleanIsbn) : cleanIsbn;
  // Rejeter les codes-barres commerciaux non-livres (DVD 3607..., CD Audio 00289..., DVD DE 40351...)
  if (!isBookOrPressEan13(isbn)) return null;

  // 2. Titre & filtre anti-non-livre (245$d = Images animées, Enregistrement sonore, DVD, etc.)
  const f245 = fields.find(f => f.tag === '245');
  const rawD245 = f245 ? getSubfield(f245, 'd') : undefined;
  if (isNonBookMarcType(rawD245)) return null;
  const rawA245 = f245 ? cleanTitle(getSubfield(f245, 'a') || '') : '';
  const rawP245 = f245 ? cleanTitle(getSubfield(f245, 'p') || '') : '';
  const rawE245 = f245 ? cleanTitle(getSubfield(f245, 'e') || '') : '';
  const rawH245 = f245 ? getSubfield(f245, 'h') : undefined;
  const partNumber245 = f245 ? getSubfield(f245, 'n') : undefined;
  const imVolumeNumber = (f245 ? getSubfield(f245, 'u') : undefined) || partNumber245 || rawH245;

  let rawImTitle = rawA245;
  let inferredSeriesFrom245: string | undefined;
  if (rawP245 && rawA245) {
    inferredSeriesFrom245 = cleanSeriesName(rawA245);
    rawImTitle = rawP245;
  } else if (rawE245 && /\b(?:l['’]?\s*int[ée]grale|int[ée]grale|coffret|omnibus)\b/i.test(rawE245) && !/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(rawA245)) {
    const ord = normalizeSeriesNumber(rawH245 || imVolumeNumber || '');
    rawImTitle = ord && /^\d+$/.test(ord) ? `${rawA245} — Intégrale ${ord}` : `${rawA245} — ${rawE245}`;
  } else if (rawE245 && /^(?:(?:tome|vol\.?|volume|épisode|n°)\s*\d+|\d{1,3})$/i.test(rawE245)) {
    rawImTitle = rawA245;
  }
  if (!rawImTitle) return null;
  const secondTitleInSameVol = f245 ? getSubfield(f245, 'b') : undefined;

  const f280 = fields.find(f => f.tag === '280');
  const paginationRaw = f280 ? getSubfield(f280, 'a') : undefined;
  const isDoubleOrIntegral =
    Boolean(paginationRaw && /\d+\s*-\s*\d+\s*p\./.test(paginationRaw)) ||
    Boolean(secondTitleInSameVol && /\b(tomes?|albums?)\b/i.test(secondTitleInSameVol)) ||
    /(?:l['’]?\s*int[ée]grale|\bint[ée]grale\b|\bcoffret\b|\bomnibus\b|\btomes?\s+\d+\s*(?:[àa]|et|&|-|\/)\s*\d+)/i.test(
      `${rawA245} ${rawE245} ${secondTitleInSameVol || ''}`
    );

  if (isDoubleOrIntegral && !options?.includeIntegrals) {
    return null; // Édition double/intégrale écartée en expansion de série standard
  }

  // 3. Série & numéro de tome (460 -> 245$p -> 290/410 uniquement si non-collection-poche et n° <= 150)
  let imSeries: string | undefined = inferredSeriesFrom245;
  let imSeriesNumber: string | undefined = partNumber245;
  let bnfEnsembleId: string | undefined;
  const f460 = fields.find(f => f.tag === '460' || f.tag === '461');
  if (f460) {
    const rawEns = getSubfield(f460, '3') || '';
    const digitsEns = rawEns.replace(/\D/g, '');
    bnfEnsembleId = digitsEns.length >= 8 ? digitsEns.slice(-8) : (digitsEns || undefined);
    imSeries = getSubfield(f460, 't') || getSubfield(f460, 'a') || imSeries;
    imSeriesNumber = getSubfield(f460, 'v') || imSeriesNumber;
  }
  if (!imSeries) {
    const f290 = fields.find(f => f.tag === '290');
    const v290 = f290 ? getSubfield(f290, 'v') : undefined;
    const cand290 = f290 ? getSubfield(f290, 'a') || getSubfield(f290, 't') : undefined;
    if (f290 && cand290 && v290 && !isPaperbackCollectionLabel(cand290) && isPlausibleFallbackSeriesNumber(v290)) {
      imSeries = cand290;
      imSeriesNumber = v290;
    }
  }
  if (!imSeries) {
    const f410 = fields.find(f => f.tag === '410');
    const v410 = f410 ? getSubfield(f410, 'v') : undefined;
    const cand410 = f410 ? getSubfield(f410, 't') || getSubfield(f410, 'a') : undefined;
    if (f410 && cand410 && v410 && !isPaperbackCollectionLabel(cand410) && isPlausibleFallbackSeriesNumber(v410)) {
      imSeries = cand410;
      imSeriesNumber = v410;
    }
  }

  const titleParse = parseSeriesFromTitle(rawImTitle);
  const title = titleParse.title || rawImTitle.trim();
  const series = cleanSeriesName(imSeries || titleParse.series || '');
  const rawSeriesNum =
    imSeriesNumber ||
    imVolumeNumber ||
    (rawE245 && /^(?:(?:tome|vol\.?|volume|épisode|n°)\s*\d+|\d{1,3})$/i.test(rawE245) ? rawE245 : undefined) ||
    titleParse.seriesNumber;
  const seriesNumber = normalizeSeriesNumber(rawSeriesNum) || undefined;

  if (!options?.includeIntegrals && (JUNK_SERIES_REGEX.test(rawImTitle) || (series && JUNK_SERIES_REGEX.test(series)))) {
    return null;
  }

  // 4. Auteurs (100, 700)
  const authorSet = new Set<string>();
  for (const f of fields) {
    if (f.tag === '100' || f.tag === '700') {
      const last = getSubfield(f, 'a');
      const first = getSubfield(f, 'm');
      const full = [first, last].filter(Boolean).join(' ').trim();
      if (full) authorSet.add(full);
    }
  }

  // 5. Éditeur, date, pagination, couverture, langue, collection, Dewey, RAMEAU
  const f260 = fields.find(f => f.tag === '260');
  const publisher = f260 ? getSubfield(f260, 'c')?.trim() : undefined;
  const rawDate = f260 ? getSubfield(f260, 'd') : undefined;
  const publishDate = rawDate ? (cleanPublishDate(rawDate) || undefined) : undefined;
  const pageCount = paginationRaw ? cleanPageCount(paginationRaw) : undefined;

  const fCol = fields.find(f => (f.tag === '290' || f.tag === '410') && !getSubfield(f, 'v'));
  const collection = fCol ? (getSubfield(fCol, 't') || getSubfield(fCol, 'a'))?.trim() : undefined;

  const f676 = fields.find(f => f.tag === '676');
  const deweyCode = f676 ? getSubfield(f676, 'a')?.trim() : undefined;

  const rawSubjects: string[] = [];
  for (const f of fields) {
    if (f.tag === '606' || f.tag === '608' || f.tag === '610') {
      const a = getSubfield(f, 'a')?.trim();
      const x = getSubfield(f, 'x')?.trim();
      if (a) rawSubjects.push(a);
      if (x) rawSubjects.push(x);
    }
  }

  const f950 = fields.find(f => f.tag === '950');
  const coverId = f950 ? getSubfield(f950, 'a') : undefined;
  const coverUrl = coverId ? `https://catalogue.bnf.fr/couverture?idImage=${coverId}&couverture=1&appName=NE` : undefined;

  const cf008 = extractControlField(recordXml, '008');
  const langCode = cf008.length >= 38 ? cf008.substring(35, 38).trim() : '';

  return {
    isbn,
    title,
    authors: Array.from(authorSet),
    publisher,
    publishDate,
    pageCount,
    coverUrl,
    series: series || undefined,
    seriesNumber,
    collection: collection || undefined,
    deweyCode: deweyCode || undefined,
    ...(rawSubjects.length ? { rawSubjects } : {}),
    _lang: langCode || undefined,
    _hasPrimaryIsbn: hasPrimaryIsbn,
    _bnfEnsembleId: bnfEnsembleId,
    ...(isDoubleOrIntegral ? { isIntegral: true, _isIntegral: true } : {})
  };
}

export const bnfResolver = {
  async resolve(isbn: string): Promise<ExternalBookMetadata | null> {
    try {
      console.log(`[BNF RESOLVER] Recherche parallèle DC + InterMarc par ISBN : ${isbn}`);
      const gatewayDcUrl = `/api/gateway?action=external-lookup&isbn=${encodeURIComponent(isbn)}&source=bnf`;
      const gatewayImUrl = `/api/gateway?action=external-lookup&isbn=${encodeURIComponent(isbn)}&source=bnf&schema=intermarc`;

      const [res, imRes] = await Promise.all([
        fetchWithTimeout(gatewayDcUrl),
        fetchWithTimeout(gatewayImUrl).catch(() => null)
      ]);

      if (!res.ok) {
        console.warn(`[BNF RESOLVER] Erreur API BNF (Status ${res.status})`);
        return null;
      }
      
      const xmlText = await res.text();
      
      // Vérification du nombre de notices trouvées
      const recordCountMatch = xmlText.match(/<srw:numberOfRecords[^>]*>(\d+)<\/srw:numberOfRecords>/);
      const count = recordCountMatch ? parseInt(recordCountMatch[1], 10) : 0;
      if (count === 0) {
        console.log(`[BNF RESOLVER] Aucun résultat pour l'ISBN ${isbn}`);
        return null;
      }

      // Extraction des métadonnées Dublin Core
      const rawTitles = extractTagContents(xmlText, 'dc:title');
      const rawCreators = extractTagContents(xmlText, 'dc:creator');
      const rawPublishers = extractTagContents(xmlText, 'dc:publisher');
      const rawDates = extractTagContents(xmlText, 'dc:date');
      const rawFormats = extractTagContents(xmlText, 'dc:format');
      const rawRelations = extractTagContents(xmlText, 'dc:relation');
      const rawDescriptions = extractTagContents(xmlText, 'dc:description');

      if (rawTitles.length === 0) {
        console.warn(`[BNF RESOLVER] Notice BNF présente mais titre introuvable.`);
        return null;
      }

      // Traitement InterMarc déjà récupéré en parallèle
      let coverUrl: string | undefined = undefined;
      let imTitle: string | undefined = undefined;
      let imSeries: string | undefined = undefined;
      let imSeriesNumber: string | undefined = undefined;
      let imVolumeNumber: string | undefined = undefined;

      try {
        if (imRes && imRes.ok) {
          const imXmlText = await imRes.text();
          const imFields = parseMarcFields(imXmlText);

          // 1. Couverture
          const f950 = imFields.find(f => f.tag === '950');
          if (f950) {
            const coverId = getSubfield(f950, 'a');
            if (coverId) {
              coverUrl = `https://catalogue.bnf.fr/couverture?idImage=${coverId}&couverture=1&appName=NE`;
              console.log(`[BNF RESOLVER] Image de couverture BNF trouvée : ${coverUrl}`);
            }
          }

          // 2. Titre & volume
          const f245 = imFields.find(f => f.tag === '245');
          if (f245) {
            const rawA = getSubfield(f245, 'a');
            imTitle = rawA ? cleanTitle(rawA) : undefined;
            imVolumeNumber = getSubfield(f245, 'u');
          }

          // 3. Série (Tag 460/461 - Notice d'ensemble)
          const f460 = imFields.find(f => f.tag === '460' || f.tag === '461');
          if (f460) {
            imSeries = getSubfield(f460, 't') || getSubfield(f460, 'a');
            imSeriesNumber = getSubfield(f460, 'v');
          }

          // 4. Série (Tag 290 - Titre d'ensemble local, uniquement si non collection éditoriale et tome <= 150)
          if (!imSeries) {
            const f290 = imFields.find(f => f.tag === '290');
            const v290 = f290 ? getSubfield(f290, 'v') : undefined;
            const s290 = f290 ? getSubfield(f290, 'a') || getSubfield(f290, 't') : undefined;
            if (f290 && s290 && v290 && !isPaperbackCollectionLabel(s290) && isPlausibleFallbackSeriesNumber(v290)) {
              imSeries = s290;
              imSeriesNumber = v290;
            }
          }

          // 5. Série (Tag 410 - Collection uniquement si numérotée <= 150 et hors collections génériques Folio/Pocket...)
          if (!imSeries) {
            const f410 = imFields.find(f => f.tag === '410');
            const v410 = f410 ? getSubfield(f410, 'v') : undefined;
            const s410 = f410 ? getSubfield(f410, 't') || getSubfield(f410, 'a') : undefined;
            if (f410 && s410 && v410 && !isPaperbackCollectionLabel(s410) && isPlausibleFallbackSeriesNumber(v410)) {
              imSeries = s410;
              imSeriesNumber = v410;
            }
          }

          if (imSeries) {
            imSeries = cleanSeriesName(imSeries);
          }
        }
      } catch (imErr: any) {
        console.warn(`[BNF RESOLVER] Échec du traitement InterMarc :`, imErr.message);
      }

      // Résolution du titre et extraction des métadonnées de série
      const dcRawTitle = cleanTitle(rawTitles[0]);
      const titleParseDC = parseSeriesFromTitle(dcRawTitle);
      const titleParseIM = imTitle ? parseSeriesFromTitle(imTitle) : null;

      let title = imTitle || dcRawTitle;
      if (titleParseIM && titleParseIM.title) {
        title = titleParseIM.title;
      } else if (titleParseDC.title) {
        title = titleParseDC.title;
      }

      // Extraction depuis Dublin Core strings (relations + descriptions)
      let dcSeries: string | undefined = undefined;
      let dcSeriesNumber: string | undefined = undefined;
      const allTexts = [...rawRelations, ...rawDescriptions];
      for (const text of allTexts) {
        const parsed = parseSeriesFromString(text);
        if (parsed && parsed.series) {
          const isEnsemble = /^Titre d'ensemble/i.test(text.trim());
          if (parsed.seriesNumber || isEnsemble) {
            dcSeries = parsed.series;
            if (parsed.seriesNumber) {
              dcSeriesNumber = parsed.seriesNumber;
            }
            break;
          }
        }
      }

      // Fusion des informations de série
      const finalSeries = imSeries || dcSeries || (titleParseIM && titleParseIM.series) || titleParseDC.series;
      const finalSeriesNumber = imSeriesNumber || dcSeriesNumber || imVolumeNumber || (titleParseIM && titleParseIM.seriesNumber) || titleParseDC.seriesNumber;

      return {
        isbn,
        title,
        authors: rawCreators.map(cleanAuthor).filter(Boolean),
        publisher: rawPublishers.length > 0 ? cleanPublisher(rawPublishers[0]) : undefined,
        publishDate: rawDates.length > 0 ? cleanPublishDate(rawDates[0]) : undefined,
        pageCount: rawFormats.length > 0 ? cleanPageCount(rawFormats[0]) : undefined,
        coverUrl,
        series: finalSeries || undefined,
        seriesNumber: finalSeriesNumber || undefined
      };
    } catch (e: any) {
      console.error(`[BNF RESOLVER] Erreur lors de la résolution de l'ISBN ${isbn}:`, e.message);
      return null;
    }
  },

  /**
   * Recherche les autres tomes d'une série sur la BNF (SRU InterMarc)
   * en combinant les notices d'ensemble (`bib.ens2bib` via `460$3`) et la recherche directe par titre de série,
   * puis dédoublonne les rééditions par numéro de tome / titre.
   */
  async searchSeriesVolumes(
    seriesName: string,
    authorName?: string,
    knownEnsembleIds: string[] = []
  ): Promise<ExternalBookMetadata[]> {
    const cleanTargetSeries = cleanSeriesName(seriesName);
    const targetSeriesKey = normalizeTextKey(cleanTargetSeries);
    if (!targetSeriesKey) return [];

    const fetchRecords = async (withAuthor?: string): Promise<string[]> => {
      const params = new URLSearchParams({
        action: 'external-lookup',
        source: 'bnf',
        schema: 'intermarc',
        series: cleanTargetSeries,
        maxRecords: '100'
      });
      if (withAuthor?.trim()) {
        params.set('author', withAuthor.trim());
      }
      const res = await fetchWithTimeout(`/api/gateway?${params.toString()}`);
      if (!res.ok) return [];
      const xml = await res.text();
      return xml.split('<srw:record>').slice(1);
    };

    const fetchByEnsembleIds = async (ids: string[]): Promise<string[]> => {
      const cleanIds = ids.map((id) => id.replace(/\D/g, '')).filter((id) => id.length >= 6);
      if (cleanIds.length === 0) return [];
      const res = await fetchWithTimeout(
        `/api/gateway?action=external-lookup&source=bnf&schema=intermarc&ensIds=${encodeURIComponent(cleanIds.slice(0, 6).join(' '))}&maxRecords=100`
      );
      if (!res.ok) return [];
      const xml = await res.text();
      const page1 = xml.split('<srw:record>').slice(1);
      if (page1.length < 95) return page1;
      const res2 = await fetchWithTimeout(
        `/api/gateway?action=external-lookup&source=bnf&schema=intermarc&ensIds=${encodeURIComponent(cleanIds.slice(0, 6).join(' '))}&maxRecords=100&startRecord=101`
      ).catch(() => null);
      if (!res2 || !res2.ok) return page1;
      const xml2 = await res2.text();
      return [...page1, ...xml2.split('<srw:record>').slice(1)];
    };

    try {
      const ensIds = new Set<string>(knownEnsembleIds.map((id) => id.replace(/\D/g, '')).filter((id) => id.length >= 6));
      let [rawRecords, ensRecords] = await Promise.all([
        fetchRecords(authorName),
        ensIds.size > 0 ? fetchByEnsembleIds(Array.from(ensIds)) : Promise.resolve([])
      ]);

      if (rawRecords.length < 2 && authorName?.trim()) {
        // Repli sans contrainte d'auteur si la série change de scénariste/dessinateur
        const fallbackRecords = await fetchRecords();
        if (fallbackRecords.length > rawRecords.length) {
          rawRecords = fallbackRecords;
        }
      }

      // Découvrir aussi les FRBNF ensembleIds trouvés dans les premières notices puis récupérer tous les tomes rattachés
      for (const recXml of rawRecords) {
        const parsed = parseIntermarcRecord(recXml);
        if (parsed?._bnfEnsembleId) {
          const candKey = parsed.series ? normalizeTextKey(parsed.series) : '';
          if (candKey && (candKey === targetSeriesKey || candKey.includes(targetSeriesKey) || targetSeriesKey.includes(candKey))) {
            ensIds.add(parsed._bnfEnsembleId);
          }
        }
      }
      if (ensRecords.length === 0 && ensIds.size > 0) {
        ensRecords = await fetchByEnsembleIds(Array.from(ensIds));
      }

      const allRawRecords = [...ensRecords, ...rawRecords];
      const candidates: Array<ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean }> = [];
      for (const recXml of allRawRecords) {
        const parsed = parseIntermarcRecord(recXml);
        if (!parsed) continue;
        // Si la notice provient directement de `ens2bib` sans `series` renseignée, on rattache au nom de série cible
        const effectiveSeries = parsed.series || (ensRecords.includes(recXml) ? cleanTargetSeries : '');
        if (!effectiveSeries) continue;

        const candSeriesKey = normalizeTextKey(effectiveSeries);
        const seriesMatch =
          candSeriesKey === targetSeriesKey ||
          candSeriesKey.includes(targetSeriesKey) ||
          targetSeriesKey.includes(candSeriesKey) ||
          (candSeriesKey.length >= 4 && getLevenshteinDistance(candSeriesKey, targetSeriesKey) <= 2);

        if (!seriesMatch) continue;
        if (parsed._lang && parsed._lang !== 'fre') continue;

        candidates.push({
          ...parsed,
          series: cleanSeriesName(effectiveSeries) || parsed.series
        });
      }

      // Regrouper les rééditions d'un même tome (par numéro de tome, sinon par titre normalisé)
      const byVolumeKey = new Map<string, Array<ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean }>>();
      for (const cand of candidates) {
        const volKey = cand.seriesNumber
          ? `num:${normalizeSeriesNumber(cand.seriesNumber)}`
          : `title:${normalizeTextKey(cand.title)}`;
        const list = byVolumeKey.get(volKey) || [];
        list.push(cand);
        byVolumeKey.set(volKey, list);
      }

      const elected: ExternalBookMetadata[] = [];
      for (const group of byVolumeKey.values()) {
        group.sort((a, b) => scoreEditionCandidate(b) - scoreEditionCandidate(a));
        const bestWithCover = group.find((g) => Boolean(g.coverUrl));
        const top = group[0];
        elected.push({
          isbn: top.isbn,
          title: top.title,
          authors: top.authors,
          publisher: top.publisher,
          publishDate: top.publishDate,
          pageCount: top.pageCount,
          coverUrl: top.coverUrl || bestWithCover?.coverUrl,
          series: top.series,
          seriesNumber: top.seriesNumber,
          collection: top.collection,
          deweyCode: top.deweyCode,
          rawSubjects: top.rawSubjects
        });
      }

      elected.sort((a, b) => {
        const numA = parseFloat(a.seriesNumber || '');
        const numB = parseFloat(b.seriesNumber || '');
        if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
        if (!Number.isNaN(numA)) return -1;
        if (!Number.isNaN(numB)) return 1;
        return a.title.localeCompare(b.title);
      });

      return elected;
    } catch (e: any) {
      console.warn(`[BNF RESOLVER] Erreur searchSeriesVolumes (${seriesName}):`, e?.message || e);
      return [];
    }
  },

  /**
   * Recherche textuelle large BnF (titre + partout + auteur) pour la barre de recherche principale.
   */
  async searchKeywordVolumes(
    query: string,
    maxRecordsPerQuery = 50
  ): Promise<Array<ExternalBookMetadata & { _bnfEnsembleId?: string }>> {
    const cleanQ = query.trim();
    if (!cleanQ) return [];

    const runSru = async (paramsObj: Record<string, string>): Promise<string[]> => {
      const params = new URLSearchParams({
        action: 'external-lookup',
        source: 'bnf',
        schema: 'intermarc',
        maxRecords: String(maxRecordsPerQuery),
        ...paramsObj
      });
      const res = await fetchWithTimeout(`/api/gateway?${params.toString()}`).catch(() => null);
      if (!res || !res.ok) return [];
      const xml = await res.text();
      return xml.split('<srw:record>').slice(1);
    };

    try {
      const [byTitle, byAnywhere, byAuthor] = await Promise.all([
        runSru({ title: cleanQ }),
        runSru({ title: cleanQ, queryMode: 'anywhere' }),
        runSru({ author: cleanQ })
      ]);

      const byIsbn = new Map<string, ExternalBookMetadata & { _bnfEnsembleId?: string; _editScore: number }>();
      for (const recXml of [...byTitle, ...byAnywhere, ...byAuthor]) {
        const parsed = parseIntermarcRecord(recXml);
        if (!parsed) continue;
        if (parsed._lang && parsed._lang !== 'fre') continue;

        const editScore = scoreEditionCandidate(parsed);
        const existing = byIsbn.get(parsed.isbn);
        if (!existing || editScore > existing._editScore) {
          byIsbn.set(parsed.isbn, {
            isbn: parsed.isbn,
            title: parsed.title,
            authors: parsed.authors,
            publisher: parsed.publisher,
            publishDate: parsed.publishDate,
            pageCount: parsed.pageCount,
            coverUrl: parsed.coverUrl,
            series: parsed.series,
            seriesNumber: parsed.seriesNumber,
            collection: parsed.collection,
            deweyCode: parsed.deweyCode,
            rawSubjects: parsed.rawSubjects,
            _bnfEnsembleId: parsed._bnfEnsembleId,
            _editScore: editScore
          });
        }
      }

      return Array.from(byIsbn.values())
        .sort((a, b) => b._editScore - a._editScore)
        .map(({ _editScore, ...meta }) => meta);
    } catch (e: any) {
      console.warn(`[BNF RESOLVER] Erreur searchKeywordVolumes (${cleanQ}):`, e?.message || e);
      return [];
    }
  },

  /**
   * Recherche plusieurs candidats BnF pertinents (avec et sans contrainte d'auteur)
   * pour alimenter le recoupement croisé multi-réseaux.
   */
  async searchCandidatesByHints(
    hints: BnfHintQuery,
    maxCandidates = 12
  ): Promise<Array<{ score: number; meta: ExternalBookMetadata }>> {
    const cleanTitleHint = hints.title?.trim() || '';
    const cleanSubtitleHint = hints.subtitle?.trim() || '';
    const cleanSeriesHint = hints.series ? cleanSeriesName(hints.series) : '';
    const cleanVolHint = normalizeSeriesNumber(hints.volumeNumber);
    const cleanAuthorHint = hints.author?.trim() || '';
    const cleanIllustratorHint = hints.illustrator?.trim() || '';
    const cleanPublisherHint = hints.publisher?.trim() || '';

    const combinedTitleTokens: string[] = [];
    const seenTokens = new Set<string>();
    for (const part of [cleanSeriesHint, cleanTitleHint, cleanSubtitleHint, cleanVolHint]) {
      for (const tok of part.split(/\s+/).filter(Boolean)) {
        const key = normalizeTextKey(tok);
        if (key && !seenTokens.has(key)) {
          seenTokens.add(key);
          combinedTitleTokens.push(tok);
        }
      }
    }
    const combinedQueryTitle = combinedTitleTokens.join(' ').trim();
    const fallbackRawTitle = hints.rawSpineText?.trim() || cleanTitleHint;
    if (!combinedQueryTitle && !fallbackRawTitle) return [];

    const runSruQuery = async (opts: {
      titleQuery: string;
      authorQuery?: string;
      publisherQuery?: string;
      queryMode?: 'title' | 'anywhere';
    }): Promise<string[]> => {
      const params = new URLSearchParams({
        action: 'external-lookup',
        source: 'bnf',
        schema: 'intermarc',
        title: opts.titleQuery,
        maxRecords: '25'
      });
      if (opts.authorQuery) params.set('author', opts.authorQuery);
      if (opts.publisherQuery) params.set('publisher', opts.publisherQuery);
      if (opts.queryMode === 'anywhere') params.set('queryMode', 'anywhere');

      const res = await fetchWithTimeout(`/api/gateway?${params.toString()}`);
      if (!res.ok) return [];
      const xml = await res.text();
      return xml.split('<srw:record>').slice(1);
    };

    const seriesAndVolQuery = [cleanSeriesHint, cleanVolHint].filter(Boolean).join(' ').trim();
    const mainAuthorOrIllus = cleanAuthorHint || cleanIllustratorHint;

    const queryPlans: Array<{
      titleQuery: string;
      authorQuery?: string;
      publisherQuery?: string;
      queryMode?: 'title' | 'anywhere';
    }> = [];

    if (combinedQueryTitle) {
      if (mainAuthorOrIllus && cleanPublisherHint) {
        queryPlans.push({
          titleQuery: combinedQueryTitle,
          authorQuery: mainAuthorOrIllus,
          publisherQuery: cleanPublisherHint
        });
      }
      if (mainAuthorOrIllus) {
        queryPlans.push({ titleQuery: combinedQueryTitle, authorQuery: mainAuthorOrIllus });
      }
      // Passe systématique SANS contrainte d'auteur (rattrape les mauvais auteurs IA)
      queryPlans.push({
        titleQuery: combinedQueryTitle,
        publisherQuery: cleanPublisherHint || undefined
      });
      if (cleanPublisherHint) {
        queryPlans.push({ titleQuery: combinedQueryTitle });
      }
    }

    if (seriesAndVolQuery && normalizeTextKey(seriesAndVolQuery) !== normalizeTextKey(combinedQueryTitle)) {
      if (mainAuthorOrIllus) {
        queryPlans.push({ titleQuery: seriesAndVolQuery, authorQuery: mainAuthorOrIllus });
      }
      queryPlans.push({ titleQuery: seriesAndVolQuery });
    }

    if (cleanTitleHint) {
      queryPlans.push({ titleQuery: cleanTitleHint, queryMode: 'anywhere' });
    }
    if (fallbackRawTitle && normalizeTextKey(fallbackRawTitle) !== normalizeTextKey(cleanTitleHint)) {
      queryPlans.push({ titleQuery: fallbackRawTitle, queryMode: 'anywhere' });
    }

    const bestByIsbn = new Map<string, { score: number; meta: ExternalBookMetadata }>();
    const seenPlanKeys = new Set<string>();
    let bestScoreSoFar = 0;
    let matchedWithAuthor = false;

    try {
      for (const plan of queryPlans) {
        const planKey = `${plan.queryMode || 'title'}|${plan.titleQuery}|${plan.authorQuery || ''}|${plan.publisherQuery || ''}`;
        if (seenPlanKeys.has(planKey)) continue;
        seenPlanKeys.add(planKey);

        const rawRecords = await runSruQuery(plan);
        for (const recXml of rawRecords) {
          const parsed = parseIntermarcRecord(recXml, { includeIntegrals: true });
          if (!parsed) continue;
          if (parsed._lang && parsed._lang !== 'fre') continue;
          if (!isFrancophoneBookIsbn13(parsed.isbn)) continue;

          const score = scoreHintMatch(parsed, hints);
          if (score < 26) continue;

          if (score > bestScoreSoFar) {
            bestScoreSoFar = score;
            if (plan.authorQuery) matchedWithAuthor = true;
          }

          const existing = bestByIsbn.get(parsed.isbn);
          if (!existing || score > existing.score) {
            bestByIsbn.set(parsed.isbn, {
              score,
              meta: {
                isbn: parsed.isbn,
                title: parsed.title,
                authors: parsed.authors,
                publisher: parsed.publisher,
                publishDate: parsed.publishDate,
                pageCount: parsed.pageCount,
                coverUrl: parsed.coverUrl,
                series: parsed.series,
                seriesNumber: parsed.seriesNumber,
                ...(parsed.isIntegral ? { isIntegral: true } : {})
              }
            });
          }
        }

        if (matchedWithAuthor && bestScoreSoFar >= 92 && bestByIsbn.size >= 2) {
          break;
        }
      }

      return Array.from(bestByIsbn.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxCandidates);
    } catch (e: any) {
      console.warn(`[BNF RESOLVER] Erreur searchCandidatesByHints (${combinedQueryTitle}):`, e?.message || e);
      return Array.from(bestByIsbn.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxCandidates);
    }
  },

  /**
   * Recherche l'édition BnF la plus pertinente et la plus récente à partir d'indices visuels.
   */
  async searchBestMatchByHints(hints: BnfHintQuery): Promise<ExternalBookMetadata | null> {
    const candidates = await this.searchCandidatesByHints(hints, 5);
    return candidates[0]?.meta || null;
  }
};
