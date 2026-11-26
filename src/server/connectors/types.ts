// src/server/connectors/types.ts
// Contrats normalisés des 6 connecteurs bibliographiques externes (isolés et 100 % mockables).

export type SourceName = 'bnf' | 'sudoc' | 'inventaire' | 'wikidata' | 'google_books' | 'openlibrary';

export type SeriesLinkKind =
  | 'graph_p179'
  | 'marc_ensemble_460'
  | 'marc_collection_225'
  | 'heuristic_text';

/**
 * Une colonne normalisée du Tableau Comparatif (Étage 2) produite par une source externe.
 */
export interface SourceCandidateRecord {
  source: SourceName;
  isbn13: string;
  title?: string;
  subtitle?: string;
  seriesName?: string;
  seriesLinkKind?: SeriesLinkKind;
  volumeNumber?: string;
  /** Vrai si le numéro de tome provient d'un champ structuré MARC `460$v`/`461$v` valide (et non d'un fallback `245$h` avec `460$v` année/absent). */
  hasStructuredEnsembleVolume?: boolean;
  bnfEnsembleId?: string;
  wikidataSeriesQid?: string;
  inventaireSeriesUri?: string;
  collectionName?: string;
  collectionNumber?: string;
  authors: string[];
  scriptwriters: string[];
  illustrators: string[];
  publisher?: string;
  publishYear?: string;
  pageCount?: number;
  description?: string;
  language?: string;
  originalLanguage?: string;
  deweyCode?: string;
  rawSubjects: string[];
  wikidataWorkQid?: string;
  inventaireWorkUri?: string;
  sudocPpn?: string;
  coverUrl?: string;
  isNonBook?: boolean;
  isIntegralHint?: boolean;
  integralNotes?: string;
  contentKind?: 'illustrated' | 'text_only';
}

/**
 * Métadonnées propres à une édition (ISBN-13) d'une œuvre d'une série (évite d'écraser l'éditeur/collection/année
 * des rééditions lors de la fusion dans `mergeGraphWorks`).
 */
export interface GraphWorkEditionRecord {
  isbn13: string;
  publisher?: string | null;
  collectionName?: string | null;
  publishYear?: string | null;
  pageCount?: number | null;
  coverUrl?: string | null;
  source: SourceName;
}

/**
 * Œuvre officielle d'une série retournée par le Graphe (Wikidata P179/P1545 ou Inventaire)
 * ou par le filet de sécurité BnF 460$3 / titre.
 */
export interface GraphSeriesWork {
  title: string;
  volumeNumber?: number | null;
  volumeLabel?: string | null;
  hasStructuredEnsembleVolume?: boolean;
  sortOrder?: number | null;
  wikidataQid?: string | null;
  inventaireUri?: string | null;
  bnfEnsembleId?: string | null;
  authors: string[];
  scriptwriters?: string[];
  illustrators?: string[];
  isbn13s: string[];
  editionRecords?: GraphWorkEditionRecord[];
  publisher?: string | null;
  collectionName?: string | null;
  publishYear?: string | null;
  pageCount?: number | null;
  language?: string | null;
  originalLanguage?: string | null;
  deweyCode?: string | null;
  rawSubjects?: string[];
  coverUrl?: string | null;
  isHorsSerie?: boolean;
  isIntegral?: boolean;
  includedVolumes?: string[];
  contentKind?: 'illustrated' | 'text_only';
  source: SourceName;
}

/**
 * Échantillon léger utilisé par CollectionGuardService pour le test d'hétérogénéité des auteurs.
 */
export interface CollectionSampleItem {
  title: string;
  authors: string[];
  volumeNumber?: string;
}

export interface BnfSeriesDiscoveryResult {
  works: GraphSeriesWork[];
  discoveredEnsembleIds: string[];
}

export interface BnfConnector {
  lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null>;
  searchByEnsembleId(bnfEnsembleId: string, maxRecords?: number): Promise<GraphSeriesWork[]>;
  searchBySeriesName?(seriesName: string, author?: string, maxRecords?: number): Promise<BnfSeriesDiscoveryResult>;
  searchSeriesVolume?(seriesName: string, volumeNumber: number, author?: string): Promise<GraphSeriesWork[]>;
  searchSeriesIntegrals?(seriesName: string, maxRecords?: number): Promise<GraphSeriesWork[]>;
  sampleByCollectionName(collectionName: string, maxRecords?: number): Promise<CollectionSampleItem[]>;
  searchByTitleAndAuthor(title: string, author?: string, maxRecords?: number): Promise<SourceCandidateRecord[]>;
  searchAnywhere?(query: string, maxRecords?: number): Promise<SourceCandidateRecord[]>;
}

export interface SudocConnector {
  lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null>;
}

export interface InventaireConnector {
  lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null>;
  fetchSeriesWorks(seriesUri: string): Promise<GraphSeriesWork[]>;
  fetchWorkEditions?(workUri: string): Promise<{ isbn13s: string[]; coverUrls: string[] }>;
  searchSeriesUri?(seriesName: string): Promise<{ seriesUri: string; wikidataQid: string | null } | null>;
  searchByText?(query: string, limit?: number): Promise<SourceCandidateRecord[]>;
}

export interface WikidataConnector {
  lookupWorkByQid(workQid: string, fallbackIsbn13?: string): Promise<SourceCandidateRecord | null>;
  lookupWorkByTitleAndAuthor?(title: string, author: string, fallbackIsbn13?: string): Promise<SourceCandidateRecord | null>;
  fetchSeriesWorksByQid(seriesQid: string): Promise<GraphSeriesWork[]>;
  searchSeriesQid?(seriesName: string): Promise<string | null>;
  searchSeriesQids?(seriesName: string, mediaFamily?: 'graphic' | 'prose' | 'neutral'): Promise<string[]>;
}

export interface GoogleBooksConnector {
  lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null>;
  searchByTitleAndAuthor?(title: string, author?: string, maxResults?: number): Promise<SourceCandidateRecord[]>;
  searchByText?(query: string, maxResults?: number): Promise<SourceCandidateRecord[]>;
}

export interface OpenLibraryConnector {
  lookupByIsbn(isbn13: string): Promise<SourceCandidateRecord | null>;
  searchByText?(query: string, maxResults?: number): Promise<SourceCandidateRecord[]>;
}

export interface BibliographicConnectors {
  bnf: BnfConnector;
  sudoc: SudocConnector;
  inventaire: InventaireConnector;
  wikidata: WikidataConnector;
  googleBooks: GoogleBooksConnector;
  openLibrary: OpenLibraryConnector;
}
