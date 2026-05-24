<script setup lang="ts">
defineProps<{
  type?: 'button' | 'submit';
  disabled?: boolean;
}>();
</script>

<template>
  <button
    :type="type || 'button'"
    :disabled="disabled"
    class="wireframe-btn"
  >
    <slot></slot>
  </button>
</template>