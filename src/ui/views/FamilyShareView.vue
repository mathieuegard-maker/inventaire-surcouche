<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import FamilySharePanel from '../components/FamilySharePanel.vue';
import FriendsView from './FriendsView.vue';

const route = useRoute();
const router = useRouter();

type ShareHubTab = 'family' | 'friends';

const activeTab = computed<ShareHubTab>(() =>
  route.query.tab === 'friends' ? 'friends' : 'family'
);

const setTab = (tab: ShareHubTab) => {
  if (activeTab.value === tab) return;
  router.replace({ path: '/family', query: tab === 'friends' ? { tab: 'friends' } : {} });
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />

    <div class="family-page">
      <BaseTitle text="Partage &amp; Amis" level="h2" />

      <div class="subnav-tabs" role="tablist" aria-label="Sections Partage et Amis">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'family'"
          :class="['subnav-tab', { active: activeTab === 'family' }]"
          @click="setTab('family')"
        >
          Mon Foyer &amp; Liens
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'friends'"
          :class="['subnav-tab', { active: activeTab === 'friends' }]"
          @click="setTab('friends')"
        >
          Mes Amis
        </button>
      </div>

      <div v-if="activeTab === 'family'" class="family-page-card">
        <FamilySharePanel initial-tab="family" />
      </div>

      <div v-else class="friends-hub-wrap">
        <FriendsView :embedded="true" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.family-page {
  width: 100%;
  max-width: 960px;
  margin: 0 auto 2rem;
}

.subnav-tabs {
  display: flex;
  gap: 0.5rem;
  margin: 0.5rem 0 1rem;
  flex-wrap: wrap;
}

.subnav-tab {
  min-block-size: 40px;
  padding: 0.45rem 1rem;
  border-radius: 999px;
  border: 1px solid var(--color-border, #e2e8f0);
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-muted, #475569);
  font-weight: 700;
  font-size: 0.9rem;
  cursor: pointer;
}

.subnav-tab.active {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #ffffff;
}

.family-page-card {
  max-width: 680px;
  margin: 0 auto;
  background: var(--color-bg-main, #ffffff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-card);
  padding: 1.25rem;
}

.friends-hub-wrap {
  width: 100%;
}
</style>
