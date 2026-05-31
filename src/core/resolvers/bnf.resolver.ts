// src/core/resolvers/bnf.resolver.ts
import type { ExternalBookMetadata } from '../types';
import { fetchWithTimeout } from '../../state/connection';

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
 * Tente d'extraire le nom de la série et le numéro à partir des relations BNF
 */
export function extractSeriesInfo(relations: string[]): { series?: string; seriesNumber?: string } {
  for (const relation of relations) {
    // Cas 1: Collection principale : (Nom ; Numéro) ou Collection : (Nom ; Numéro)
    const matchParentheses = relation.match(/Collection\s*(?:principale)?\s*:\s*\(([^;)]+)(?:\s*;\s*([^)]+))?\)/i);
    if (matchParentheses) {
      return {
        series: matchParentheses[1].trim(),
        seriesNumber: matchParentheses[2] ? matchParentheses[2].trim() : undefined
      };
    }

    // Cas 2: Collection principale : Nom ou Collection : Nom
    const matchSimple = relation.match(/Collection\s*(?:principale)?\s*:\s*([^;(\n]+)/i);
    if (matchSimple) {
      return {
        series: matchSimple[1].trim()
      };
    }
  }
  return {};
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

      // Extraction des métadonnées
      const rawTitles = extractTagContents(xmlText, 'dc:title');
      const rawCreators = extractTagContents(xmlText, 'dc:creator');
      const rawPublishers = extractTagContents(xmlText, 'dc:publisher');
      const rawDates = extractTagContents(xmlText, 'dc:date');
      const rawFormats = extractTagContents(xmlText, 'dc:format');
      const rawRelations = extractTagContents(xmlText, 'dc:relation');

      if (rawTitles.length === 0) {
        console.warn(`[BNF RESOLVER] Notice BNF présente mais titre introuvable.`);
        return null;
      }

      const seriesInfo = extractSeriesInfo(rawRelations);

      // Récupération de la couverture via le schéma InterMarc (double-fetch)
      let coverUrl: string | undefined = undefined;
      try {
        const gatewayImUrl = `/api/gateway?action=external-lookup&isbn=${encodeURIComponent(isbn)}&source=bnf&schema=intermarc`;
        const imRes = await fetchWithTimeout(gatewayImUrl);
        if (imRes.ok) {
          const imXmlText = await imRes.text();
          const coverId = extractBnfCoverId(imXmlText);
          if (coverId) {
            coverUrl = `https://catalogue.bnf.fr/couverture?idImage=${coverId}&couverture=1&appName=NE`;
            console.log(`[BNF RESOLVER] Image de couverture BNF trouvée : ${coverUrl}`);
          }
        }
      } catch (coverErr: any) {
        console.warn(`[BNF RESOLVER] Erreur lors de la récupération de la couverture :`, coverErr.message);
      }

      return {
        isbn,
        title: cleanTitle(rawTitles[0]),
        authors: rawCreators.map(cleanAuthor).filter(Boolean),
        publisher: rawPublishers.length > 0 ? cleanPublisher(rawPublishers[0]) : undefined,
        publishDate: rawDates.length > 0 ? cleanPublishDate(rawDates[0]) : undefined,
        pageCount: rawFormats.length > 0 ? cleanPageCount(rawFormats[0]) : undefined,
        coverUrl,
        ...seriesInfo
      };
    } catch (e: any) {
      console.error(`[BNF RESOLVER] Erreur lors de la résolution de l'ISBN ${isbn}:`, e.message);
      return null;
    }
  }
};
