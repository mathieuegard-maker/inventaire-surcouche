<!-- src/client/components/base/PwaReloadPrompt.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRegisterSW } from 'virtual:pwa-register/vue';
import BaseModal from './BaseModal.vue';
import { t } from '../../../shared/locales';

let swRegistration: ServiceWorkerRegistration | undefined;
const isUpdating = ref(false);

const { offlineReady, needRefresh, updateServiceWorker } = useRegisterSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    swRegistration = registration;
  }
});

const isOpen = computed(() => needRefresh.value || offlineReady.value);

const modalTitle = computed(() =>
  needRefresh.value ? t('pwa.updateAvailableTitle') : t('pwa.offlineReadyTitle')
);

function checkForUpdate(): void {
  if (swRegistration) {
    void swRegistration.update();
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    checkForUpdate();
  }
}

function dismissPrompt(): void {
  offlineReady.value = false;
  needRefresh.value = false;
}

async function applyUpdate(): Promise<void> {
  if (isUpdating.value) return;
  isUpdating.value = true;

  let reloaded = false;
  const doReload = () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', doReload, { once: true });
    if (swRegistration?.waiting) {
      swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  }

  const fallbackTimer = window.setTimeout(doReload, 1500);
  try {
    await updateServiceWorker(true);
  } catch {
    window.clearTimeout(fallbackTimer);
    doReload();
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', checkForUpdate);
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('focus', checkForUpdate);
});
</script>

<template>
  <BaseModal :open="isOpen" :title="modalTitle" @close="dismissPrompt">
    <p v-if="needRefresh">{{ t('pwa.updateAvailableMessage') }}</p>
    <p v-else>{{ t('pwa.offlineReadyMessage') }}</p>

    <template #footer>
      <template v-if="needRefresh">
        <button type="button" class="ds-btn" :disabled="isUpdating" @click="dismissPrompt">
          {{ t('pwa.laterBtn') }}
        </button>
        <button type="button" class="ds-btn ds-btn--primary" :disabled="isUpdating" @click="applyUpdate">
          {{ t('pwa.updateNowBtn') }}
        </button>
      </template>
      <button v-else type="button" class="ds-btn ds-btn--primary" @click="dismissPrompt">
        {{ t('pwa.understoodBtn') }}
      </button>
    </template>
  </BaseModal>
</template>
