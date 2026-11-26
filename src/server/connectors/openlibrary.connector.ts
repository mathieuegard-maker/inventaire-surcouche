// src/server/connectors/openlibrary.connector.ts
// Connecteur Open Library (ISBN -> métadonnées complémentaires & couverture de secours).

import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import {
  cleanPublishDate,
  cleanPublisher,
  cleanTitle,
  isLatinScriptLabel,
  normalizeTextKey
} from '../../shared/bibliographic/text-normalize.util';
import type { HttpClient } from './http-client';
import type { OpenLibraryConnector, SourceCandidateRecord } from './types';

interface OpenLibraryBookEntry {
  title?: string;
  subtitle?: string;
  authors?: Array<{ name?: string }>;
  publishers?: Array<{ name?: string }>;
  publish_date?: string;
  number_of_pages?: number;
  subjects?: Array<{ name?: string }>;
  cover?: { large?: string; medium?: string; small?: string };
}

interface OpenLibrarySearchDoc {
  title?: string;
  subtitle?: string;
  author_name?: string[];
  isbn?: string[];
  publisher?: string[];
  first_publish_year?: number;
  subject?: string[];
  language?: string[];
  cover_i?: number;
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibrarySearchDoc[];
}

function pickPreferredIsbn13(rawIsbns?: string[]): string {
  if (!rawIsbns || rawIsbns.length === 0) return '';
  const valid: string[] = [];
  for (const raw of rawIsbns) {
    const norm = isbnUtil.normalizeToIsbn13(raw);
    if (norm && isbnUtil.isValidBookBarcode(norm)) {
      valid.push(norm);
    }
  }
  if (valid.length === 0) return '';
  // Prioriser les ISBN francophones (978-2 / 979-10)
  return valid.find((x) => x.startsWith('9782') || x.startsWith('97910')) ?? valid[0];
}

export function createOpenLibraryConnector(http: HttpClient): OpenLibraryConnector {
  return {
    async lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null> {
      const key = `ISBN:${isbn13}`;
      const url = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(key)}&format=json&jscmd=data`;
      const data = await http.fetchJson<Record<string, OpenLibraryBookEntry>>({
        source: 'openlibrary',
        url,
        timeoutMs: 4000,
        minIntervalMs: 200,
        cacheKey: `ol:isbn:${isbn13}`,
        cacheTtlSec: 60 * 60 * 24 * 14
      });

      const entry = data?.[key];
      if (!entry?.title) return null;
      const cleanedTitle = cleanTitle(entry.title);
      if (!cleanedTitle || !isLatinScriptLabel(cleanedTitle)) return null;

      return {
        source: 'openlibrary',
        isbn13,
        title: cleanedTitle,
        subtitle: entry.subtitle ? cleanTitle(entry.subtitle) : undefined,
        authors: (entry.authors ?? []).map((a) => a.name?.trim() || '').filter(Boolean),
        scriptwriters: [],
        illustrators: [],
        publisher: entry.publishers?.[0]?.name ? cleanPublisher(entry.publishers[0].name) : undefined,
        publishYear: entry.publish_date ? cleanPublishDate(entry.publish_date) || undefined : undefined,
        pageCount:
          typeof entry.number_of_pages === 'number' && entry.number_of_pages > 0
            ? entry.number_of_pages
            : undefined,
        rawSubjects: (entry.subjects ?? []).map((s) => s.name?.trim() || '').filter(Boolean).slice(0, 12),
        coverUrl: entry.cover?.large ?? entry.cover?.medium ?? entry.cover?.small
      };
    },

    async searchByText(query: string, maxResults = 6): Promise<SourceCandidateRecord[]> {
      const cleanQ = query.replace(/"/g, ' ').trim();
      if (!cleanQ) return [];
      const limit = Math.min(10, Math.max(1, maxResults));
      const url =
        `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQ)}` +
        `&limit=${limit}&fields=title,subtitle,author_name,isbn,publisher,first_publish_year,subject,language,cover_i`;
      const data = await http.fetchJson<OpenLibrarySearchResponse>({
        source: 'openlibrary',
        url,
        timeoutMs: 5000,
        minIntervalMs: 250,
        cacheKey: `ol:text:${normalizeTextKey(cleanQ)}:${limit}`,
        cacheTtlSec: 60 * 60 * 48
      });

      const out: SourceCandidateRecord[] = [];
      for (const doc of data?.docs ?? []) {
        if (!doc.title) continue;
        const cleanedTitle = cleanTitle(doc.title);
        if (!cleanedTitle || !isLatinScriptLabel(cleanedTitle)) continue;
        const isbn13 = pickPreferredIsbn13(doc.isbn);
        if (!isbn13) continue;
        const langs = (doc.language ?? []).map((l) => l.toLowerCase());
        const language = langs.includes('fre') || langs.includes('fr') ? 'fre' : langs[0];

        out.push({
          source: 'openlibrary',
          isbn13,
          title: cleanedTitle,
          subtitle: doc.subtitle ? cleanTitle(doc.subtitle) : undefined,
          authors: (doc.author_name ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 4),
          scriptwriters: [],
          illustrators: [],
          publisher: doc.publisher?.[0] ? cleanPublisher(doc.publisher[0]) : undefined,
          publishYear: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
          language,
          rawSubjects: (doc.subject ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 10),
          coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined
        });
      }
      return out;
    }
  };
}
