// src/core/resolvers/googlebooks.resolver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { googleBooksResolver } from './googlebooks.resolver';

describe('Google Books Resolver', () => {
  it('doit parser et formater correctement le JSON de réponse valide de Google Books', async () => {
    const mockIsbn = '9782355848858';
    const mockJson = {
      items: [
        {
          volumeInfo: {
            title: "Celle qui brûle",
            authors: ["Paula Hawkins"],
            publisher: "Sonatine",
            publishedDate: "2021-08-31",
            pageCount: 346,
            imageLinks: {
              smallThumbnail: "http://books.google.com/books/content?id=123&printsec=frontcover&img=1&zoom=5",
              thumbnail: "http://books.google.com/books/content?id=123&printsec=frontcover&img=1&zoom=1"
            }
          }
        }
      ]
    };

    const globalFetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson)
    });
    vi.stubGlobal('fetch', globalFetchMock);

    const result = await googleBooksResolver.resolve(mockIsbn);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('Celle qui brûle');
    expect(result?.authors).toEqual(['Paula Hawkins']);
    expect(result?.publisher).toBe('Sonatine');
    expect(result?.publishDate).toBe('2021');
    expect(result?.pageCount).toBe(346);
    expect(result?.coverUrl).toBe('https://books.google.com/books/content?id=123&printsec=frontcover&img=1&zoom=1');
  });

  it('doit renvoyer null si l\'ISBN n\'a pas de correspondances sur Google Books', async () => {
    const mockIsbn = '9780000000000';
    const mockJson = {
      totalItems: 0
    };

    const globalFetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson)
    });
    vi.stubGlobal('fetch', globalFetchMock);

    const result = await googleBooksResolver.resolve(mockIsbn);
    expect(result).toBeNull();
  });
});
