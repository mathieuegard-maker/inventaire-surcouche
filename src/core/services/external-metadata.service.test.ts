// src/core/services/external-metadata.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { externalMetadataService } from './external-metadata.service';
import { bnfResolver } from '../resolvers/bnf.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';
import { googleBooksResolver } from '../resolvers/googlebooks.resolver';

vi.mock('../resolvers/bnf.resolver', () => ({
  bnfResolver: {
    resolve: vi.fn()
  }
}));

vi.mock('../resolvers/openlibrary.resolver', () => ({
  openLibraryResolver: {
    resolve: vi.fn()
  }
}));

vi.mock('../resolvers/googlebooks.resolver', () => ({
  googleBooksResolver: {
    resolve: vi.fn()
  }
}));

describe('External Metadata Service (Aggregation & Fusion)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('doit prioriser la BNF pour les textes et Open Library pour la couverture', async () => {
    const mockIsbn = '9782355848858';
    
    vi.mocked(bnfResolver.resolve).mockResolvedValue({
      isbn: mockIsbn,
      title: "Celle qui brûle (BNF)",
      authors: ["Paula Hawkins (BNF)"],
      publisher: "Sonatine (BNF)",
      publishDate: "2021",
      pageCount: 346,
      series: "Série BNF"
    });

    vi.mocked(openLibraryResolver.resolve).mockResolvedValue({
      isbn: mockIsbn,
      title: "Celle qui brûle (OL)",
      authors: ["Paula Hawkins (OL)"],
      publisher: "Sonatine (OL)",
      publishDate: "2021",
      pageCount: 346,
      coverUrl: "https://covers.openlibrary.org/b/id/111-L.jpg"
    });

    const result = await externalMetadataService.fetchFromExternalSources(mockIsbn);
    
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Celle qui brûle (BNF)"); // BNF prioritaire
    expect(result?.authors).toEqual(["Paula Hawkins (BNF)"]); // BNF prioritaire
    expect(result?.publisher).toBe("Sonatine (BNF)"); // BNF prioritaire
    expect(result?.coverUrl).toBe("https://covers.openlibrary.org/b/id/111-L.jpg"); // Image d'Open Library
    
    // Le livre est complet maintenant (il a la couverture d'OL et la série de la BNF).
    // Donc Google Books n'a pas dû être appelé !
    expect(googleBooksResolver.resolve).not.toHaveBeenCalled();
  });

  it('doit declencher l\'arret precoce des la premiere etape si la notice BNF est 100% complete', async () => {
    const mockIsbn = '9782355848858';
    
    vi.mocked(bnfResolver.resolve).mockResolvedValue({
      isbn: mockIsbn,
      title: "Celle qui brûle (BNF)",
      authors: ["Paula Hawkins (BNF)"],
      publisher: "Sonatine (BNF)",
      publishDate: "2021",
      pageCount: 346,
      coverUrl: "https://covers.openlibrary.org/b/id/111-L.jpg",
      series: "Série BNF" // Tous les champs sont là, donc complet !
    });

    const result = await externalMetadataService.fetchFromExternalSources(mockIsbn);
    
    expect(result).not.toBeNull();
    expect(bnfResolver.resolve).toHaveBeenCalledTimes(1);
    expect(openLibraryResolver.resolve).not.toHaveBeenCalled(); // Arrêt précoce
    expect(googleBooksResolver.resolve).not.toHaveBeenCalled(); // Arrêt précoce
  });

  it('doit se replier sur Google Books si la BNF et Open Library n\'ont pas tous les champs et que Google Books complete', async () => {
    const mockIsbn = '9781408113479';
    
    vi.mocked(bnfResolver.resolve).mockResolvedValue(null);
    vi.mocked(openLibraryResolver.resolve).mockResolvedValue({
      isbn: mockIsbn,
      title: "The Little Prince (OL)",
      authors: ["Antoine de Saint-Exupéry"],
      publisher: "Wordsworth"
    });
    vi.mocked(googleBooksResolver.resolve).mockResolvedValue({
      isbn: mockIsbn,
      title: "The Little Prince (GB)",
      authors: ["Antoine de Saint-Exupéry"],
      publisher: "Wordsworth",
      publishDate: "1998",
      pageCount: 110,
      coverUrl: "https://books.google.com/123.jpg"
    });

    const result = await externalMetadataService.fetchFromExternalSources(mockIsbn);
    
    expect(result).not.toBeNull();
    expect(result?.title).toBe("The Little Prince (OL)"); // OL prioritaire sur GB car etape 2
    expect(result?.publishDate).toBe("1998"); // Récupéré de GB
    expect(result?.pageCount).toBe(110); // Récupéré de GB
    expect(result?.coverUrl).toBe("https://books.google.com/123.jpg"); // Récupéré de GB
  });

  it('doit renvoyer null si aucune source n\'a trouve de notice', async () => {
    const mockIsbn = '9780000000000';
    
    vi.mocked(bnfResolver.resolve).mockResolvedValue(null);
    vi.mocked(openLibraryResolver.resolve).mockResolvedValue(null);
    vi.mocked(googleBooksResolver.resolve).mockResolvedValue(null);

    const result = await externalMetadataService.fetchFromExternalSources(mockIsbn);
    
    expect(result).toBeNull();
  });
});
