// src/server/connectors/google-books.connector.ts
// Connecteur Google Books avec circuit-breaker HTTP 429 via HttpClient.

import { isbnUtil } from '../../shared/bibliographic/isbn.util';
import {
  cleanPublishDate,
  cleanPublisher,
  cleanTitle,
  extractAuthorLastNameForQuery,
  normalizeTextKey
} from '../../shared/bibliographic/text-normalize.util';
import type { HttpClient } from './http-client';
import type { GoogleBooksConnector, SourceCandidateRecord } from './types';

interface GoogleBooksVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  categories?: string[];
  language?: string;
  industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
  imageLinks?: {
    thumbnail?: string;
    smallThumbnail?: string;
  };
}

interface GoogleBooksResponse {
  items?: Array<{
    volumeInfo?: GoogleBooksVolumeInfo;
  }>;
}

function mapVolumeInfoToCandidate(info: GoogleBooksVolumeInfo, fallbackIsbn13 = ''): SourceCandidateRecord | null {
  if (!info?.title) return null;

  const rawThumb = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail;
  const coverUrl = rawThumb ? rawThumb.replace(/^http:\/\//i, 'https://').replace('&edge=curl', '') : undefined;

  const rawIsbn =
    info.industryIdentifiers?.find((x) => x.type === 'ISBN_13')?.identifier ??
    info.industryIdentifiers?.find((x) => x.type === 'ISBN_10')?.identifier ??
    '';
  const isbn13 = fallbackIsbn13 || (rawIsbn ? isbnUtil.normalizeToIsbn13(rawIsbn) ?? '' : '');

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

export function createGoogleBooksConnector(http: HttpClient): GoogleBooksConnector {
  return {
    async lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null> {
      const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn13)}&maxResults=3`;
      const data = await http.fetchJson<GoogleBooksResponse>({
        source: 'google_books',
        url,
        timeoutMs: 4000,
        minIntervalMs: 250,
        cacheKey: `gb:isbn:${isbn13}`,
        cacheTtlSec: 60 * 60 * 24 * 14
      });

      const info = data?.items?.[0]?.volumeInfo;
      return info ? mapVolumeInfoToCandidate(info, isbn13) : null;
    },

    async searchByTitleAndAuthor(title: string, author?: string, maxResults = 5): Promise<SourceCandidateRecord[]> {
      const cleanT = title.replace(/"/g, ' ').trim();
      if (!cleanT) return [];
      const lastName = extractAuthorLastNameForQuery(author);
      const q = lastName ? `intitle:${cleanT} inauthor:${lastName}` : `intitle:${cleanT}`;
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&langRestrict=fr&maxResults=${Math.min(10, maxResults)}`;
      const data = await http.fetchJson<GoogleBooksResponse>({
        source: 'google_books',
        url,
        timeoutMs: 4000,
        minIntervalMs: 250,
        cacheKey: `gb:search:${normalizeTextKey(q)}:${maxResults}`,
        cacheTtlSec: 60 * 60 * 24 * 7
      });

      const out: SourceCandidateRecord[] = [];
      for (const item of data?.items ?? []) {
        const mapped = item.volumeInfo ? mapVolumeInfoToCandidate(item.volumeInfo) : null;
        if (mapped) out.push(mapped);
      }
      return out;
    }
  };
}
