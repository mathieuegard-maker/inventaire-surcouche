// src/server/connectors/google-books.connector.ts
// Connecteur Google Books avec circuit-breaker HTTP 429 via HttpClient.

import { cleanPublishDate, cleanPublisher, cleanTitle } from '../../shared/bibliographic/text-normalize.util';
import type { HttpClient } from './http-client';
import type { GoogleBooksConnector, SourceCandidateRecord } from './types';

interface GoogleBooksResponse {
  items?: Array<{
    volumeInfo?: {
      title?: string;
      subtitle?: string;
      authors?: string[];
      publisher?: string;
      publishedDate?: string;
      description?: string;
      pageCount?: number;
      categories?: string[];
      language?: string;
      imageLinks?: {
        thumbnail?: string;
        smallThumbnail?: string;
      };
    };
  }>;
}

export function createGoogleBooksConnector(http: HttpClient): GoogleBooksConnector {
  return {
    async lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null> {
      const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn13)}&maxResults=3`;
      const data = await http.fetchJson<GoogleBooksResponse>({
        source: 'google_books',
        url,
        timeoutMs: 6000,
        minIntervalMs: 250,
        cacheKey: `gb:isbn:${isbn13}`,
        cacheTtlSec: 60 * 60 * 24 * 14
      });

      const info = data?.items?.[0]?.volumeInfo;
      if (!info?.title) return null;

      const rawThumb = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail;
      const coverUrl = rawThumb ? rawThumb.replace(/^http:\/\//i, 'https://') : undefined;

      return {
        source: 'google_books',
        isbn13,
        title: cleanTitle(info.title),
        subtitle: info.subtitle ? cleanTitle(info.subtitle) : undefined,
        authors: (info.authors ?? []).map((a) => a.trim()).filter(Boolean),
        scriptwriters: [],
        illustrators: [],
        publisher: info.publisher ? cleanPublisher(info.publisher) : undefined,
        publishYear: info.publishedDate ? cleanPublishDate(info.publishedDate) || undefined : undefined,
        pageCount: typeof info.pageCount === 'number' && info.pageCount > 0 ? info.pageCount : undefined,
        description: info.description?.trim() || undefined,
        language: info.language?.toLowerCase() || undefined,
        rawSubjects: info.categories ?? [],
        coverUrl
      };
    }
  };
}
