<!-- src/client/components/base/ActivityBanner.vue -->
<!-- Bandeau fixe unique intégré juste sous l'en-tête « Ma bibliothèque cloud » :
     affiche tous les traitements en cours (Photo IA, Import, Enrichissement, Ajout en lot),
     l'état hors-ligne et les retours/erreurs (remplace les toasts flottants). -->
<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircle, CheckCircle2, Info, Loader2, WifiOff, X } from '@lucide/vue';
import { useAuthStore } from '../../stores/auth.store';
import { useJobsStore } from '../../stores/jobs.store';
import { useUiStore } from '../../stores/ui.store';
import { t } from '../../../shared/locales';

const authStore = useAuthStore();
const jobsStore = useJobsStore();
const uiStore = useUiStore();

const latestToast = computed(() => {
  const list = uiStore.toasts;
  return list.length > 0 ? list[list.length - 1] : null;
});

interface BannerItem {
  kind: 'offline' | 'toast' | 'job';
  tone: 'info' | 'success' | 'warning' | 'danger';
  text: string;
  to?: string;
  spinning?: boolean;
  toastId?: number;
}

const activeBanner = computed<BannerItem | null>(() => {
  if (uiStore.isOffline) {
    return {
      kind: 'offline',
      tone: 'warning',
      text: t('app.offlineBanner')
    };
  }

  // Priorité aux erreurs critiques ponctuelles
  if (latestToast.value && (latestToast.value.type === 'danger' || latestToast.value.type === 'warning')) {
    return {
      kind: 'toast',
      tone: latestToast.value.type,
      text: latestToast.value.message,
      toastId: latestToast.value.id
    };
  }

  if (authStore.isAuthenticated) {
    // 1. Ajout Photo IA en cours
    const commitJob = jobsStore.activePhotoCommitJob;
    if (commitJob) {
      return {
        kind: 'job',
        tone: 'success',
        spinning: true,
        to: '/scan?tab=photo',
        text: t('scan.photoCommitRunning', {
          done: commitJob.progressDone,
          total: Math.max(1, commitJob.progressTotal)
        })
      };
    }

    // 2. Photo IA en cours ou prête à valider (uniquement les lots non archivés)
    const photoJob = jobsStore.latestPhotoJob;
    if (photoJob) {
      const activeCount = jobsStore.activePhotoJobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
      if (photoJob.status === 'pending' || photoJob.status === 'running') {
        return {
          kind: 'job',
          tone: 'success',
          spinning: true,
          to: '/scan?tab=photo',
          text:
            activeCount > 1
              ? t('scan.photoBannerRunningMulti', {
                  count: activeCount,
                  done: photoJob.progressDone,
                  total: Math.max(1, photoJob.progressTotal)
                })
              : t('scan.photoBannerRunning', {
                  done: photoJob.progressDone,
                  total: Math.max(1, photoJob.progressTotal)
                })
        };
      }
      if (photoJob.status === 'done') {
        return {
          kind: 'job',
          tone: 'success',
          to: '/scan?tab=photo',
          text: t('scan.photoBannerDone', {
            done: photoJob.progressDone,
            total: Math.max(1, photoJob.progressTotal)
          })
        };
      }
    }

    // 3. Import collection en cours
    const importJob = jobsStore.activeCollectionImportJob;
    if (importJob) {
      return {
        kind: 'job',
        tone: 'success',
        spinning: true,
        to: '/profile',
        text: t('profile.importRunning', {
          done: importJob.progressDone,
          total: Math.max(1, importJob.progressTotal)
        })
      };
    }

    // 4. Enrichissement / expansion / couvertures de série en cours
    const seriesJob = jobsStore.activeSeriesEnrichJob;
    if (seriesJob && (seriesJob.status === 'running' || seriesJob.status === 'pending')) {
      const total = Math.max(1, seriesJob.progressTotal);
      return {
        kind: 'job',
        tone: 'success',
        spinning: seriesJob.status === 'running',
        to: seriesJob.targetSeriesId ? `/series/${seriesJob.targetSeriesId}` : undefined,
        text:
          seriesJob.status === 'running'
            ? t('app.seriesEnrichBanner', { done: seriesJob.progressDone, total })
            : t('app.seriesEnrichQueuedBanner', { total })
      };
    }
  }

  // 5. Messages ponctuels info / succès intégrés sous le header (jamais en overlay flottant)
  if (latestToast.value) {
    return {
      kind: 'toast',
      tone: latestToast.value.type,
      text: latestToast.value.message,
      toastId: latestToast.value.id
    };
  }

  return null;
});
</script>

<template>
  <div
    v-if="activeBanner"
    class="activity-banner"
    :class="`activity-banner--${activeBanner.tone}`"
    role="status"
    aria-live="polite"
  >
    <component
      :is="activeBanner.to ? 'router-link' : 'div'"
      :to="activeBanner.to"
      class="activity-banner__body"
    >
      <WifiOff v-if="activeBanner.kind === 'offline'" :size="15" aria-hidden="true" class="activity-banner__icon" />
      <Loader2
        v-else-if="activeBanner.spinning"
        :size="15"
        aria-hidden="true"
        class="activity-banner__icon activity-banner__spin"
      />
      <AlertCircle
        v-else-if="activeBanner.tone === 'danger' || activeBanner.tone === 'warning'"
        :size="15"
        aria-hidden="true"
        class="activity-banner__icon"
      />
      <CheckCircle2
        v-else-if="activeBanner.tone === 'success'"
        :size="15"
        aria-hidden="true"
        class="activity-banner__icon"
      />
      <Info v-else :size="15" aria-hidden="true" class="activity-banner__icon" />

      <span class="activity-banner__text">{{ activeBanner.text }}</span>
    </component>

    <button
      v-if="activeBanner.toastId !== undefined"
      type="button"
      class="activity-banner__close"
      :aria-label="t('app.close')"
      @click="uiStore.dismissToast(activeBanner.toastId)"
    >
      <X :size="15" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.activity-banner {
  position: sticky;
  top: calc(var(--header-height) + env(safe-area-inset-top, 0px));
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0.48rem var(--space-3);
  font-size: 0.84rem;
  font-weight: 600;
  border-bottom: 1px solid var(--border-subtle);
}

.activity-banner--success {
  background: var(--success-bg);
  color: var(--success-text);
}

.activity-banner--info {
  background: var(--accent-soft);
  color: var(--accent);
}

.activity-banner--warning {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.activity-banner--danger {
  background: var(--danger-soft);
  color: var(--danger);
}

.activity-banner__body {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-inline-size: 0;
  color: inherit;
  text-decoration: none;
  text-align: center;
}

.activity-banner__body:hover {
  text-decoration: none;
}

.activity-banner__text {
  line-height: 1.3;
}

.activity-banner__icon {
  flex-shrink: 0;
}

.activity-banner__spin {
  animation: activity-spin 1s linear infinite;
}

.activity-banner__close {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 28px;
  min-block-size: 28px;
  border-radius: var(--radius-pill);
  opacity: 0.8;
}

.activity-banner__close:hover {
  opacity: 1;
}

@keyframes activity-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
