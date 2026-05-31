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

      if (rawTitles.length === 0) {
        console.warn(`[BNF RESOLVER] Notice BNF présente mais titre introuvable.`);
        return null;
      }

      return {
        isbn,
        title: cleanTitle(rawTitles[0]),
        authors: rawCreators.map(cleanAuthor).filter(Boolean),
        publisher: rawPublishers.length > 0 ? cleanPublisher(rawPublishers[0]) : undefined,
        publishDate: rawDates.length > 0 ? cleanPublishDate(rawDates[0]) : undefined,
        pageCount: rawFormats.length > 0 ? cleanPageCount(rawFormats[0]) : undefined
      };
    } catch (e: any) {
      console.error(`[BNF RESOLVER] Erreur lors de la résolution de l'ISBN ${isbn}:`, e.message);
      return null;
    }
  }
};
