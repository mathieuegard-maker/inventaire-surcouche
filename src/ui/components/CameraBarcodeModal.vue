<script setup lang="ts">
import { computed, ref } from 'vue';
import { scannerState } from '../../state/scanner';
import { useModalScrollable } from '../composables/useModalScrollable';

const modalCardRef = ref<HTMLElement | null>(null);
const activeMode = computed(() => scannerState.activeMode.value);
const isCameraOpen = computed(() => scannerState.isCameraModalOpen.value);
const burstCount = computed(() => scannerState.burstBooks.value.length);

const { isScrollable } = useModalScrollable(modalCardRef, () => [isCameraOpen.value, activeMode.value]);
</script>

<template>
  <Teleport to="body">
    <div v-show="isCameraOpen" class="scanner-modal-backdrop" @click.self="scannerState.stopScan()">
      <div
        ref="modalCardRef"
        class="scanner-modal-card"
        :class="{ scrollable: isScrollable }"
        role="dialog"
        aria-modal="true"
        aria-label="Caméra code-barres"
      >
        <div class="camera-modal-header">
          <strong>
            {{ activeMode === 'burst' ? `Scan rafale (${burstCount} livre(s))` : 'Scan code-barres' }}
          </strong>
          <button
            type="button"
            class="close-scan-btn"
            aria-label="Fermer la caméra"
            @click="scannerState.stopScan()"
          >
            ✕
          </button>
        </div>

        <p class="camera-hint">
          {{
            activeMode === 'burst'
              ? 'Visez les codes-barres à la suite. Cliquez sur Fermer quand vous avez terminé pour afficher la liste des livres scannés sur la page.'
              : 'Placez le code-barres EAN-13 du livre dans le cadre. Dès la lecture réussie, la fenêtre se ferme et la fiche du livre s’ouvre automatiquement.'
          }}
        </p>

        <div class="scanner-viewport-container">
          <div id="global-barcode-scanner-viewport" class="scanner-viewport"></div>
          <div v-if="!scannerState.isSearching.value" class="scanner-placeholder">
            Ouverture de la caméra...
          </div>
          <div
            v-if="scannerState.burstFlashEvent.value"
            :key="scannerState.burstFlashEvent.value.id"
            :class="['burst-flash-overlay', scannerState.burstFlashEvent.value.status]"
            aria-hidden="true"
          ></div>
        </div>

        <div v-if="scannerState.errorMessage.value" class="camera-error-msg">
          {{ scannerState.errorMessage.value }}
        </div>

        <div class="camera-modal-footer">
          <button type="button" class="wireframe-btn primary" @click="scannerState.stopScan()">
            {{ activeMode === 'burst' ? `Fermer${burstCount > 0 ? ` (${burstCount})` : ''}` : 'Fermer' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scanner-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2100;
  background: rgba(15, 23, 42, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.scanner-modal-card {
  width: 100%;
  max-width: 460px;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--color-surface, #fff);
  border-radius: 16px;
  padding: 1rem;
  box-shadow: 0 20px 45px rgba(15, 23, 42, 0.35);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.camera-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.close-scan-btn {
  border: 1px solid #cbd5e1;
  background: #f8fafc;
  border-radius: 999px;
  width: 32px;
  height: 32px;
  font-weight: 700;
  cursor: pointer;
}

.camera-hint {
  margin: 0;
  font-size: 0.85rem;
  color: #475569;
}

.scanner-viewport-container {
  position: relative;
  width: 100%;
  min-height: 250px;
  background: #0f172a;
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scanner-viewport {
  width: 100%;
}

.scanner-placeholder {
  position: absolute;
  color: #e2e8f0;
  font-size: 0.88rem;
  pointer-events: none;
}

.burst-flash-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  animation: burst-flash 0.55s ease-out;
}

.burst-flash-overlay.success {
  border: 5px solid #22c55e;
  background: rgba(34, 197, 94, 0.18);
}

.burst-flash-overlay.duplicate {
  border: 5px solid #f59e0b;
  background: rgba(245, 158, 11, 0.18);
}

@keyframes burst-flash {
  from { opacity: 1; }
  to { opacity: 0; }
}

.camera-error-msg {
  background: #fee2e2;
  color: #991b1b;
  padding: 0.65rem 0.8rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
}

.camera-modal-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
