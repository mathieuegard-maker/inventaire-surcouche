<!-- src/client/components/modals/CameraBarcodeModal.vue -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import BaseModal from '../base/BaseModal.vue';
import { isbnUtil } from '../../../shared/bibliographic/isbn.util';
import { t } from '../../../shared/locales';

const props = withDefaults(
  defineProps<{
    open: boolean;
    mode?: 'simple' | 'burst' | 'picker';
    flashState?: 'none' | 'added' | 'duplicate';
  }>(),
  {
    mode: 'simple',
    flashState: 'none'
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'detected', isbn13: string): void;
}>();

const readerElementId = `barcode-reader-${Math.random().toString(36).slice(2, 9)}`;
const cameraError = ref('');
const lastDetectedAt = new Map<string, number>();

let scanner: Html5Qrcode | null = null;
let isRunning = false;

const modalTitle = computed(() => {
  if (props.mode === 'burst') return t('scan.cameraTitleBurst');
  if (props.mode === 'picker') return t('scan.cameraTitlePicker');
  return t('scan.cameraTitleSimple');
});

async function stopScanner(): Promise<void> {
  if (!scanner) return;
  const instance = scanner;
  scanner = null;
  if (isRunning) {
    isRunning = false;
    try {
      await instance.stop();
    } catch {
      // ignore stop race
    }
  }
  try {
    instance.clear();
  } catch {
    // ignore clear
  }
}

async function startScanner(): Promise<void> {
  cameraError.value = '';
  await nextTick();

  const container = document.getElementById(readerElementId);
  if (!container) return;

  try {
    const instance = new Html5Qrcode(readerElementId, {
      verbose: false,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A
      ]
    });
    scanner = instance;

    await instance.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: { width: 260, height: 120 } },
      (decodedText) => {
        const isbn13 = isbnUtil.normalizeToIsbn13(decodedText);
        if (!isbn13) return;

        const now = Date.now();
        const prev = lastDetectedAt.get(isbn13) ?? 0;
        if (now - prev < 1500) return;
        lastDetectedAt.set(isbn13, now);

        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(45);
        }

        emit('detected', isbn13);

        if (props.mode !== 'burst') {
          void stopScanner();
          emit('close');
        }
      },
      () => {
        // frame sans code-barres
      }
    );
    isRunning = true;
  } catch {
    cameraError.value = t('scan.cameraInitError');
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      lastDetectedAt.clear();
      void startScanner();
    } else {
      void stopScanner();
    }
  }
);

onBeforeUnmount(() => {
  void stopScanner();
});
</script>

<template>
  <BaseModal :open="open" :title="modalTitle" max-width="540px" @close="emit('close')">
    <div class="ds-stack">
      <p class="ds-text-muted">{{ t('scan.cameraHint') }}</p>

      <div v-if="cameraError" class="ds-banner ds-banner--danger" role="alert">
        {{ cameraError }}
      </div>

      <div
        class="camera-viewport"
        :class="{
          'camera-viewport--added': flashState === 'added',
          'camera-viewport--duplicate': flashState === 'duplicate'
        }"
      >
        <div :id="readerElementId" class="camera-reader" />
      </div>
    </div>

    <template #footer>
      <button type="button" class="ds-btn" @click="emit('close')">
        {{ t('app.close') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.camera-viewport {
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 3px solid var(--border-subtle);
  background: var(--bg-elevated);
  min-height: 240px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.camera-viewport--added {
  border-color: var(--success-text);
  box-shadow: 0 0 0 4px var(--success-bg);
}

.camera-viewport--duplicate {
  border-color: var(--warning-text);
  box-shadow: 0 0 0 4px var(--warning-bg);
}

.camera-reader {
  width: 100%;
}
</style>
