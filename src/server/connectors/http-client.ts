// src/server/connectors/http-client.ts
// Client HTTP résilient par source : timeout, circuit-breaker (429 / pannes répétées), throttle et cache SQLite external_cache.

import type { JobRepository } from '../repositories/job.repo';
import type { SourceName } from './types';

interface CircuitState {
  failures: number;
  openUntil: number;
  lastRequestAt: number;
}

export interface HttpFetchOptions {
  source: SourceName;
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  cacheKey?: string;
  cacheTtlSec?: number;
  minIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min sur HTTP 429 (ex: Google Books)
const FAILURE_TRIP_THRESHOLD = 4;
const FAILURE_COOLDOWN_MS = 2 * 60 * 1000;

export class HttpClient {
  private readonly jobRepo?: JobRepository;
  private readonly circuits = new Map<SourceName, CircuitState>();
  private readonly fetchImpl: typeof fetch;

  constructor(options?: { jobRepo?: JobRepository; fetchImpl?: typeof fetch }) {
    this.jobRepo = options?.jobRepo;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  private getCircuit(source: SourceName): CircuitState {
    let state = this.circuits.get(source);
    if (!state) {
      state = { failures: 0, openUntil: 0, lastRequestAt: 0 };
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

    const circuit = this.getCircuit(options.source);
    const minInterval = options.minIntervalMs ?? 0;
    if (minInterval > 0) {
      const elapsed = Date.now() - circuit.lastRequestAt;
      if (elapsed < minInterval) {
        await new Promise((resolve) => setTimeout(resolve, minInterval - elapsed));
      }
    }
    circuit.lastRequestAt = Date.now();

    try {
      const res = await this.fetchImpl(options.url, {
        headers: {
          'User-Agent': 'BiblioCollection/2.0 (self-hosted bibliographic client)',
          ...(options.headers ?? {})
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });

      if (res.status === 429) {
        circuit.openUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        return null;
      }

      if (!res.ok) {
        circuit.failures++;
        if (circuit.failures >= FAILURE_TRIP_THRESHOLD) {
          circuit.openUntil = Date.now() + FAILURE_COOLDOWN_MS;
          circuit.failures = 0;
        }
        return null;
      }

      circuit.failures = 0;
      const text = await res.text();

      if (options.cacheKey && this.jobRepo) {
        const ttlSec = options.cacheTtlSec ?? 86400;
        const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
        this.jobRepo.setExternalCache(options.cacheKey, options.source, { text }, expiresAt);
      }

      return text;
    } catch {
      circuit.failures++;
      if (circuit.failures >= FAILURE_TRIP_THRESHOLD) {
        circuit.openUntil = Date.now() + FAILURE_COOLDOWN_MS;
        circuit.failures = 0;
      }
      return null;
    }
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
