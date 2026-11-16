<script setup lang="ts">
import { ref, watch } from 'vue';
import FamilySharePanel from './FamilySharePanel.vue';
import { useModalScrollable } from '../composables/useModalScrollable';

const modalCardRef = ref<HTMLElement | null>(null);
const resetTick = ref(0);
const activeTab = ref<'family' | 'friends'>('family');
const statusText = ref('');

const props = withDefaults(
  defineProps<{
    show: boolean;
    initialTab?: 'family' | 'friends';
  }>(),
  {
    initialTab: 'family'
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'joined'): void;
}>();

const { isScrollable } = useModalScrollable(
  modalCardRef,
  () => [props.show, activeTab.value, statusText.value]
);

watch(
  () => props.show,
  (isOpen) => {
    if (isOpen) {
      resetTick.value++;
    }
  }
);

const closeModal = () => {
  emit('close');
};
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-backdrop" @click.self="closeModal">
      <div ref="modalCardRef" class="modal-card" role="dialog" aria-modal="true" aria-label="Partage Foyer et Amis">
        <div class="modal-header">
          <h3>Foyer &amp; Amis</h3>
          <button type="button" class="close-btn" @click="closeModal" aria-label="Fermer">✕</button>
        </div>

        <FamilySharePanel
          :initial-tab="initialTab"
          :reset-trigger="resetTick"
          @tab-change="(t) => (activeTab = t)"
          @status-change="(m) => (statusText = m)"
          @joined="emit('joined')"
        />

        <div v-if="isScrollable" class="modal-bottom-close-bar">
          <button type="button" class="close-btn" @click="closeModal" aria-label="Fermer">✕</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  width: 100%;
  min-block-size: 100dvh;
  background: rgba(15, 23, 42, 0.58);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: var(--z-modal, 2000);
  overflow-y: auto;
  overscroll-behavior: contain;
  box-sizing: border-box;
}

.modal-card {
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-main, #0f172a);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-modal, 0 20px 25px -5px rgba(15, 23, 42, 0.16));
  inline-size: 100%;
  max-inline-size: 520px;
  max-block-size: 92dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1.35rem;
  font-family: var(--font-main);
  box-sizing: border-box;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.85rem;
}

.modal-header h3 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.25;
  text-wrap: balance;
}

.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-alt, #f8fafc);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  min-inline-size: 34px;
  min-block-size: 34px;
  font-weight: 600;
  cursor: pointer;
  color: var(--color-text-main, #0f172a);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.close-btn:hover {
  background: #e2e8f0;
}
</style>
