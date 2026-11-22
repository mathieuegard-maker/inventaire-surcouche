<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BaseLoading from '../components/BaseLoading.vue';
import { TEXTS } from '../locales/fr';
import { statsService, type DetailedStats } from '../../core/services/stats.service';
import { scannerState } from '../../state/scanner';

const props = defineProps<{ embedded?: boolean }>();
const router = useRouter();
const stats = ref<DetailedStats | null>(null);
const selectedPeriod = ref(30);
const isLoading = ref(true);

const loadStats = async () => {
  isLoading.value = true;
  try {
    stats.value = await statsService.getDetailedStats(selectedPeriod.value);
  } catch (e) {
    console.error('[STATS VIEW] Erreur de chargement KPIs :', e);
  } finally {
    isLoading.value = false;
  }
};

onMounted(loadStats);
watch(() => scannerState.lastUpdatedTick.value, loadStats);

const maxGenreCount = computed(() => Math.max(1, ...(stats.value?.topGenres.map((g) => g.count) || [1])));
const maxAuthorCount = computed(() => Math.max(1, ...(stats.value?.topAuthors.map((a) => a.count) || [1])));
const totalReadingTracked = computed(() => {
  const rc = stats.value?.readingCounts;
  if (!rc) return 0;
  return rc.read + rc.reading + rc.to_read + rc.abandoned + rc.none;
});
</script>

<template>
  <div :class="props.embedded ? 'stats-embedded' : 'view-container'">
    <BaseHeader v-if="!props.embedded" />

    <div class="kpi-page-top">
      <BaseTitle v-if="!props.embedded" text="Statistiques" level="h2" />
      <h3 v-else class="stats-embedded-title">Statistiques</h3>
      <select v-model="selectedPeriod" @change="loadStats" class="wireframe-input kpi-period-select" aria-label="Période d'analyse">
        <option :value="30">{{ TEXTS.dashboardStats.period30 }}</option>
        <option :value="90">{{ TEXTS.dashboardStats.period90 }}</option>
        <option :value="365">{{ TEXTS.dashboardStats.period365 }}</option>
        <option :value="-1">{{ TEXTS.dashboardStats.periodAll }}</option>
      </select>
    </div>

    <BaseLoading v-if="isLoading" />

    <div v-else-if="!stats" class="kpi-empty-box">
      {{ TEXTS.dashboardStats.noData }}
    </div>

    <div v-else class="kpi-sections-stack">
      <!-- 1. Synthèse globale cliquable -->
      <section class="kpi-grid-4">
        <button type="button" class="stats-card card-owned kpi-btn-card" @click="router.push({ name: 'CollectionView', query: { mode: 'books' } })">
          <div class="stats-value">{{ stats.totalOwned }}</div>
          <div class="stats-label">{{ TEXTS.dashboardStats.totalOwned }}</div>
          <div class="kpi-sub-note">{{ stats.totalOneshots }} one-shot(s)</div>
        </button>

        <button type="button" class="stats-card card-series kpi-btn-card" @click="router.push({ name: 'CollectionView', query: { mode: 'series' } })">
          <div class="stats-value">{{ stats.totalSeries }}</div>
          <div class="stats-label">{{ TEXTS.dashboardStats.totalSeries }}</div>
          <div class="kpi-sub-note">{{ stats.completedSeriesCount }} complète(s) ({{ stats.seriesCompletionRate }}%)</div>
        </button>

        <button type="button" class="stats-card card-wishlist kpi-btn-card" @click="router.push({ name: 'WishlistView' })">
          <div class="stats-value">{{ stats.totalWishlist }}</div>
          <div class="stats-label">{{ TEXTS.dashboardStats.totalWishlist }}</div>
          <div class="kpi-sub-note">À acquérir</div>
        </button>

        <button type="button" class="stats-card card-loans kpi-btn-card" @click="router.push({ name: 'LoansView' })">
          <div class="stats-value">{{ stats.totalLoans }}</div>
          <div class="stats-label">Prêts en cours ({{ stats.loanRate }}%)</div>
          <div class="kpi-sub-note" :class="{ warn: stats.overdueLoansCount > 0 }">
            {{ stats.overdueLoansCount }} &gt; 30 jours
          </div>
        </button>
      </section>

      <!-- 2. Activité période, Lecture & Volume de pages -->
      <section class="kpi-grid-3">
        <div class="kpi-panel">
          <h3>Activité sur la période</h3>
          <div class="kpi-dual-metrics">
            <div>
              <div class="kpi-big-num">+{{ stats.acquiredInPeriod }}</div>
              <div class="kpi-small-lbl">Acquisitions</div>
            </div>
            <div>
              <div class="kpi-big-num">{{ stats.loansInPeriod }}</div>
              <div class="kpi-small-lbl">Prêts initiés</div>
            </div>
          </div>
        </div>

        <div class="kpi-panel">
          <h3>Lecture &amp; Évaluations</h3>
          <div class="kpi-reading-pills">
            <span class="kpi-pill read">Lus : {{ stats.readingCounts.read }}</span>
            <span class="kpi-pill reading">En cours : {{ stats.readingCounts.reading }}</span>
            <span class="kpi-pill todo">À lire : {{ stats.readingCounts.to_read }}</span>
            <span class="kpi-pill none">Non classés : {{ stats.readingCounts.none }}</span>
          </div>
          <div v-if="stats.ratedCount > 0" class="kpi-foot-note">
            Note moyenne : <strong>{{ stats.averageRating }}/5</strong> ({{ stats.ratedCount }} livre(s) noté(s))
          </div>
          <div v-else-if="totalReadingTracked > 0" class="kpi-foot-note">
            {{ stats.readingCounts.abandoned }} abandonné(s)
          </div>
        </div>

        <div class="kpi-panel">
          <h3>Volume éditorial estimé</h3>
          <div class="kpi-dual-metrics">
            <div>
              <div class="kpi-big-num">{{ stats.totalPagesOwned.toLocaleString('fr-FR') }}</div>
              <div class="kpi-small-lbl">Pages cumulées</div>
            </div>
            <div>
              <div class="kpi-big-num">{{ stats.averagePages }}</div>
              <div class="kpi-small-lbl">Pages / livre</div>
            </div>
          </div>
        </div>
      </section>

      <!-- 3. Top Genres & Top Auteurs avec barres proportionnelles -->
      <section class="kpi-grid-2">
        <div class="kpi-panel">
          <h3>Répartition par genres (Top 10)</h3>
          <ul v-if="stats.topGenres.length" class="kpi-bar-list">
            <li v-for="g in stats.topGenres" :key="g.name" class="kpi-bar-item">
              <div class="kpi-bar-row">
                <span class="kpi-bar-name">{{ g.name }}</span>
                <span class="kpi-bar-val">{{ g.count }}</span>
              </div>
              <div class="kpi-bar-track">
                <div class="kpi-bar-fill indigo" :style="{ width: `${Math.round((g.count / maxGenreCount) * 100)}%` }"></div>
              </div>
            </li>
          </ul>
          <p v-else class="kpi-empty-note">{{ TEXTS.dashboardStats.noData }}</p>
        </div>

        <div class="kpi-panel">
          <h3>Auteurs les plus présents (Top 10)</h3>
          <ul v-if="stats.topAuthors.length" class="kpi-bar-list">
            <li v-for="a in stats.topAuthors" :key="a.name" class="kpi-bar-item">
              <div class="kpi-bar-row">
                <span class="kpi-bar-name">{{ a.name }}</span>
                <span class="kpi-bar-val">{{ a.count }}</span>
              </div>
              <div class="kpi-bar-track">
                <div class="kpi-bar-fill emerald" :style="{ width: `${Math.round((a.count / maxAuthorCount) * 100)}%` }"></div>
              </div>
            </li>
          </ul>
          <p v-else class="kpi-empty-note">{{ TEXTS.dashboardStats.noData }}</p>
        </div>
      </section>

      <!-- 4. Sagas, Éditeurs & Emprunteurs actifs -->
      <section class="kpi-grid-3">
        <div class="kpi-panel">
          <h3>Avancement des sagas</h3>
          <ul v-if="stats.topSeries.length" class="kpi-bar-list">
            <li v-for="s in stats.topSeries" :key="s.name" class="kpi-bar-item">
              <div class="kpi-bar-row">
                <span class="kpi-bar-name">{{ s.name }}</span>
                <span class="kpi-bar-val">{{ s.owned }}/{{ s.knownTotal }}</span>
              </div>
              <div class="kpi-bar-track">
                <div class="kpi-bar-fill amber" :style="{ width: `${Math.round((s.owned / Math.max(1, s.knownTotal)) * 100)}%` }"></div>
              </div>
            </li>
          </ul>
          <p v-else class="kpi-empty-note">Aucune saga détectée.</p>
        </div>

        <div class="kpi-panel">
          <h3>Principaux éditeurs</h3>
          <ul v-if="stats.topPublishers.length" class="kpi-simple-list">
            <li v-for="p in stats.topPublishers" :key="p.name">
              <span>{{ p.name }}</span>
              <strong>{{ p.count }}</strong>
            </li>
          </ul>
          <p v-else class="kpi-empty-note">Aucun éditeur renseigné.</p>
        </div>

        <div class="kpi-panel">
          <h3>Suivi des prêts actifs</h3>
          <ul v-if="stats.borrowers.length" class="kpi-simple-list">
            <li v-for="b in stats.borrowers" :key="b.name">
              <span>{{ b.name }}</span>
              <strong>{{ b.count }} ({{ b.maxDays }} j)</strong>
            </li>
          </ul>
          <p v-else class="kpi-empty-note">Aucun prêt en cours.</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.kpi-page-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.kpi-period-select {
  width: auto !important;
  min-inline-size: 165px;
  min-block-size: 38px;
  font-size: 0.85rem !important;
  font-weight: 600;
}

.kpi-sections-stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.kpi-grid-4 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.75rem;
}

.kpi-grid-3 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.85rem;
}

.kpi-grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 0.85rem;
}

.kpi-btn-card {
  border-radius: var(--radius-md, 12px);
  padding: 0.9rem;
  text-align: center;
  cursor: pointer;
  font-family: inherit;
}

.kpi-sub-note {
  margin-top: 0.3rem;
  font-size: 0.75rem;
  color: var(--color-text-muted, #64748b);
  font-weight: 600;
}

.kpi-sub-note.warn {
  color: #b91c1c;
}

.kpi-panel {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  background: var(--color-bg-main, #ffffff);
  box-shadow: var(--shadow-sm);
  padding: 1rem;
}

.kpi-panel h3 {
  margin: 0 0 0.75rem;
  font-size: 0.95rem;
  font-weight: 700;
  line-height: 1.25;
  border-bottom: 1px solid var(--color-border, #e2e8f0);
  padding-bottom: 0.45rem;
  text-wrap: balance;
}

.kpi-dual-metrics {
  display: flex;
  justify-content: space-around;
  text-align: center;
  gap: 0.5rem;
}

.kpi-big-num {
  font-size: 1.65rem;
  font-weight: 800;
  color: var(--color-text-main, #0f172a);
}

.kpi-small-lbl {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-muted, #64748b);
}

.kpi-reading-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.kpi-pill {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.55rem;
  border-radius: 9999px;
}

.kpi-pill.read {
  background: #dcfce7;
  color: #166534;
}

.kpi-pill.reading {
  background: #dbeafe;
  color: #1e3a8a;
}

.kpi-pill.todo {
  background: #fef3c7;
  color: #92400e;
}

.kpi-pill.none {
  background: #f1f5f9;
  color: #475569;
}

.kpi-foot-note {
  margin-top: 0.65rem;
  font-size: 0.8rem;
  color: var(--color-text-muted, #64748b);
}

.kpi-bar-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.kpi-bar-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.8125rem;
  margin-bottom: 0.2rem;
  gap: 0.5rem;
}

.kpi-bar-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.kpi-bar-val {
  font-weight: 700;
  color: var(--color-primary, #4f46e5);
  flex-shrink: 0;
}

.kpi-bar-track {
  height: 7px;
  border-radius: 9999px;
  background: #e2e8f0;
  overflow: hidden;
}

.kpi-bar-fill {
  height: 100%;
  border-radius: 9999px;
}

.kpi-bar-fill.indigo {
  background: #4f46e5;
}

.kpi-bar-fill.emerald {
  background: #059669;
}

.kpi-bar-fill.amber {
  background: #d97706;
}

.kpi-simple-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.82rem;
}

.kpi-simple-list li {
  display: flex;
  justify-content: space-between;
  padding-bottom: 0.35rem;
  border-bottom: 1px dashed var(--color-border, #e2e8f0);
}

.kpi-simple-list li:last-child {
  border-bottom: none;
}

.kpi-empty-note,
.kpi-empty-box {
  font-size: 0.82rem;
  color: var(--color-text-muted, #64748b);
  margin: 0;
}
</style>
