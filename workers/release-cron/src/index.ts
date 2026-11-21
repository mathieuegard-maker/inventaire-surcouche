import type { AppBackendEnv } from '../../../src/core/adapters/storage-db.interface';
import { PipelineTracer, purgeOldPipelineLogs } from '../../../src/core/services/pipeline-logger.service';
import {
  runCentralizedSeriesReleaseSweep,
  runHourlyDigestDispatch
} from '../../../src/core/services/series-digest.service';
import {
  drainEnrichmentQueueBatch,
  runSilentEditionDiscoveryPass
} from '../../../src/core/services/v4-pipeline.service';
import { sendWebPushNotification } from '../../../src/core/services/web-push.service';

interface CronEnv extends AppBackendEnv {
  CRON_TEST_TOKEN?: string;
}

export default {
  async scheduled(_event: unknown, env: CronEnv): Promise<void> {
    const start = Date.now();
    const tracer = new PipelineTracer({ sourceChannel: 'cron_scheduled' });

    const queueRes = await drainEnrichmentQueueBatch(env.DB, 3).catch((err) => ({
      processed: 0,
      succeeded: 0,
      failed: 1,
      error: err instanceof Error ? err.message : String(err)
    }));
    const sweepRes = await runCentralizedSeriesReleaseSweep(env.DB, {
      limit: 4,
      staleDays: 3
    }).catch((err) => ({
      checkedSeries: 0,
      alertsCreated: 0,
      error: err instanceof Error ? err.message : String(err)
    }));
    const silentRes = await runSilentEditionDiscoveryPass(env.DB, 2).catch(() => ({
      checkedBooks: 0,
      newIsbnsIndexed: 0
    }));
    const digestRes = await runHourlyDigestDispatch(env.DB, env).catch((err) => ({
      evaluatedUsers: 0,
      notifiedUsers: 0,
      error: err instanceof Error ? err.message : String(err)
    }));
    const purgeRes = await purgeOldPipelineLogs(env.DB).catch(() => ({ deletedCount: 0 }));

    tracer.record(
      'CRON',
      'hourly_cron_sweep',
      'ok',
      `Queue C5: ${queueRes.succeeded}/${queueRes.processed} · Nouveautés: ${sweepRes.alertsCreated} · Éditions sœurs: +${silentRes.newIsbnsIndexed} ISBN`,
      { queueRes, sweepRes, silentRes, digestRes, purgeRes },
      Date.now() - start
    );
    await tracer.flush(env.DB);
    console.log('[BIBLIO CRON]', JSON.stringify({ queueRes, sweepRes, silentRes, digestRes, purgeRes }));
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
