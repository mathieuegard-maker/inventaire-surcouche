<script setup lang="ts">
defineProps<{
  text: string;
  level?: 'h2' | 'h3';
}>();
</script>

<template>
  <component :is="level || 'h2'" class="wireframe-title">
    {{ text }}
  </component>
</template>