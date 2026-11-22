<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRegisterSW } from 'virtual:pwa-register/vue';
import { TEXTS } from '../locales/fr';

let swRegistration: ServiceWorkerRegistration | undefined;
let cleanupVisibilityListener: (() => void) | null = null;
let cleanupFocusListener: (() => void) | null = null;

const {
  offlineReady,
  needRefresh,
  updateServiceWorker,
} = useRegisterSW({
  onRegistered(r) {
    console.log('[PWA] Service Worker correctement enregistré.', r);
    swRegistration = r;
    if (r) {
      r.update().catch(() => {});
      if (typeof document !== 'undefined') {
        const onVisibilityChange = () => {
          if (!document.hidden) {
            r.update().catch(() => {});
          }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        cleanupVisibilityListener = () =>
          document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        const onFocus = () => {
          r.update().catch(() => {});
        };
        window.addEventListener('focus', onFocus);
        cleanupFocusListener = () => window.removeEventListener('focus', onFocus);
      }
    }
  },
  onRegisterError(error) {
    console.error('[PWA] Échec lors de l\'enregistrement du Service Worker:', error);
  },
});

const dialogRef = ref<HTMLDialogElement | null>(null);
const isUpdating = ref(false);
const isOpen = computed(() => offlineReady.value || needRefresh.value);
let pressedOutsideBackdrop = false;
let reloadTriggered = false;

const closeModal = () => {
  if (isUpdating.value) return;
  offlineReady.value = false;
  needRefresh.value = false;
  if (dialogRef.value?.open) {
    dialogRef.value.close();
  }
};

const triggerReloadOnce = () => {
  if (reloadTriggered) return;
  reloadTriggered = true;
  offlineReady.value = false;
  needRefresh.value = false;
  if (dialogRef.value?.open) {
    dialogRef.value.close();
  }
  window.location.reload();
};

const applyUpdate = async () => {
  if (isUpdating.value) return;
  isUpdating.value = true;

  const hasSw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  // Écouter directement controllerchange sans dépendre du flag `event.isUpdate` de workbox-window
  // (souvent ignoré après reprise d'une PWA déjà en attente ou sur iOS Safari).
  if (hasSw) {
    navigator.serviceWorker.addEventListener('controllerchange', triggerReloadOnce, { once: true });
  }

  // Garde-fou : garantit le rechargement même si le navigateur n'émet pas controllerchange.
  const fallbackTimer = window.setTimeout(() => {
    triggerReloadOnce();
  }, 1500);

  try {
    await updateServiceWorker(true);

    if (hasSw) {
      const reg = swRegistration || (await navigator.serviceWorker.getRegistration());
      if (reg?.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else if (reg?.installing) {
        reg.installing.addEventListener('statechange', () => {
          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      } else {
        // Le nouveau Service Worker a déjà pris la main entre-temps : recharger immédiatement
        window.clearTimeout(fallbackTimer);
        triggerReloadOnce();
      }
    } else {
      window.clearTimeout(fallbackTimer);
      triggerReloadOnce();
    }
  } catch (err) {
    console.warn('[PWA] Rechargement de secours après échec updateServiceWorker:', err);
    window.clearTimeout(fallbackTimer);
    triggerReloadOnce();
  }
};

onUnmounted(() => {
  cleanupVisibilityListener?.();
  cleanupFocusListener?.();
});

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
      <div class="modal-box pwa-modal-card">
        <div class="modal-header-row">
          <h2 id="pwa-modal-title" class="modal-title">
            {{ needRefresh ? 'Nouvelle version disponible' : 'Mode hors-ligne prêt' }}
          </h2>
          <button
            type="button"
            class="modal-close-icon"
            aria-label="Fermer"
            @click="closeModal"
          >
            ✕
          </button>
        </div>

        <p class="modal-text highlight">
          <template v-if="needRefresh">
            Une mise à jour de l'application est prête avec les dernières améliorations. Vos livres, prêts et paramètres sont conservés.
          </template>
          <template v-else>
            {{ TEXTS.pwa.offlineReady }} Vous pouvez consulter votre bibliothèque mémorisée même sans réseau.
          </template>
        </p>

        <div class="modal-actions">
          <button
            v-if="needRefresh"
            type="button"
            class="btn-action pwa-btn-lg"
            autofocus
            :disabled="isUpdating"
            @click="applyUpdate"
          >
            {{ isUpdating ? 'Mise à jour en cours…' : 'Mettre à jour maintenant' }}
          </button>
          <button
            type="button"
            class="btn-close pwa-btn-lg"
            :disabled="isUpdating"
            @click="closeModal"
          >
            {{ needRefresh ? 'Plus tard' : 'Compris' }}
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
  inline-size: min(92vw, 460px);
  max-inline-size: 460px;
  margin: auto;
  overflow: visible;
}

dialog.pwa-dialog:modal {
  overscroll-behavior: contain;
}

dialog.pwa-dialog::backdrop {
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(4px);
  overflow: hidden;
  overscroll-behavior: contain;
}

.pwa-modal-card {
  gap: 1rem !important;
}

.pwa-btn-lg {
  min-block-size: 46px !important;
  font-size: 0.9375rem !important;
  padding: 0.7rem 1.15rem !important;
}
</style>
