<template>
  <div class="qr-box">
    <div v-if="dataUrl" class="qr-frame" :style="{ borderColor: accentColor }">
      <img :src="dataUrl" :alt="label || 'QR Code'" class="qr-image" :width="size" :height="size" />
    </div>
    <div v-else class="qr-placeholder">Génération du QR code...</div>
    <p v-if="label" class="qr-caption">{{ label }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import QRCode from 'qrcode';

const props = withDefaults(
  defineProps<{
    value: string;
    label?: string;
    size?: number;
    accentColor?: string;
  }>(),
  {
    label: '',
    size: 200,
    accentColor: '#111827'
  }
);

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
        width: props.size,
        margin: 2,
        color: {
          dark: '#111827',
          light: '#ffffff'
        }
      });
    } catch (e) {
      console.error('[QrCodeDisplay] Erreur génération QR:', e);
      dataUrl.value = '';
    }
  },
  { immediate: true }
);
</script>

<style scoped>
.qr-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.45rem;
}

.qr-frame {
  background: #ffffff;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  padding: 0.6rem;
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.06));
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.qr-image {
  display: block;
  max-width: 100%;
  height: auto;
}

.qr-placeholder {
  width: 200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed #9ca3af;
  font-size: 0.8rem;
  color: #6b7280;
}

.qr-caption {
  margin: 0;
  font-size: 0.78rem;
  color: #4b5563;
  text-align: center;
}
</style>
