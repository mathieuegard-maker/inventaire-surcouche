<!-- src/client/components/base/BaseModal.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiStore } from '../../stores/ui.store';
import { t } from '../../../shared/locales';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    closable?: boolean;
    maxWidth?: string;
  }>(),
  {
    title: '',
    closable: true,
    maxWidth: '520px'
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const uiStore = useUiStore();
const modalId = `modal_${Math.random().toString(36).slice(2, 10)}`;
const zIndex = ref(1000);

const panelStyle = computed(() => ({
  maxWidth: props.maxWidth
}));

function handleClose(): void {
  if (!props.closable) return;
  emit('close');
}

function handleBackdropClick(): void {
  if (!props.closable) return;
  emit('close');
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.open || !props.closable) return;
  if (uiStore.isTopModal(modalId)) {
    event.preventDefault();
    emit('close');
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      zIndex.value = uiStore.registerModal(modalId);
    } else {
      uiStore.unregisterModal(modalId);
    }
  },
  { immediate: true }
);

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
  uiStore.unregisterModal(modalId);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="base-modal__backdrop"
      :style="{ zIndex }"
      role="dialog"
      aria-modal="true"
      :aria-label="title || t('app.title')"
      @click.self="handleBackdropClick"
    >
      <div class="base-modal__panel" :style="panelStyle">
        <header v-if="title || closable" class="base-modal__header">
          <h2 v-if="title" class="base-modal__title">{{ title }}</h2>
          <span v-else />
          <button
            v-if="closable"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm base-modal__close"
            :aria-label="t('app.close')"
            @click="handleClose"
          >
            ✕
          </button>
        </header>

        <div class="base-modal__body">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="base-modal__footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.base-modal__backdrop {
  position: fixed;
  inset: 0;
  background: var(--bg-backdrop);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}

.base-modal__panel {
  width: 100%;
  max-height: calc(100dvh - var(--space-6));
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.base-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
}

.base-modal__title {
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-primary);
}

.base-modal__close {
  line-height: 1;
}

.base-modal__body {
  padding: var(--space-5);
  overflow-y: auto;
}

.base-modal__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
}
</style>
