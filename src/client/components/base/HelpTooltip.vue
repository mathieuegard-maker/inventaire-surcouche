<!-- src/client/components/base/HelpTooltip.vue -->
<!-- Icône d'aide « ? » tactile (44px sur mobile) ouvrant une explication courte et claire sans surcharge. -->
<script setup lang="ts">
import { ref } from 'vue';
import { HelpCircle } from '@lucide/vue';
import BaseModal from './BaseModal.vue';
import { t } from '../../../shared/locales';

defineProps<{
  title?: string;
  text: string;
  ariaLabel?: string;
}>();

const open = ref(false);
</script>

<template>
  <button
    type="button"
    class="help-tip-btn"
    :aria-label="ariaLabel || title || t('app.help')"
    @click.stop.prevent="open = true"
  >
    <HelpCircle :size="16" :stroke-width="2" aria-hidden="true" />
  </button>

  <BaseModal :open="open" :title="title || t('app.help')" max-width="400px" @close="open = false">
    <p class="help-tip-body">{{ text }}</p>
    <template #footer>
      <button type="button" class="ds-btn ds-btn--primary ds-btn--sm" @click="open = false">
        {{ t('app.close') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.help-tip-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}

.help-tip-btn::after {
  content: '';
  position: absolute;
  inset: -8px;
}

.help-tip-btn:hover {
  color: var(--accent);
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.help-tip-body {
  margin: 0;
  font-size: 0.94rem;
  line-height: 1.55;
  color: var(--text-secondary);
}
</style>
