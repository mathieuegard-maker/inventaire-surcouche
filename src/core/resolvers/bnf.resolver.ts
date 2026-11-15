// src/core/resolvers/bnf.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';
import { isbnUtil } from '../utils/isbn.util';
import { getLevenshteinDistance } from '../utils/string.util';

const JUNK_SERIES_REGEX = /\b(intégrale|coffret|box\s*set|pack|compilation)\b|tomes?\s*\d+\s*[-–à]\s*\d+|vols?\s*\d+\s*[-–à]\s*\d+/i;

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

/**
 * Évalue la pertinence d'une notice BnF face aux indices extraits par l'IA (titre, série, tome, auteur, éditeur).
 */
export function scoreHintMatch(
  cand: ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean },
  hints: { title?: string; series?: string; volumeNumber?: string; author?: string; publisher?: string }
): number {
  let score = 0;

  const hintTitleNorm = normalizeTextKey(hints.title || '');
  const hintSeriesNorm = normalizeTextKey(hints.series || '');
  const candTitleNorm = normalizeTextKey(cand.title || '');
  const candSeriesNorm = normalizeTextKey(cand.series || '');
  const combinedCandText = `${cand.series || ''} ${cand.title || ''}`.trim();

  // 1. Numéro de tome
  const hintVol = normalizeSeriesNumber(hints.volumeNumber);
  if (hintVol) {
    const candVol = normalizeSeriesNumber(cand.seriesNumber);
    if (candVol === hintVol) {
      score += 40;
    } else if (candVol && candVol !== hintVol) {
      score -= 55;
    }
  }

  // 2. Titre & série
  if (hintTitleNorm) {
    if (candTitleNorm === hintTitleNorm) score += 40;
    else if (candTitleNorm.includes(hintTitleNorm) || hintTitleNorm.includes(candTitleNorm)) score += 28;
    else score += Math.round(tokenOverlapRatio(hints.title || '', combinedCandText) * 30);
  }

  if (hintSeriesNorm) {
    if (candSeriesNorm === hintSeriesNorm) score += 30;
    else if (candSeriesNorm.includes(hintSeriesNorm) || candTitleNorm.includes(hintSeriesNorm)) score += 20;
    else score += Math.round(tokenOverlapRatio(hints.series || '', combinedCandText) * 20);
  }

  // 3. Auteur
  if (hints.author?.trim() && cand.authors.length > 0) {
    const candAuthorsJoined = cand.authors.join(' ');
    const ratio = tokenOverlapRatio(hints.author, candAuthorsJoined);
    if (ratio >= 0.5) score += 25;
    else if (ratio > 0) score += 12;
    else score -= 12;
  }

  // 4. Éditeur
  if (hints.publisher?.trim() && cand.publisher) {
    const ratio = tokenOverlapRatio(hints.publisher, cand.publisher);
    if (ratio > 0) score += 10;
  }

  // 5. Qualité et récence de l'édition ("meilleure édition, la dernière")
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

export function parseIntermarcRecord(recordXml: string): (ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean; _bnfEnsembleId?: string }) | null {
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

  // 2. Titre & filtre anti-compilation / double-album
  const f245 = fields.find(f => f.tag === '245');
  const rawImTitle = f245 ? cleanTitle(getSubfield(f245, 'a') || '') : '';
  if (!rawImTitle) return null;
  const imVolumeNumber = f245 ? getSubfield(f245, 'u') : undefined;
  const secondTitleInSameVol = f245 ? getSubfield(f245, 'b') : undefined;

  const f280 = fields.find(f => f.tag === '280');
  const paginationRaw = f280 ? getSubfield(f280, 'a') : undefined;
  if (paginationRaw && /\d+\s*-\s*\d+\s*p\./.test(paginationRaw)) {
    return null; // Édition double type "48-48 p."
  }
  if (secondTitleInSameVol && /\b(tomes?|albums?)\b/i.test(secondTitleInSameVol)) {
    return null;
  }

  // 3. Série & numéro de tome (460 -> 290/410 uniquement si sous-zone $v présente)
  let imSeries: string | undefined;
  let imSeriesNumber: string | undefined;
  let bnfEnsembleId: string | undefined;
  const f460 = fields.find(f => f.tag === '460' || f.tag === '461');
  if (f460) {
    bnfEnsembleId = getSubfield(f460, '3');
    imSeries = getSubfield(f460, 't') || getSubfield(f460, 'a');
    imSeriesNumber = getSubfield(f460, 'v');
  }
  if (!imSeries) {
    const f290 = fields.find(f => f.tag === '290');
    const v290 = f290 ? getSubfield(f290, 'v') : undefined;
    if (f290 && v290) {
      imSeries = getSubfield(f290, 'a') || getSubfield(f290, 't');
      imSeriesNumber = v290;
    }
  }
  if (!imSeries) {
    const f410 = fields.find(f => f.tag === '410');
    const v410 = f410 ? getSubfield(f410, 'v') : undefined;
    if (f410 && v410) {
      imSeries = getSubfield(f410, 't') || getSubfield(f410, 'a');
      imSeriesNumber = v410;
    }
  }

  const titleParse = parseSeriesFromTitle(rawImTitle);
  const title = titleParse.title || rawImTitle.trim();
  const series = cleanSeriesName(imSeries || titleParse.series || '');
  const rawSeriesNum = imSeriesNumber || imVolumeNumber || titleParse.seriesNumber;
  const seriesNumber = normalizeSeriesNumber(rawSeriesNum) || undefined;

  if (JUNK_SERIES_REGEX.test(rawImTitle) || (series && JUNK_SERIES_REGEX.test(series))) {
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

  // 5. Éditeur, date, pagination, couverture, langue
  const f260 = fields.find(f => f.tag === '260');
  const publisher = f260 ? getSubfield(f260, 'c')?.trim() : undefined;
  const rawDate = f260 ? getSubfield(f260, 'd') : undefined;
  const publishDate = rawDate ? (cleanPublishDate(rawDate) || undefined) : undefined;
  const pageCount = paginationRaw ? cleanPageCount(paginationRaw) : undefined;

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
    _lang: langCode || undefined,
    _hasPrimaryIsbn: hasPrimaryIsbn,
    _bnfEnsembleId: bnfEnsembleId
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

          // 4. Série (Tag 290 - Titre d'ensemble local avec numéro de tome $v)
          if (!imSeries) {
            const f290 = imFields.find(f => f.tag === '290');
            const v290 = f290 ? getSubfield(f290, 'v') : undefined;
            if (f290 && v290) {
              imSeries = getSubfield(f290, 'a') || getSubfield(f290, 't');
              imSeriesNumber = v290;
            }
          }

          // 5. Série (Tag 410 - Collection uniquement si numérotée avec $v)
          if (!imSeries) {
            const f410 = imFields.find(f => f.tag === '410');
            const v410 = f410 ? getSubfield(f410, 'v') : undefined;
            if (f410 && v410) {
              imSeries = getSubfield(f410, 't') || getSubfield(f410, 'a');
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
   * et dédoublonne les rééditions par numéro de tome / titre.
   */
  async searchSeriesVolumes(seriesName: string, authorName?: string): Promise<ExternalBookMetadata[]> {
    const cleanTargetSeries = cleanSeriesName(seriesName);
    const targetSeriesKey = normalizeTextKey(cleanTargetSeries);
    if (!targetSeriesKey) return [];

    const fetchRecords = async (withAuthor?: string): Promise<string[]> => {
      const params = new URLSearchParams({
        action: 'external-lookup',
        source: 'bnf',
        schema: 'intermarc',
        series: cleanTargetSeries,
        maxRecords: '80'
      });
      if (withAuthor?.trim()) {
        params.set('author', withAuthor.trim());
      }
      const res = await fetchWithTimeout(`/api/gateway?${params.toString()}`);
      if (!res.ok) return [];
      const xml = await res.text();
      return xml.split('<srw:record>').slice(1);
    };

    try {
      let rawRecords = await fetchRecords(authorName);
      if (rawRecords.length < 2 && authorName?.trim()) {
        // Repli sans contrainte d'auteur si la série change de scénariste/dessinateur
        const fallbackRecords = await fetchRecords();
        if (fallbackRecords.length > rawRecords.length) {
          rawRecords = fallbackRecords;
        }
      }

      const candidates: Array<ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean }> = [];
      for (const recXml of rawRecords) {
        const parsed = parseIntermarcRecord(recXml);
        if (!parsed || !parsed.series) continue;

        const candSeriesKey = normalizeTextKey(parsed.series);
        const seriesMatch =
          candSeriesKey === targetSeriesKey ||
          (candSeriesKey.length >= 4 && getLevenshteinDistance(candSeriesKey, targetSeriesKey) <= 2);

        if (!seriesMatch) continue;
        // Exclure explicitement les éditions dans une langue non française si codée
        if (parsed._lang && parsed._lang !== 'fre') continue;

        candidates.push(parsed);
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

      const scoreCandidate = (c: ExternalBookMetadata & { _lang?: string; _hasPrimaryIsbn?: boolean }): number =>
        scoreEditionCandidate(c);

      const elected: ExternalBookMetadata[] = [];
      for (const group of byVolumeKey.values()) {
        group.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
        const top = group[0];
        elected.push({
          isbn: top.isbn,
          title: top.title,
          authors: top.authors,
          publisher: top.publisher,
          publishDate: top.publishDate,
          pageCount: top.pageCount,
          coverUrl: top.coverUrl,
          series: top.series,
          seriesNumber: top.seriesNumber
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
   * Recherche l'édition BnF la plus pertinente et la plus récente à partir d'indices visuels
   * (titre, série, numéro de tome, auteur, éditeur) afin de retrouver l'ISBN-13 officiel.
   */
  async searchBestMatchByHints(hints: {
    title?: string;
    series?: string;
    volumeNumber?: string;
    author?: string;
    publisher?: string;
  }): Promise<ExternalBookMetadata | null> {
    const cleanTitleHint = hints.title?.trim() || '';
    const cleanSeriesHint = hints.series ? cleanSeriesName(hints.series) : '';
    const cleanVolHint = normalizeSeriesNumber(hints.volumeNumber);
    const cleanAuthorHint = hints.author?.trim() || '';
    const cleanPublisherHint = hints.publisher?.trim() || '';

    const combinedTitleTokens: string[] = [];
    const seenTokens = new Set<string>();
    for (const part of [cleanSeriesHint, cleanTitleHint, cleanVolHint]) {
      for (const tok of part.split(/\s+/).filter(Boolean)) {
        const key = normalizeTextKey(tok);
        if (key && !seenTokens.has(key)) {
          seenTokens.add(key);
          combinedTitleTokens.push(tok);
        }
      }
    }
    const combinedQueryTitle = combinedTitleTokens.join(' ').trim();
    if (!combinedQueryTitle) return null;

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
    const queryPlans: Array<{
      titleQuery: string;
      authorQuery?: string;
      publisherQuery?: string;
      queryMode?: 'title' | 'anywhere';
    }> = [];

    if (cleanAuthorHint && cleanPublisherHint) {
      queryPlans.push({
        titleQuery: combinedQueryTitle,
        authorQuery: cleanAuthorHint,
        publisherQuery: cleanPublisherHint
      });
    }
    if (cleanAuthorHint) {
      queryPlans.push({ titleQuery: combinedQueryTitle, authorQuery: cleanAuthorHint });
    }
    if (seriesAndVolQuery && normalizeTextKey(seriesAndVolQuery) !== normalizeTextKey(combinedQueryTitle)) {
      if (cleanAuthorHint) {
        queryPlans.push({ titleQuery: seriesAndVolQuery, authorQuery: cleanAuthorHint });
      }
      queryPlans.push({ titleQuery: seriesAndVolQuery });
    }
    if (!cleanAuthorHint || normalizeTextKey(cleanTitleHint) !== normalizeTextKey(combinedQueryTitle)) {
      queryPlans.push({ titleQuery: combinedQueryTitle });
    } else {
      queryPlans.push({ titleQuery: combinedQueryTitle });
    }
    if (cleanTitleHint) {
      queryPlans.push({
        titleQuery: cleanTitleHint,
        authorQuery: cleanAuthorHint || undefined,
        queryMode: 'anywhere'
      });
    }

    let bestOverall: { score: number; meta: ExternalBookMetadata } | null = null;
    const seenPlanKeys = new Set<string>();

    try {
      for (const plan of queryPlans) {
        const planKey = `${plan.queryMode || 'title'}|${plan.titleQuery}|${plan.authorQuery || ''}|${plan.publisherQuery || ''}`;
        if (seenPlanKeys.has(planKey)) continue;
        seenPlanKeys.add(planKey);

        const rawRecords = await runSruQuery(plan);
        for (const recXml of rawRecords) {
          const parsed = parseIntermarcRecord(recXml);
          if (!parsed) continue;
          if (parsed._lang && parsed._lang !== 'fre') continue;

          const score = scoreHintMatch(parsed, hints);
          if (score < 30) continue;

          if (!bestOverall || score > bestOverall.score) {
            bestOverall = {
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
                seriesNumber: parsed.seriesNumber
              }
            };
          }
        }

        // Arrêt précoce dès qu'on a un match très fiable (dont bon tome si demandé)
        if (bestOverall && bestOverall.score >= 70) {
          break;
        }
      }

      return bestOverall ? bestOverall.meta : null;
    } catch (e: any) {
      console.warn(`[BNF RESOLVER] Erreur searchBestMatchByHints (${combinedQueryTitle}):`, e?.message || e);
      return bestOverall ? bestOverall.meta : null;
    }
  }
};
