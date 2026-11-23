// src/server/connectors/webpush.connector.ts
// Connecteur Web Push VAPID (ES256 JWT) isolé et 100 % mockable.

import crypto from 'node:crypto';

export interface WebPushSubscriptionTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushMessage {
  title: string;
  body: string;
  url?: string;
}

export interface WebPushSender {
  isConfigured(): boolean;
  sendNotification(
    target: WebPushSubscriptionTarget,
    message: WebPushMessage
  ): Promise<{ sent: boolean; gone?: boolean }>;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function buildVapidAuthHeader(
  endpoint: string,
  vapidSubject: string,
  vapidPublicKey: string,
  vapidPrivateJwk: string
): string | null {
  try {
    const origin = new URL(endpoint).origin;
    const jwk = JSON.parse(vapidPrivateJwk) as crypto.JsonWebKeyInput['key'];
    const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });

    const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const payload = base64url(
      JSON.stringify({
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: vapidSubject
      })
    );
    const unsigned = `${header}.${payload}`;
    const signature = crypto.sign('sha256', Buffer.from(unsigned), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363'
    });
    return `vapid t=${unsigned}.${base64url(signature)}, k=${vapidPublicKey}`;
  } catch {
    return null;
  }
}

export function createWebPushConnector(options: {
  vapidPublicKey: string;
  vapidPrivateJwk: string;
  vapidSubject: string;
  fetchImpl?: typeof fetch;
}): WebPushSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const configured = Boolean(options.vapidPublicKey && options.vapidPrivateJwk);

  return {
    isConfigured: () => configured,

    async sendNotification(target, message): Promise<{ sent: boolean; gone?: boolean }> {
      if (!configured) {
        return { sent: false };
      }

      const authHeader = buildVapidAuthHeader(
        target.endpoint,
        options.vapidSubject,
        options.vapidPublicKey,
        options.vapidPrivateJwk
      );
      if (!authHeader) return { sent: false };

      try {
        // Notification tickle (sans payload chiffré si clés client absentes, compatible SW push handler)
        const res = await fetchImpl(target.endpoint, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            TTL: '86400',
            'X-Biblio-Title': encodeURIComponent(message.title)
          },
          signal: AbortSignal.timeout(8000)
        });

        if (res.status === 404 || res.status === 410) {
          return { sent: false, gone: true };
        }
        return { sent: res.ok };
      } catch {
        return { sent: false };
      }
    }
  };
}
