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

  simulateDemoAlert(sample?: {
    seriesUri?: string;
    seriesTitle?: string;
    seriesNumber?: string;
    coverUrl?: string;
  }): SeriesReleaseAlert {
    const demo: SeriesReleaseAlert = {
      id: `demo:${Date.now()}`,
      seriesUri: sample?.seriesUri || 'demo:series',
      seriesTitle: sample?.seriesTitle || 'Astérix',
      volumeUri: 'isbn:9782012101524',
      volumeTitle: `${sample?.seriesTitle || 'Astérix'} — Nouvel album (Simulation)`,
      seriesNumber: sample?.seriesNumber || '41',
      isbn13: '9782012101524',
      coverUrl: sample?.coverUrl,
      detectedAt: new Date().toISOString()
    };
    alerts.value = [demo, ...alerts.value.filter((a) => !a.id.startsWith('demo:'))];
    return demo;
  }
};
