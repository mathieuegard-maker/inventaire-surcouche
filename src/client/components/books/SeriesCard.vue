<!-- src/client/components/books/SeriesCard.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { SeriesView } from '../../../shared/types/domain.types';
import { t } from '../../../shared/locales';

const props = defineProps<{
  series: SeriesView;
}>();

const emit = defineEmits<{
  (e: 'open', seriesId: string): void;
}>();

const progressPercent = computed(() => {
  const total = Math.max(1, props.series.knownVolumesCount);
  return Math.min(100, Math.round((props.series.ownedCount / total) * 100));
});
</script>

<template>
  <article class="series-card" @click="emit('open', series.id)">
    <div class="series-card__cover">
      <img v-if="series.coverUrl" :src="series.coverUrl" :alt="series.canonicalName" loading="lazy" />
      <div v-else class="series-card__placeholder">
        <span>{{ series.canonicalName.slice(0, 2).toUpperCase() }}</span>
      </div>
    </div>

    <div class="series-card__body">
      <h3 class="series-card__title">{{ series.canonicalName }}</h3>
      <p v-if="series.primaryAuthors.length > 0" class="ds-text-muted">
        {{ series.primaryAuthors.slice(0, 2).join(', ') }}
      </p>
      <div class="series-card__progress-row">
        <span class="ds-badge ds-badge--accent">
          {{ t('collection.ownedProgress', { owned: series.ownedCount, total: series.knownVolumesCount }) }}
        </span>
      </div>
      <div class="series-card__bar" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
        <div class="series-card__bar-fill" :style="{ width: `${progressPercent}%` }" />
      </div>
    </div>
  </article>
</template>

<style scoped>
.series-card {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.series-card:hover {
  border-color: var(--accent);
}

.series-card__cover {
  flex: 0 0 60px;
  width: 60px;
  height: 86px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

.series-card__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.series-card__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: var(--text-muted);
}

.series-card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.series-card__title {
  font-size: 0.98rem;
  font-weight: 700;
  color: var(--text-primary);
}

.series-card__bar {
  height: 6px;
  width: 100%;
  border-radius: var(--radius-pill);
  background: var(--bg-elevated);
  overflow: hidden;
  margin-top: var(--space-1);
}

.series-card__bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: var(--radius-pill);
}
</style>
