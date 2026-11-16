<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRegisterSW } from 'virtual:pwa-register/vue';
import { TEXTS } from '../locales/fr';

const {
  offlineReady,
  needRefresh,
  updateServiceWorker,
} = useRegisterSW({
  onRegistered(r) {
    console.log('[PWA] Service Worker correctement enregistré.', r);
  },
  onRegisterError(error) {
    console.error('[PWA] Échec lors de l\'enregistrement du Service Worker:', error);
  },
});

const dialogRef = ref<HTMLDialogElement | null>(null);
const isOpen = computed(() => offlineReady.value || needRefresh.value);
let pressedOutsideBackdrop = false;

const closeModal = () => {
  offlineReady.value = false;
  needRefresh.value = false;
  if (dialogRef.value?.open) {
    dialogRef.value.close();
  }
};

const syncDialogVisibility = () => {
  const el = dialogRef.value;
  if (!el) return;
  if (isOpen.value && !el.open) {
    el.showModal();
  } else if (!isOpen.value && el.open) {
    el.close();
  }
};

watch(isOpen, () => {
  syncDialogVisibility();
});

onMounted(() => {
  syncDialogVisibility();
});

const handleDialogClose = () => {
  if (dialogRef.value) {
    dialogRef.value.returnValue = '';
  }
  offlineReady.value = false;
  needRefresh.value = false;
};

const isPointerOutsideDialog = (e: PointerEvent, el: HTMLDialogElement): boolean => {
  const r = el.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};

const onDialogPointerDown = (e: PointerEvent) => {
  if (!dialogRef.value || 'closedBy' in HTMLDialogElement.prototype) return;
  pressedOutsideBackdrop = isPointerOutsideDialog(e, dialogRef.value);
};

const onDialogPointerUp = (e: PointerEvent) => {
  if (!dialogRef.value || 'closedBy' in HTMLDialogElement.prototype) return;
  if (pressedOutsideBackdrop && isPointerOutsideDialog(e, dialogRef.value)) {
    closeModal();
  }
  pressedOutsideBackdrop = false;
};
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialogRef"
      class="pwa-dialog"
      aria-labelledby="pwa-modal-title"
      closedby="any"
      @close="handleDialogClose"
      @cancel.prevent="closeModal"
      @pointerdown="onDialogPointerDown"
      @pointerup="onDialogPointerUp"
    >
      <div class="pwa-dialog-surface">
        <div class="modal-header-row">
          <h3 id="pwa-modal-title" class="modal-title">
            {{ needRefresh ? 'Nouvelle version disponible' : 'Mode hors-ligne prêt' }}
          </h3>
          <button
            type="button"
            class="modal-close-icon"
            aria-label="Fermer"
            @click="closeModal"
          >
            ✕
          </button>
        </div>

        <p class="modal-text pwa-explanation">
          <template v-if="needRefresh">
            Une mise à jour de <strong>Biblio Collection</strong> est prête à être installée avec les dernières améliorations et corrections.
            <br />
            Vos livres, notes et prêts enregistrés sont intégralement conservés.
          </template>
          <template v-else>
            {{ TEXTS.pwa.offlineReady }} Vous pouvez consulter votre bibliothèque même sans connexion Internet.
          </template>
        </p>

        <div class="modal-actions pwa-dialog-actions">
          <button
            type="button"
            class="btn-close"
            @click="closeModal"
          >
            {{ needRefresh ? 'Plus tard' : 'Compris' }}
          </button>
          <button
            v-if="needRefresh"
            type="button"
            class="btn-action"
            autofocus
            @click="updateServiceWorker()"
          >
            Mettre à jour maintenant
          </button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
dialog.pwa-dialog {
  padding: 0;
  border: none;
  background: transparent;
  inline-size: min(92vw, 430px);
  max-inline-size: 430px;
  margin: auto;
  overflow: visible;
}

dialog.pwa-dialog:modal {
  overscroll-behavior: contain;
}

dialog.pwa-dialog::backdrop {
  background: rgba(15, 23, 42, 0.58);
  backdrop-filter: blur(4px);
  overflow: hidden;
  overscroll-behavior: contain;
}

.pwa-dialog-surface {
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-main, #0f172a);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-modal, 0 20px 25px -5px rgba(15, 23, 42, 0.16));
  padding: 1.35rem;
  font-family: var(--font-main);
}

.pwa-explanation {
  font-size: 0.9rem;
  line-height: 1.5;
  margin-bottom: 1.15rem;
}

.pwa-dialog-actions {
  justify-content: flex-end;
  gap: 0.65rem;
}
</style>
