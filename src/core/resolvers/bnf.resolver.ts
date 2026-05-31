// src/core/resolvers/bnf.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';

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
  return rawTitle.split('/')[0].trim();
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
  return series.replace(/\s*\([^)]*\)\s*$/, '').trim();
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

export const bnfResolver = {
  async resolve(isbn: string): Promise<ExternalBookMetadata | null> {
    try {
      console.log(`[BNF RESOLVER] Recherche par ISBN : ${isbn}`);
      const gatewayUrl = `/api/gateway?action=external-lookup&isbn=${encodeURIComponent(isbn)}&source=bnf`;
      
      const res = await fetchWithTimeout(gatewayUrl);
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

      // Récupération et parsing approfondi d'InterMarc (double-fetch systématique)
      let coverUrl: string | undefined = undefined;
      let imTitle: string | undefined = undefined;
      let imSeries: string | undefined = undefined;
      let imSeriesNumber: string | undefined = undefined;
      let imVolumeNumber: string | undefined = undefined;

      try {
        const gatewayImUrl = `/api/gateway?action=external-lookup&isbn=${encodeURIComponent(isbn)}&source=bnf&schema=intermarc`;
        const imRes = await fetchWithTimeout(gatewayImUrl);
        if (imRes.ok) {
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
            imTitle = getSubfield(f245, 'a');
            imVolumeNumber = getSubfield(f245, 'u');
          }

          // 3. Série (Tag 460 - Notice d'ensemble)
          const f460 = imFields.find(f => f.tag === '460');
          if (f460) {
            imSeries = getSubfield(f460, 't');
            imSeriesNumber = getSubfield(f460, 'v');
          }

          // 4. Série (Tag 290 - Titre d'ensemble local)
          if (!imSeries) {
            const f290 = imFields.find(f => f.tag === '290');
            if (f290) {
              imSeries = getSubfield(f290, 'a');
              imSeriesNumber = getSubfield(f290, 'v');
            }
          }

          // 5. Série (Tag 410 - Collection)
          if (!imSeries) {
            const f410 = imFields.find(f => f.tag === '410');
            if (f410) {
              imSeries = getSubfield(f410, 't');
              imSeriesNumber = getSubfield(f410, 'v');
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
          dcSeries = parsed.series;
          if (parsed.seriesNumber) {
            dcSeriesNumber = parsed.seriesNumber;
          }
          break;
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
  }
};
