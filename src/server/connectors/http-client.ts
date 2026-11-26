// src/server/connectors/http-client.ts
// Client HTTP résilient par source : timeout, circuit-breaker (429 / pannes répétées), throttle, IPv4 node:https et cache SQLite external_cache.

import http from 'node:http';
import https from 'node:https';
import type { JobRepository } from '../repositories/job.repo';
import {
  getCurrentRequestPriority,
  PriorityRateLimiter,
  type RequestPriority
} from './request-priority';
import type { SourceName } from './types';

interface CircuitState {
  failures: number;
  openUntil: number;
}

export interface HttpFetchOptions {
  source: SourceName;
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cacheKey?: string;
  cacheTtlSec?: number;
  minIntervalMs?: number;
  /** Force node:http/https en IPv4 (contourne les resets/timeouts undici sur catalogue.bnf.fr). */
  forceIpv4?: boolean;
  /** Priorité explicite (par défaut héritée du contexte AsyncLocalStorage : 'high' interactif / 'low' fond). */
  priority?: RequestPriority;
}

const DEFAULT_TIMEOUT_MS = 8000;
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min uniquement sur HTTP 429 Google Books (quota journalier)
const BURST_RETRY_BACKOFF_MS = 3000; // Pause courte 3 s sur HTTP 429 ponctuel (Inventaire / Wikidata / BnF)
const FAILURE_TRIP_THRESHOLD = 6;
const FAILURE_COOLDOWN_MS = 30 * 1000; // 30 s sur pannes 5xx/réseau répétées (ne bloque pas les jobs suivants)
const API_USER_AGENT = 'BiblioCollection/2.0 (+https://biblio.mathieuegardtest.fr)';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) BiblioCollection/2.0 Safari/537.36';

/**
 * Détecte les erreurs applicatives renvoyées en HTTP 200 par certaines API (ex. MediaWiki/Wikidata
 * `{"error":{"code":"cirrussearch-too-busy-error"}}`) afin de ne jamais les figer en cache SQLite.
 */
function isJsonErrorPayload(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Boolean(parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error);
  } catch {
    return false;
  }
}

function fetchWithNodeIpv4(
  urlStr: string,
  headers: Record<string, string>,
  timeoutMs: number,
  redirectsLeft = 3
): Promise<{ status: number; ok: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        family: 4,
        headers,
        timeout: timeoutMs
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (location && status >= 300 && status < 400 && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(location, parsed).toString();
          fetchWithNodeIpv4(nextUrl, headers, timeoutMs, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: Buffer.concat(chunks).toString('utf-8')
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('HTTP IPv4 timeout'));
    });
    req.on('error', reject);
  });
}

export class HttpClient {
  private readonly jobRepo?: JobRepository;
  private readonly circuits = new Map<SourceName, CircuitState>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly rateLimiter: PriorityRateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly hasCustomFetch: boolean;

  constructor(options?: {
    jobRepo?: JobRepository;
    fetchImpl?: typeof fetch;
    rateLimiter?: PriorityRateLimiter;
  }) {
    this.jobRepo = options?.jobRepo;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.hasCustomFetch = Boolean(options?.fetchImpl);
    this.rateLimiter = options?.rateLimiter ?? new PriorityRateLimiter({ bypassTiming: this.hasCustomFetch });
  }

  private getCircuit(source: SourceName): CircuitState {
    let state = this.circuits.get(source);
    if (!state) {
      state = { failures: 0, openUntil: 0 };
      this.circuits.set(source, state);
    }
    return state;
  }

  isCircuitOpen(source: SourceName): boolean {
    const state = this.getCircuit(source);
    return state.openUntil > Date.now();
  }

  tripCircuit(source: SourceName, durationMs = RATE_LIMIT_COOLDOWN_MS): void {
    const state = this.getCircuit(source);
    state.openUntil = Date.now() + durationMs;
  }

  async fetchText(options: HttpFetchOptions): Promise<string | null> {
    const nowIso = new Date().toISOString();
    if (options.cacheKey && this.jobRepo) {
      const cached = this.jobRepo.getExternalCache<{ text: string }>(options.cacheKey, nowIso);
      if (cached && typeof cached.text === 'string') {
        return cached.text;
      }
    }

    if (this.isCircuitOpen(options.source)) {
      return null;
    }

    // Déduplication en vol (in-flight coalescing) : si 2 flux/utilisateurs demandent exactement la même ressource
    // au même instant, 1 seule requête réseau part et les 2 flux partagent la même promesse.
    const flightKey = options.cacheKey ? `ck:${options.cacheKey}` : `url:${options.source}:${options.url}`;
    const existingFlight = this.inFlight.get(flightKey);
    if (existingFlight) {
      return existingFlight;
    }

    const promise = this.executeFetchText(options).finally(() => {
      this.inFlight.delete(flightKey);
    });
    this.inFlight.set(flightKey, promise);
    return promise;
  }

  private async executeFetchText(options: HttpFetchOptions): Promise<string | null> {
    const circuit = this.getCircuit(options.source);
    const minInterval = options.minIntervalMs;
    const priority = options.priority ?? getCurrentRequestPriority();

    const headers: Record<string, string> = {
      'User-Agent': options.source === 'bnf' ? BROWSER_USER_AGENT : API_USER_AGENT,
      ...(options.headers ?? {})
    };
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (this.isCircuitOpen(options.source)) {
        return null;
      }

      const outcome = await this.rateLimiter.schedule(
        options.source,
        async (): Promise<{ kind: 'ok'; text: string } | { kind: 'retry' } | { kind: 'stop' }> => {
          if (this.isCircuitOpen(options.source)) {
            return { kind: 'stop' };
          }
          try {
            let status: number;
            let ok: boolean;
            let text: string;

            if (options.forceIpv4 && !this.hasCustomFetch) {
              const result = await fetchWithNodeIpv4(options.url, headers, timeoutMs);
              status = result.status;
              ok = result.ok;
              text = result.text;
            } else {
              const res = await this.fetchImpl(options.url, {
                headers,
                signal: AbortSignal.timeout(timeoutMs)
              });
              status = res.status;
              ok = res.ok;
              text = ok ? await res.text() : '';
            }

            if (status === 429) {
              if (options.source === 'google_books') {
                circuit.openUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
                return { kind: 'stop' };
              }
              // Sur Inventaire / Wikidata / BnF : micro-limitation de débit -> courte pause 3 s + 1 retry
              this.rateLimiter.pushBackoff(options.source, BURST_RETRY_BACKOFF_MS);
              if (attempt === 1) {
                return { kind: 'retry' };
              }
              return { kind: 'stop' };
            }

            if (!ok) {
              // Les réponses 4xx (ex. 404 ISBN absent d'Inventaire) ne sont PAS des pannes serveur -> ne jamais ouvrir le circuit-breaker dessus !
              if (status >= 500) {
                circuit.failures++;
                if (circuit.failures >= FAILURE_TRIP_THRESHOLD) {
                  circuit.openUntil = Date.now() + FAILURE_COOLDOWN_MS;
                  circuit.failures = 0;
                }
              }
              return { kind: 'stop' };
            }

            circuit.failures = 0;

            // Plafonnement de taille du cache SQLite : ne jamais figer d'énormes payloads XML/JSON > 120 Ko,
            // et borner à 24 h les réponses de recherche moyennes (> 24 Ko) afin d'éviter la croissance incontrôlée de biblio.sqlite.
            if (options.cacheKey && this.jobRepo && !isJsonErrorPayload(text) && text.length <= 120_000) {
              const requestedTtl = options.cacheTtlSec ?? 86400;
              const ttlSec = text.length > 24_000 ? Math.min(requestedTtl, 86400) : requestedTtl;
              const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
              this.jobRepo.setExternalCache(options.cacheKey, options.source, { text }, expiresAt);
            }

            return { kind: 'ok', text };
          } catch {
            circuit.failures++;
            if (circuit.failures >= FAILURE_TRIP_THRESHOLD) {
              circuit.openUntil = Date.now() + FAILURE_COOLDOWN_MS;
              circuit.failures = 0;
            }
            return { kind: 'stop' };
          }
        },
        { priority, minIntervalMs: minInterval }
      );

      if (outcome.kind === 'ok') return outcome.text;
      if (outcome.kind === 'stop') return null;
      // En mode mock/test avec `bypassTiming` (tests fakeTimers 429), respecter explicitement le backoff 3 s avant retry
      if (this.hasCustomFetch) {
        await new Promise((resolve) => setTimeout(resolve, BURST_RETRY_BACKOFF_MS));
      }
    }

    return null;
  }

  async fetchJson<T>(options: HttpFetchOptions): Promise<T | null> {
    const text = await this.fetchText({
      ...options,
      headers: { Accept: 'application/json', ...(options.headers ?? {}) }
    });
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}
