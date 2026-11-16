import { describe, it, expect, vi, beforeEach } from 'vitest';
import { seriesReleaseService } from './series-release.service';
import { connectionState } from '../../state/connection';

describe('seriesReleaseService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    connectionState.isOffline.value = false;
    seriesReleaseService.alerts.value = [];
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; }
    });
  });

  it('vérifie les nouveautés au premier lancement puis respecte le cooldown de 12h (limit=0)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        checkedCount: 2,
        alerts: [
          {
            id: 'lib_1:isbn:9782012101524',
            seriesUri: 'inv:s1',
            seriesTitle: 'Astérix',
            volumeUri: 'isbn:9782012101524',
            volumeTitle: 'L’Iris blanc',
            seriesNumber: '40',
            isbn13: '9782012101524',
            detectedAt: '2026-11-16T18:00:00Z'
          }
        ]
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await seriesReleaseService.checkNewReleasesOnOpen();
    expect(first).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit).toBe(3);

    await seriesReleaseService.checkNewReleasesOnOpen();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).limit).toBe(0);
  });

  it('masque immédiatement une alerte et appelle series-dismiss-alert', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true })
    });
    vi.stubGlobal('fetch', fetchMock);

    seriesReleaseService.alerts.value = [
      {
        id: 'a1',
        seriesUri: 'inv:s1',
        seriesTitle: 'Thorgal',
        volumeUri: 'inv:w1',
        volumeTitle: 'Tome 42',
        detectedAt: '2026-11-16T18:00:00Z'
      }
    ];

    await seriesReleaseService.dismissAlert('a1');
    expect(seriesReleaseService.alerts.value).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/gateway?action=series-dismiss-alert',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ alertId: 'a1' })
      })
    );
  });

  it('génère et masque une alerte de simulation sans appeler le serveur', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const demo = seriesReleaseService.simulateDemoAlert({
      seriesTitle: 'Blacksad',
      seriesNumber: '8'
    });
    expect(demo.id.startsWith('demo:')).toBe(true);
    expect(seriesReleaseService.alerts.value).toHaveLength(1);

    await seriesReleaseService.dismissAlert(demo.id);
    expect(seriesReleaseService.alerts.value).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const multi = seriesReleaseService.simulateDemoAlerts();
    expect(multi.length).toBeGreaterThanOrEqual(5);
    await seriesReleaseService.dismissAlert();
    expect(seriesReleaseService.alerts.value).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
