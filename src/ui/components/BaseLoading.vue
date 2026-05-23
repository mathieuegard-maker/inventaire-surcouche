<script setup lang="ts">
import { TEXTS } from '../locales/fr';
</script>

<template>
  <div class="result-card">
    <p>{{ TEXTS.baseLoading?.message || 'Chargement en cours...' }}</p>
  </div>
</template>