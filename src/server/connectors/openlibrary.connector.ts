// src/server/connectors/openlibrary.connector.ts
// Connecteur Open Library (ISBN -> métadonnées complémentaires & couverture de secours).

import { cleanPublishDate, cleanPublisher, cleanTitle } from '../../shared/bibliographic/text-normalize.util';
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

export function createOpenLibraryConnector(http: HttpClient): OpenLibraryConnector {
  return {
    async lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null> {
      const key = `ISBN:${isbn13}`;
      const url = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(key)}&format=json&jscmd=data`;
      const data = await http.fetchJson<Record<string, OpenLibraryBookEntry>>({
        source: 'openlibrary',
        url,
        timeoutMs: 6500,
        minIntervalMs: 200,
        cacheKey: `ol:isbn:${isbn13}`,
        cacheTtlSec: 60 * 60 * 24 * 14
      });

      const entry = data?.[key];
      if (!entry?.title) return null;

      return {
        source: 'openlibrary',
        isbn13,
        title: cleanTitle(entry.title),
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
    }
  };
}
