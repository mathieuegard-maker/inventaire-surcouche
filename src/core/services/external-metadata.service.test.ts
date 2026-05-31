// src/core/services/external-metadata.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { externalMetadataService } from './external-metadata.service';
import { bnfResolver } from '../resolvers/bnf.resolver';
import { openLibraryResolver } from '../resolvers/openlibrary.resolver';

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
      pageCount: 346
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
  });

  it('doit se replier sur Open Library si la BNF ne renvoie aucun résultat', async () => {
    const mockIsbn = '9781408113479'; // Exemple de livre uniquement en anglais
    
    vi.mocked(bnfResolver.resolve).mockResolvedValue(null);

    vi.mocked(openLibraryResolver.resolve).mockResolvedValue({
      isbn: mockIsbn,
      title: "The Little Prince (OL)",
      authors: ["Antoine de Saint-Exupéry"],
      publisher: "Wordsworth",
      publishDate: "1998",
      pageCount: 110,
      coverUrl: "https://covers.openlibrary.org/b/id/222-L.jpg"
    });

    const result = await externalMetadataService.fetchFromExternalSources(mockIsbn);
    
    expect(result).not.toBeNull();
    expect(result?.title).toBe("The Little Prince (OL)");
    expect(result?.authors).toEqual(["Antoine de Saint-Exupéry"]);
    expect(result?.publisher).toBe("Wordsworth");
    expect(result?.coverUrl).toBe("https://covers.openlibrary.org/b/id/222-L.jpg");
  });

  it('doit renvoyer null si aucune source n\'a trouvé de notice', async () => {
    const mockIsbn = '9780000000000';
    
    vi.mocked(bnfResolver.resolve).mockResolvedValue(null);
    vi.mocked(openLibraryResolver.resolve).mockResolvedValue(null);

    const result = await externalMetadataService.fetchFromExternalSources(mockIsbn);
    
    expect(result).toBeNull();
  });
});
