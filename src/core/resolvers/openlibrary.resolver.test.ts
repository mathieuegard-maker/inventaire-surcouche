// src/core/resolvers/openlibrary.resolver.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openLibraryResolver } from './openlibrary.resolver';

describe('Open Library Resolver', () => {
  it('doit parser et formater correctement le JSON de réponse valide d\'Open Library', async () => {
    const mockIsbn = '9782355848858';
    const mockJson = {
      [`ISBN:${mockIsbn}`]: {
        title: "Celle qui brûle",
        number_of_pages: 346,
        publish_date: "August 31, 2021",
        cover: {
          small: "https://covers.openlibrary.org/b/id/111-S.jpg",
          medium: "https://covers.openlibrary.org/b/id/111-M.jpg",
          large: "https://covers.openlibrary.org/b/id/111-L.jpg"
        },
        authors: [
          { name: "Paula Hawkins", url: "https://..." }
        ],
        publishers: [
          { name: "Sonatine" }
        ]
      }
    };

    const globalFetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson)
    });
    vi.stubGlobal('fetch', globalFetchMock);

    const result = await openLibraryResolver.resolve(mockIsbn);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('Celle qui brûle');
    expect(result?.authors).toEqual(['Paula Hawkins']);
    expect(result?.publisher).toBe('Sonatine');
    expect(result?.publishDate).toBe('2021');
    expect(result?.pageCount).toBe(346);
    expect(result?.coverUrl).toBe('https://covers.openlibrary.org/b/id/111-L.jpg');
  });

  it('doit renvoyer null si l\'ISBN n\'est pas dans le dictionnaire d\'Open Library', async () => {
    const mockIsbn = '9780000000000';
    const mockJson = {};

    const globalFetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson)
    });
    vi.stubGlobal('fetch', globalFetchMock);

    const result = await openLibraryResolver.resolve(mockIsbn);
    expect(result).toBeNull();
  });
});
