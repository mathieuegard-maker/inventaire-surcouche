import type { AppBackendEnv } from '../../../src/core/adapters/storage-db.interface';
import {
  runCentralizedSeriesReleaseSweep,
  runHourlyDigestDispatch
} from '../../../src/core/services/series-digest.service';

export default {
  async scheduled(_event: unknown, env: AppBackendEnv): Promise<void> {
    const sweepRes = await runCentralizedSeriesReleaseSweep(env.DB, {
      limit: 6,
      staleDays: 3
    });
    const digestRes = await runHourlyDigestDispatch(env.DB, env);
    console.log('[BIBLIO CRON]', JSON.stringify({ sweepRes, digestRes }));
  }
};
