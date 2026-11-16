import { describe, it, expect } from 'vitest';
import { shouldSendDigestNow, type NotificationPrefRow } from './series-digest.service';
import { createVapidAuthHeader, encryptWebPushPayload } from './web-push.service';

describe('series-digest.service', () => {
  const basePref: NotificationPrefRow = {
    user_id: 'usr_1',
    digest_frequency: 'daily',
    digest_hour: 9,
    digest_weekday: 6,
    digest_day_of_month: 1,
    digest_timezone: 'Europe/Paris',
    digest_channel: 'push',
    last_notified_at: null
  };

  it('ne notifie pas quand digest_frequency = off', () => {
    const res = shouldSendDigestNow(
      { ...basePref, digest_frequency: 'off' },
      new Date('2026-11-16T08:15:00Z')
    );
    expect(res).toBe(false);
  });

  it('notifie à l’heure locale Europe/Paris exacte pour daily et évite le doublon le même jour', () => {
    // En novembre (hiver UTC+1), 08:10 UTC = 09:10 Europe/Paris
    const atNineParis = new Date('2026-11-16T08:10:00Z');
    expect(shouldSendDigestNow(basePref, atNineParis)).toBe(true);

    // Déjà notifié ce même jour local
    expect(
      shouldSendDigestNow(
        { ...basePref, last_notified_at: '2026-11-16T08:01:00Z' },
        atNineParis
      )
    ).toBe(false);

    // Mauvaise heure (10h Paris)
    expect(shouldSendDigestNow(basePref, new Date('2026-11-16T09:10:00Z'))).toBe(false);
  });

  it('respecte le jour de la semaine pour weekly et le jour du mois pour monthly', () => {
    // 2026-11-21 est un samedi (weekday = 6)
    const satNineParis = new Date('2026-11-21T08:05:00Z');
    expect(
      shouldSendDigestNow({ ...basePref, digest_frequency: 'weekly', digest_weekday: 6 }, satNineParis)
    ).toBe(true);
    expect(
      shouldSendDigestNow({ ...basePref, digest_frequency: 'weekly', digest_weekday: 1 }, satNineParis)
    ).toBe(false);

    // 2026-12-01 est le 1er du mois
    const firstNineParis = new Date('2026-12-01T08:05:00Z');
    expect(
      shouldSendDigestNow(
        { ...basePref, digest_frequency: 'monthly', digest_day_of_month: 1 },
        firstNineParis
      )
    ).toBe(true);
  });
});

describe('web-push.service', () => {
  it('chiffre un payload aes128gcm et signe un en-tête VAPID ES256', async () => {
    const serverPair = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    )) as CryptoKeyPair;
    const rawClientPub = new Uint8Array(await crypto.subtle.exportKey('raw', serverPair.publicKey));
    const toB64Url = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const encrypted = await encryptWebPushPayload(
      JSON.stringify({ title: 'Test', body: 'Nouveau tome' }),
      toB64Url(rawClientPub),
      toB64Url(authSecret)
    );
    expect(encrypted.length).toBeGreaterThan(86);

    const signPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const privJwk = await crypto.subtle.exportKey('jwk', signPair.privateKey);
    const header = await createVapidAuthHeader(
      'https://fcm.googleapis.com/fcm/send/test',
      'BTestPub',
      JSON.stringify(privJwk)
    );
    expect(header.startsWith('vapid t=')).toBe(true);
    expect(header).toContain(', k=BTestPub');
  });
});
