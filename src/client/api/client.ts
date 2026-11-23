// src/client/api/client.ts
// Client HTTP centralisé V2 : cookie HttpOnly automatique, gestion erreurs structurées et détection offline.

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);

  try {
    const res = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    const data = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    } & T;

    if (!res.ok) {
      throw new ApiClientError(
        res.status,
        data?.error?.code || 'HTTP_ERROR',
        data?.error?.message || `Erreur HTTP ${res.status}`
      );
    }

    return data;
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Serveur inaccessible ou connexion interrompue.');
  } finally {
    clearTimeout(timeout);
  }
}
