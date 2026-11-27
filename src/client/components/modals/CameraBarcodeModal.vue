<!-- src/client/components/modals/CameraBarcodeModal.vue -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { CheckCircle2, AlertTriangle } from '@lucide/vue';
import BaseModal from '../base/BaseModal.vue';
import { isbnUtil } from '../../../shared/bibliographic/isbn.util';
import { t } from '../../../shared/locales';

const props = withDefaults(
  defineProps<{
    open: boolean;
    mode?: 'simple' | 'burst' | 'picker';
    flashState?: 'none' | 'added' | 'duplicate';
    scannedCount?: number;
    lastScannedLabel?: string;
  }>(),
  {
    mode: 'simple',
    flashState: 'none',
    scannedCount: 0,
    lastScannedLabel: ''
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
let isStarting = false;

async function waitForReaderElement(maxAttempts = 12): Promise<HTMLElement | null> {
  for (let i = 0; i < maxAttempts; i++) {
    await nextTick();
    const el = document.getElementById(readerElementId);
    if (el) return el;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
  return null;
}

const modalTitle = computed(() => {
  if (props.mode === 'burst') return t('scan.cameraTitleBurst');
  if (props.mode === 'picker') return t('scan.cameraTitlePicker');
  return t('scan.cameraTitleSimple');
});

async function stopScanner(): Promise<void> {
  isStarting = false;
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
  if (isRunning || isStarting) return;
  isStarting = true;
  cameraError.value = '';

  const container = await waitForReaderElement();
  if (!container || !props.open) {
    isStarting = false;
    return;
  }

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
          navigator.vibrate(55);
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
    isStarting = false;
  } catch {
    isStarting = false;
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
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  void stopScanner();
});
</script>

<template>
  <BaseModal :open="open" :title="modalTitle" max-width="540px" @close="emit('close')">
    <div class="ds-stack--sm">
      <p class="ds-text-muted camera-help">
        {{ mode === 'burst' ? t('scan.burstHelpText') : t('scan.cameraHint') }}
      </p>

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

      <!-- Feedback de scan intégré DANS la modale (remplace le bandeau vert flottant gênant) -->
      <div
        v-if="mode === 'burst' && (lastScannedLabel || scannedCount > 0)"
        class="camera-burst-status"
        :class="{
          'camera-burst-status--added': flashState === 'added',
          'camera-burst-status--duplicate': flashState === 'duplicate'
        }"
        role="status"
      >
        <div class="ds-row ds-row--between">
          <span class="ds-badge ds-badge--accent">
            {{ t('scan.burstModalCounter', { count: scannedCount }) }}
          </span>
          <span v-if="lastScannedLabel" class="camera-burst-status__last">
            <AlertTriangle v-if="flashState === 'duplicate'" :size="14" aria-hidden="true" />
            <CheckCircle2 v-else :size="14" aria-hidden="true" />
            <span>{{ lastScannedLabel }}</span>
          </span>
        </div>
      </div>
    </div>

    <template #footer>
      <button
        v-if="mode === 'burst' && scannedCount > 0"
        type="button"
        class="ds-btn ds-btn--primary"
        @click="emit('close')"
      >
        {{ t('scan.burstAccessListBtn', { count: scannedCount }) }}
      </button>
      <button v-else type="button" class="ds-btn" @click="emit('close')">
        {{ t('app.close') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.camera-help {
  margin: 0;
  font-size: 0.85rem;
}

.camera-viewport {
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 3px solid var(--border-subtle);
  background: var(--bg-elevated);
  min-height: 230px;
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

.camera-burst-status {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  transition: background-color 0.2s ease, border-color 0.2s ease;
}

.camera-burst-status--added {
  background: var(--success-bg);
  border-color: var(--success-text);
  color: var(--success-text);
}

.camera-burst-status--duplicate {
  background: var(--warning-bg);
  border-color: var(--warning-text);
  color: var(--warning-text);
}

.camera-burst-status__last {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.84rem;
  font-weight: 600;
  min-inline-size: 0;
}
</style>
