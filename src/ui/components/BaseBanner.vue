<script setup lang="ts">
defineProps<{
  type: 'success' | 'error';
  message: string;
}>();
</script>

<template>
  <div :class="['result-card', type]">
    <p v-if="type === 'success'">✅ {{ message }}</p>
    <p v-else>⚠️ {{ message }}</p>
  </div>
</template>