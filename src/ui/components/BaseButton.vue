<script setup lang="ts">
defineProps<{
  type?: 'button' | 'submit';
  disabled?: boolean;
  variantClass?: string;
}>();
</script>

<template>
  <button
    :type="type || 'button'"
    :disabled="disabled"
    :class="variantClass || 'btn-action'"
  >
    <slot></slot>
  </button>
</template>