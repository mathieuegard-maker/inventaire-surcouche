// src/server/connectors/index.ts
// Assemblage des 6 connecteurs bibliographiques sur un HttpClient partagé.

import type { JobRepository } from '../repositories/job.repo';
import { HttpClient } from './http-client';
import type { PriorityRateLimiter } from './request-priority';
import { createBnfConnector } from './bnf.connector';
import { createSudocConnector } from './sudoc.connector';
import { createInventaireConnector } from './inventaire.connector';
import { createWikidataConnector } from './wikidata.connector';
import { createGoogleBooksConnector } from './google-books.connector';
import { createOpenLibraryConnector } from './openlibrary.connector';
import type { BibliographicConnectors } from './types';

export function createBibliographicConnectors(options?: {
  jobRepo?: JobRepository;
  fetchImpl?: typeof fetch;
  rateLimiter?: PriorityRateLimiter;
}): BibliographicConnectors {
  const http = new HttpClient({
    jobRepo: options?.jobRepo,
    fetchImpl: options?.fetchImpl,
    rateLimiter: options?.rateLimiter
  });
  return {
    bnf: createBnfConnector(http),
    sudoc: createSudocConnector(http),
    inventaire: createInventaireConnector(http),
    wikidata: createWikidataConnector(http),
    googleBooks: createGoogleBooksConnector(http),
    openLibrary: createOpenLibraryConnector(http)
  };
}

export * from './types';
export { HttpClient } from './http-client';
export * from './request-priority';
