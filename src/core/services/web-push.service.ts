// src/core/services/web-push.service.ts
// Envoi Web Push (VAPID ES256 + chiffrement RFC 8291 aes128gcm) en Web Crypto pur (Cloudflare Workers / Node).

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hkdfExpand(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as unknown as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as unknown as BufferSource,
      info: info as unknown as BufferSource
    },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

export async function createVapidAuthHeader(
  endpoint: string,
  vapidPublicKey: string,
  vapidPrivateJwkJson: string,
  subject = 'mailto:noreply@biblio-collection.local'
): Promise<string> {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;

  const enc = new TextEncoder();
  const headerB64 = toBase64Url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payloadB64 = toBase64Url(enc.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const signingInput = `${headerB64}.${payloadB64}`;

  const jwk = JSON.parse(vapidPrivateJwkJson) as JsonWebKey;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      enc.encode(signingInput)
    )
  );

  const jwt = `${signingInput}.${toBase64Url(signature)}`;
  return `vapid t=${jwt}, k=${vapidPublicKey}`;
}

export async function encryptWebPushPayload(
  payloadText: string,
  clientPublicKeyB64Url: string,
  clientAuthSecretB64Url: string
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const plaintext = enc.encode(payloadText);

  const uaPublicBytes = fromBase64Url(clientPublicKeyB64Url);
  const authSecret = fromBase64Url(clientAuthSecretB64Url);

  const uaPublicKey = await crypto.subtle.importKey(
    'raw',
    uaPublicBytes as unknown as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  const localKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )) as CryptoKeyPair;

  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey));
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaPublicKey },
      localKeyPair.privateKey,
      256
    )
  );

  // RFC 8291 Section 3.3
  const keyInfo = concatBytes(enc.encode('WebPush: info\x00'), uaPublicBytes, asPublicBytes);
  const ikm = await hkdfExpand(sharedSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfExpand(ikm, salt, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdfExpand(ikm, salt, enc.encode('Content-Encoding: nonce\x00'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek as unknown as BufferSource, 'AES-GCM', false, ['encrypt']);
  const paddedRecord = concatBytes(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
      aesKey,
      paddedRecord as unknown as BufferSource
    )
  );

  // RFC 8188 aes128gcm header: salt (16) || rs (4, BE) || idlen (1) || keyid (65)
  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, 4096, false);
  const idLenBytes = new Uint8Array([asPublicBytes.length]);

  return concatBytes(salt, rsBytes, idLenBytes, asPublicBytes, ciphertext);
}

export async function sendWebPushNotification(params: {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: Record<string, unknown>;
  vapidPublicKey: string;
  vapidPrivateJwk: string;
  vapidSubject?: string;
}): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const authHeader = await createVapidAuthHeader(
    params.endpoint,
    params.vapidPublicKey,
    params.vapidPrivateJwk,
    params.vapidSubject
  );
  const body = await encryptWebPushPayload(
    JSON.stringify(params.payload),
    params.p256dh,
    params.auth
  );

  const res = await fetch(params.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400'
    },
    body: body as unknown as BodyInit
  });

  return {
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410
  };
}
