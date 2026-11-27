// src/server/routes/contact.test.ts
// Tests d'intégration du formulaire de contact (/api/contact) et du connecteur mail unifié (SMTP / Resend / fallback).

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../db/sqlite.adapter';
import { applySqlMigrations } from '../db/migrator';
import { loadServerConfig } from '../config';
import { createApp } from '../app';
import { createMailConnector } from '../connectors/mail.connector';
import type { MailMessage, MailSender } from '../connectors/resend.connector';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

describe('POST /api/contact & connecteur mail unifié (v2.8.0)', () => {
  let db: SqliteDatabaseAdapter;
  let sentEmails: MailMessage[];
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    sentEmails = [];
    const mockMailSender: MailSender = {
      async sendEmail(msg) {
        sentEmails.push(msg);
        return { sent: true, providerId: `mock_${sentEmails.length}` };
      }
    };
    const config = loadServerConfig({
      NODE_ENV: 'test',
      ADMIN_EMAIL: 'admin@mabibliocloud.fr',
      CONTACT_EMAIL: 'contact@mabibliocloud.fr',
      JWT_SECRET: 'test-secret-contact',
      CRON_ENABLED: 'false'
    });
    ctx = createApp({ db, config, mailSender: mockMailSender });
  });

  afterEach(() => {
    db.close();
  });

  it('transmet un message anonyme depuis /login avec replyTo et échappement HTML anti-XSS', async () => {
    const res = await ctx.app.request('/api/contact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.10'
      },
      body: JSON.stringify({
        email: 'proche@exemple.fr',
        senderName: 'Marc <script>',
        category: 'bug',
        subject: 'Impossible de me connecter',
        message: 'Bonjour, j’ai une erreur <img src=x onerror=alert(1)> sur mon téléphone.',
        pageUrl: '/login'
      })
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; delivered: boolean };
    expect(json.ok).toBe(true);
    expect(json.delivered).toBe(true);
    expect(sentEmails).toHaveLength(1);

    const mail = sentEmails[0];
    expect(mail.to).toBe('contact@mabibliocloud.fr');
    expect(mail.replyTo).toBe('proche@exemple.fr');
    expect(mail.subject).toContain('Signalement de bug');
    expect(mail.subject).toContain('Impossible de me connecter');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('/login');
  });

  it('enrichit automatiquement le contexte avec le compte connecté', async () => {
    const regRes = await ctx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'roland',
        email: 'roland@exemple.fr',
        password: 'Password123!',
        gdprAccepted: true
      })
    });
    expect(regRes.status).toBe(201);
    const cookie = extractCookie(regRes);

    const res = await ctx.app.request('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        email: 'roland@exemple.fr',
        category: 'suggestion',
        message: 'Super application, une idée pour la page de collection !',
        pageUrl: '/profile'
      })
    });
    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].html).toContain('roland');
    expect(sentEmails[0].html).toContain('Connecté');
    expect(sentEmails[0].replyTo).toBe('roland@exemple.fr');
  });

  it('ignore silencieusement les soumissions honeypot sans envoyer d’e-mail et applique le rate-limit (429)', async () => {
    // 1. Honeypot rempli -> 200 silencieux, 0 mail envoyé
    const spamRes = await ctx.app.request('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
      body: JSON.stringify({
        email: 'bot@spam.test',
        category: 'other',
        message: 'Achetez mes produits pas chers ici maintenant !',
        website: 'https://spam.example'
      })
    });
    expect(spamRes.status).toBe(200);
    expect(sentEmails).toHaveLength(0);

    // 2. Rate-limit : 3 envois autorisés puis 429 au 4e dans la fenêtre
    for (let i = 1; i <= 3; i++) {
      const okRes = await ctx.app.request('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.99' },
        body: JSON.stringify({
          email: 'user@exemple.fr',
          category: 'question',
          message: `Message légitime numéro ${i} suffisamment long.`
        })
      });
      expect(okRes.status).toBe(200);
    }
    expect(sentEmails).toHaveLength(3);

    const limitedRes = await ctx.app.request('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.99' },
      body: JSON.stringify({
        email: 'user@exemple.fr',
        category: 'question',
        message: 'Quatrième message trop rapproché qui doit être limité.'
      })
    });
    expect(limitedRes.status).toBe(429);
    expect(sentEmails).toHaveLength(3);
  });

  it('sélectionne correctement le mode de repli console quand ni SMTP ni Resend ne sont configurés', async () => {
    const emptyCfg = loadServerConfig({ NODE_ENV: 'test' });
    const sender = createMailConnector(emptyCfg);
    const result = await sender.sendEmail({
      to: 'test@exemple.fr',
      subject: 'Test fallback',
      html: '<p>Test</p>'
    });
    expect(result.sent).toBe(false);
  });
});
