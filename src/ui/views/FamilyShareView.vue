<script setup lang="ts">
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import FamilySharePanel from '../components/FamilySharePanel.vue';
</script>

<template>
  <div class="view-container">
    <BaseHeader />

    <div class="family-page">
      <BaseTitle text="Foyer &amp; Partage" level="h2" />

      <div class="family-page-card">
        <FamilySharePanel initial-tab="family" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.family-page {
  width: 100%;
  max-width: 680px;
  margin: 0 auto 2rem;
}

.family-page-card {
  background: var(--color-bg-main, #ffffff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-card);
  padding: 1.25rem;
}
</style>
