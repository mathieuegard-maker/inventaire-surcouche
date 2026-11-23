<!-- src/client/components/base/ToastHost.vue -->
<script setup lang="ts">
import { useUiStore } from '../../stores/ui.store';
import { t } from '../../../shared/locales';

const uiStore = useUiStore();
</script>

<template>
  <Teleport to="body">
    <div v-if="uiStore.toasts.length > 0" class="toast-host" aria-live="polite">
      <button
        v-for="toast in uiStore.toasts"
        :key="toast.id"
        type="button"
        class="toast-item"
        :class="`toast-item--${toast.type}`"
        :aria-label="t('app.close')"
        @click="uiStore.dismissToast(toast.id)"
      >
        <span class="toast-item__message">{{ toast.message }}</span>
        <span class="toast-item__dismiss" aria-hidden="true">✕</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 360px;
  width: calc(100vw - var(--space-6));
  pointer-events: none;
}

.toast-item {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  text-align: left;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-md);
  cursor: pointer;
  font-weight: 500;
}

.toast-item--success {
  background: var(--success-bg);
  color: var(--success-text);
  border-color: var(--border-subtle);
}

.toast-item--warning {
  background: var(--warning-bg);
  color: var(--warning-text);
  border-color: var(--border-subtle);
}

.toast-item--danger {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: var(--danger);
}

.toast-item__message {
  flex: 1;
}

.toast-item__dismiss {
  opacity: 0.7;
  font-size: 0.85rem;
}

@media (max-width: 820px) {
  .toast-host {
    bottom: calc(var(--tabbar-height) + var(--space-3));
    right: var(--space-3);
  }
}
</style>
