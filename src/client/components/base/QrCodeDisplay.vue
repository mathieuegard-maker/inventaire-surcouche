<!-- src/client/components/base/QrCodeDisplay.vue -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import QRCode from 'qrcode';

const props = defineProps<{
  value: string;
  alt: string;
}>();

const dataUrl = ref('');

watch(
  () => props.value,
  async (val) => {
    if (!val) {
      dataUrl.value = '';
      return;
    }
    try {
      dataUrl.value = await QRCode.toDataURL(val, {
        width: 180,
        margin: 1
      });
    } catch {
      dataUrl.value = '';
    }
  },
  { immediate: true }
);
</script>

<template>
  <div v-if="dataUrl" class="qr-box">
    <img :src="dataUrl" :alt="alt" class="qr-box__img" />
  </div>
</template>

<style scoped>
.qr-box {
  display: inline-flex;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.qr-box__img {
  width: 164px;
  height: 164px;
  display: block;
  border-radius: var(--radius-sm);
}
</style>
