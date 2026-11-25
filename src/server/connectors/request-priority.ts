// src/server/connectors/request-priority.ts
// Ordonnanceur réseau prioritaire par domaine externe (HIGH interactif > LOW tâche de fond)
// avec régulation de débit, limitation de concurrence par domaine et contexte AsyncLocalStorage.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SourceName } from './types';

export type RequestPriority = 'high' | 'low';

export type RateLimitDomain = SourceName | 'itunes' | 'covers_cdn';

export interface DomainPolicy {
  maxConcurrency: number;
  defaultMinIntervalMs: number;
}

const DEFAULT_DOMAIN_POLICIES: Record<RateLimitDomain, DomainPolicy> = {
  bnf: { maxConcurrency: 2, defaultMinIntervalMs: 250 },
  sudoc: { maxConcurrency: 2, defaultMinIntervalMs: 120 },
  inventaire: { maxConcurrency: 2, defaultMinIntervalMs: 180 },
  wikidata: { maxConcurrency: 2, defaultMinIntervalMs: 250 },
  google_books: { maxConcurrency: 1, defaultMinIntervalMs: 300 },
  openlibrary: { maxConcurrency: 3, defaultMinIntervalMs: 100 },
  // Apple Books / iTunes limite à ~20 req/min : 3,2 s d'intervalle + 1 seule requête simultanée -> zéro 403/429 en rafale !
  itunes: { maxConcurrency: 1, defaultMinIntervalMs: 3200 },
  covers_cdn: { maxConcurrency: 4, defaultMinIntervalMs: 0 }
};

const priorityStorage = new AsyncLocalStorage<RequestPriority>();

export function runWithRequestPriority<T>(priority: RequestPriority, fn: () => T): T {
  return priorityStorage.run(priority, fn);
}

export function getCurrentRequestPriority(): RequestPriority {
  return priorityStorage.getStore() ?? 'high';
}

interface QueuedEntry {
  minIntervalMs: number;
  run: () => void;
}

interface DomainQueueState {
  running: number;
  nextAllowedAt: number;
  highQueue: QueuedEntry[];
  lowQueue: QueuedEntry[];
  wakeTimer: ReturnType<typeof setTimeout> | null;
}

export class PriorityRateLimiter {
  private readonly domains = new Map<RateLimitDomain, DomainQueueState>();
  private readonly policies: Record<RateLimitDomain, DomainPolicy>;
  private readonly bypassTiming: boolean;

  constructor(options?: {
    policies?: Partial<Record<RateLimitDomain, Partial<DomainPolicy>>>;
    /** En mode mock/tests unitaires, ignore les délais calendaires (conserve priorité & concurrence). */
    bypassTiming?: boolean;
  }) {
    this.bypassTiming = Boolean(options?.bypassTiming);
    this.policies = { ...DEFAULT_DOMAIN_POLICIES };
    if (options?.policies) {
      for (const [k, v] of Object.entries(options.policies)) {
        const key = k as RateLimitDomain;
        if (v && this.policies[key]) {
          this.policies[key] = { ...this.policies[key], ...v };
        }
      }
    }
  }

  private getState(domain: RateLimitDomain): DomainQueueState {
    let state = this.domains.get(domain);
    if (!state) {
      state = {
        running: 0,
        nextAllowedAt: 0,
        highQueue: [],
        lowQueue: [],
        wakeTimer: null
      };
      this.domains.set(domain, state);
    }
    return state;
  }

  /**
   * Repousse la prochaine fenêtre autorisée d'un domaine (ex. après un HTTP 429 ou 403 rate-limit).
   */
  pushBackoff(domain: RateLimitDomain, delayMs: number): void {
    const state = this.getState(domain);
    if (this.bypassTiming) return;
    const until = Date.now() + Math.max(0, delayMs);
    if (until > state.nextAllowedAt) {
      state.nextAllowedAt = until;
    }
  }

  /**
   * Indique si le domaine est actuellement sous backoff significatif (> 1 s).
   */
  getRemainingBackoffMs(domain: RateLimitDomain): number {
    const state = this.getState(domain);
    return Math.max(0, state.nextAllowedAt - Date.now());
  }

  private pump(domain: RateLimitDomain): void {
    const state = this.getState(domain);
    const policy = this.policies[domain];

    while (state.running < policy.maxConcurrency) {
      const nextEntry = state.highQueue.length > 0 ? state.highQueue[0] : state.lowQueue[0];
      if (!nextEntry) break;

      const now = Date.now();
      const waitMs = this.bypassTiming ? 0 : Math.max(0, state.nextAllowedAt - now);
      if (waitMs > 0) {
        if (!state.wakeTimer) {
          state.wakeTimer = setTimeout(() => {
            state.wakeTimer = null;
            this.pump(domain);
          }, waitMs);
          if (typeof state.wakeTimer.unref === 'function') {
            state.wakeTimer.unref();
          }
        }
        return;
      }

      const entry = state.highQueue.length > 0 ? state.highQueue.shift()! : state.lowQueue.shift()!;
      state.running++;
      const effectiveInterval = this.bypassTiming ? 0 : entry.minIntervalMs;
      if (effectiveInterval > 0) {
        state.nextAllowedAt = Math.max(now, state.nextAllowedAt) + effectiveInterval;
      }
      entry.run();
    }
  }

  /**
   * Planifie une opération réseau sur un domaine externe en respectant :
   * 1. La priorité (`high` interactif passe systématiquement devant `low` tâche de fond)
   * 2. La concurrence maximale du domaine
   * 3. L'intervalle minimum entre requêtes et le backoff éventuel.
   */
  schedule<T>(
    domain: RateLimitDomain,
    task: () => Promise<T>,
    options?: { priority?: RequestPriority; minIntervalMs?: number }
  ): Promise<T> {
    const state = this.getState(domain);
    const policy = this.policies[domain];
    const priority = options?.priority ?? getCurrentRequestPriority();
    const minIntervalMs =
      options?.minIntervalMs !== undefined
        ? Math.max(options.minIntervalMs, policy.defaultMinIntervalMs)
        : policy.defaultMinIntervalMs;

    return new Promise<T>((resolve, reject) => {
      const entry: QueuedEntry = {
        minIntervalMs,
        run: () => {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              state.running = Math.max(0, state.running - 1);
              this.pump(domain);
            });
        }
      };

      if (priority === 'high') {
        state.highQueue.push(entry);
      } else {
        state.lowQueue.push(entry);
      }

      this.pump(domain);
    });
  }
}
