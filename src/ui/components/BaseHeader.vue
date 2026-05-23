<script setup lang="ts">
import { useRouter } from 'vue-router';
import BaseButton from './BaseButton.vue';
import { TEXTS } from '../locales/fr';

defineProps<{
  title: string;
  showBack?: boolean;
}>();

const router = useRouter();

const handleBack = () => {
  router.back();
};
</script>

<template>
  <div class="base-page-header">
    <BaseButton v-if="showBack" @click="handleBack">
      {{ TEXTS.seriesView?.back || '← Retour' }}
    </BaseButton>
    <h2>{{ title }}</h2>
    <slot name="actions"></slot>
  </div>
</template>