// src/core/services/series-release.service.ts
import { ref } from 'vue';
import { connectionState, fetchWithTimeout } from '../../state/connection';

export interface SeriesReleaseAlert {
  id: string;
  seriesUri: string;
  seriesTitle: string;
  volumeUri: string;
  volumeTitle: string;
  seriesNumber?: string;
  isbn13?: string;
  coverUrl?: string;
  detectedAt: string;
}

const LAST_CHECK_STORAGE_KEY = 'biblio_series_release_last_check';
const CHECK_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 heures

const alerts = ref<SeriesReleaseAlert[]>([]);
const isChecking = ref(false);

function readLastCheck(): number {
  try {
    if (typeof localStorage === 'undefined') return 0;
    const raw = localStorage.getItem(LAST_CHECK_STORAGE_KEY);
    const num = raw ? Number(raw) : 0;
    return Number.isFinite(num) ? num : 0;
  } catch {
    return 0;
  }
}

function writeLastCheck(ts: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LAST_CHECK_STORAGE_KEY, String(ts));
  } catch {
    // ignore storage quota errors
  }
}

export const seriesReleaseService = {
  alerts,
  isChecking,

  async checkNewReleasesOnOpen(force = false): Promise<SeriesReleaseAlert[]> {
    if (connectionState.isOffline.value || isChecking.value) {
      return alerts.value;
    }

    const now = Date.now();
    const lastCheck = readLastCheck();
    const shouldCheckRemote = force || now - lastCheck >= CHECK_COOLDOWN_MS;

    isChecking.value = true;
    try {
      const res = await fetchWithTimeout('/api/gateway?action=series-check-releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          limit: shouldCheckRemote ? 3 : 0,
          staleDays: 7
        }),
        timeout: 15000
      });
      if (!res.ok) return alerts.value;
      const data = await res.json();
      if (Array.isArray(data?.alerts)) {
        alerts.value = data.alerts;
      }
      if (shouldCheckRemote) {
        writeLastCheck(now);
      }
      return alerts.value;
    } catch {
      return alerts.value;
    } finally {
      isChecking.value = false;
    }
  },

  async dismissAlert(alertId?: string): Promise<void> {
    const previous = [...alerts.value];
    if (alertId) {
      alerts.value = alerts.value.filter((a) => a.id !== alertId);
      if (alertId.startsWith('demo:')) return;
    } else {
      const hadOnlyDemo = alerts.value.every((a) => a.id.startsWith('demo:'));
      alerts.value = [];
      if (hadOnlyDemo) return;
    }

    try {
      await fetchWithTimeout('/api/gateway?action=series-dismiss-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alertId ? { alertId } : { dismissAll: true })
      });
    } catch {
      alerts.value = previous;
    }
  },

  simulateDemoAlerts(
    samples?: Array<{
      seriesUri?: string;
      seriesTitle?: string;
      seriesNumber?: string;
      coverUrl?: string;
      isbn13?: string;
      volumeTitle?: string;
    }>
  ): SeriesReleaseAlert[] {
    const defaults = [
      {
        seriesUri: 'demo:asterix',
        seriesTitle: 'Astérix',
        seriesNumber: '41',
        volumeTitle: 'Astérix en Lusitanie (Simulation)',
        isbn13: '9782012101524'
      },
      {
        seriesUri: 'demo:thorgal',
        seriesTitle: 'Thorgal',
        seriesNumber: '42',
        volumeTitle: 'Ozurr le Varègue (Simulation)',
        isbn13: '9782803613625'
      },
      {
        seriesUri: 'demo:blacksad',
        seriesTitle: 'Blacksad',
        seriesNumber: '8',
        volumeTitle: 'Alors, tout tombe — Partie 3 (Simulation)',
        isbn13: '9782205054194'
      },
      {
        seriesUri: 'demo:tintin',
        seriesTitle: 'Les Aventures de Tintin',
        seriesNumber: '25',
        volumeTitle: 'L’Alph-Art — Édition spéciale (Simulation)',
        isbn13: '9782203001107'
      },
      {
        seriesUri: 'demo:luckyluke',
        seriesTitle: 'Lucky Luke',
        seriesNumber: '84',
        volumeTitle: 'Un cow-boy sous pression (Simulation)',
        isbn13: '9782884714938'
      }
    ];

    const list: Array<{
      seriesUri?: string;
      seriesTitle?: string;
      seriesNumber?: string;
      coverUrl?: string;
      isbn13?: string;
      volumeTitle?: string;
    }> = samples && samples.length > 0 ? samples : defaults;
    const nowIso = new Date().toISOString();
    const created: SeriesReleaseAlert[] = list.map((item, idx) => ({
      id: `demo:${Date.now()}_${idx}`,
      seriesUri: item.seriesUri || `demo:series_${idx}`,
      seriesTitle: item.seriesTitle || `Série ${idx + 1}`,
      volumeUri: item.isbn13 ? `isbn:${item.isbn13}` : `demo:vol_${idx}`,
      volumeTitle: item.volumeTitle || `${item.seriesTitle || 'Nouveau tome'} (Simulation)`,
      seriesNumber: item.seriesNumber || String(idx + 1),
      isbn13: item.isbn13,
      coverUrl: item.coverUrl,
      detectedAt: nowIso
    }));

    alerts.value = [...created, ...alerts.value.filter((a) => !a.id.startsWith('demo:'))];
    return created;
  },

  simulateDemoAlert(sample?: {
    seriesUri?: string;
    seriesTitle?: string;
    seriesNumber?: string;
    coverUrl?: string;
  }): SeriesReleaseAlert {
    return this.simulateDemoAlerts([sample || {}])[0];
  }
};
