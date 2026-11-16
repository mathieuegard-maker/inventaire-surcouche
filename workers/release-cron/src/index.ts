import type { AppBackendEnv } from '../../../src/core/adapters/storage-db.interface';
import {
  runCentralizedSeriesReleaseSweep,
  runHourlyDigestDispatch
} from '../../../src/core/services/series-digest.service';
import { sendWebPushNotification } from '../../../src/core/services/web-push.service';

interface CronEnv extends AppBackendEnv {
  CRON_TEST_TOKEN?: string;
}

export default {
  async scheduled(_event: unknown, env: CronEnv): Promise<void> {
    const sweepRes = await runCentralizedSeriesReleaseSweep(env.DB, {
      limit: 6,
      staleDays: 3
    });
    const digestRes = await runHourlyDigestDispatch(env.DB, env);
    console.log('[BIBLIO CRON]', JSON.stringify({ sweepRes, digestRes }));
  },

  async fetch(request: Request, env: CronEnv): Promise<Response> {
    const authHeader = request.headers.get('Authorization') || '';
    if (!env.CRON_TEST_TOKEN || authHeader !== `Bearer ${env.CRON_TEST_TOKEN}`) {
      return new Response('Forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    if (url.pathname !== '/test-push') {
      return new Response('Not Found', { status: 404 });
    }
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) {
      return Response.json({ error: 'VAPID non configuré' }, { status: 500 });
    }

    const subs = await env.DB.prepare(
      'SELECT id, user_id, endpoint, p256dh, auth FROM user_push_subscriptions'
    ).all<{ id: string; user_id: string; endpoint: string; p256dh: string; auth: string }>();

    const results = [];
    for (const sub of subs.results || []) {
      const pushRes = await sendWebPushNotification({
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        payload: {
          title: 'Biblio Collection — Test Nouveautés',
          body: '2 nouveaux tomes détectés (test) : Silo #2, Astérix #41',
          url: '/releases'
        },
        vapidPublicKey: env.VAPID_PUBLIC_KEY,
        vapidPrivateJwk: env.VAPID_PRIVATE_JWK,
        vapidSubject: env.VAPID_SUBJECT
      });
      results.push({ id: sub.id, ...pushRes });
    }

    return Response.json({ ok: true, sent: results.length, results });
  }
};
