// src/core/services/v4-pipeline.service.ts
// Point d'entrée unifié (barrel) du pipeline d'acquisition FRBR V4 (Couches 1 -> 5).
// 100 % portable sur DatabaseBinding + fetch() standard (zéro dépendance propriétaire Cloudflare).

export {
  computeEan13CheckDigit,
  extractAuthorLastNameForBnfCql,
  fetchWithTimeoutAndRetry,
  isGoogleBooksCircuitOpen,
  normalizeIsbnWithPressFallback,
  resetGoogleBooksCircuit,
  scheduleBnfSruCall,
  tripGoogleBooksCircuit,
  type IngestBatchResult,
  type IngestSingleResult,
  type Layer2CheckResult,
  type Layer2Status,
  type LibraryBookOverrides,
  type SeriesVoteCandidate,
  type SisterEditionCandidate,
  type SourceChannel,
  type StagingPayload,
  type UserIngestHint,
  type V4BookRecord
} from './v4/v4-shared';

export {
  checkBookIndexLayer2,
  searchLocalBooksForCanal3,
  type LocalSearchHit
} from './v4/v4-layer2-index';

export {
  discoverMultiSourceLayer3,
  extractMarcRecordMetadata
} from './v4/v4-layer3-discovery';

export {
  consolidateBookLayer4,
  detectIntegralAndIncludedVolumes,
  electCanonicalSeriesFromVotes,
  linkBookToLibrary
} from './v4/v4-layer4-consolidation';

export {
  drainEnrichmentQueueBatch,
  enqueueOrExpandSeriesLayer5,
  runSilentEditionDiscoveryPass,
  runV4IngestionPipeline
} from './v4/v4-layer5-orchestrator';

export {
  excludeBookFromSeriesForLibrary,
  getV4SeriesBooks,
  syncV4LibraryBooks,
  updateV4BookMetadata,
  type V4SeriesBooksResponse,
  type V4SyncBookItem,
  type V4SyncResponse
} from './v4/v4-library-queries';
