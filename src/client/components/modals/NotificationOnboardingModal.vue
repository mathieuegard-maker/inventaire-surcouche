<!-- src/client/components/modals/NotificationOnboardingModal.vue -->
<script setup lang="ts">
import { ref } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import { apiRequest } from '../../api/client';
import { useAuthStore } from '../../stores/auth.store';
import { useUiStore } from '../../stores/ui.store';
import type { NotificationChannel, NotificationFrequency } from '../../../shared/types/domain.types';
import { t } from '../../../shared/locales';

defineProps<{
  open: boolean;
}>();

const authStore = useAuthStore();
const uiStore = useUiStore();

const frequency = ref<NotificationFrequency>('weekly');
const channel = ref<NotificationChannel>('email');
const saving = ref(false);

async function markSeenAndSave(skip: boolean): Promise<void> {
  saving.value = true;
  try {
    if (!skip) {
      await apiRequest('/api/notifications/prefs', {
        method: 'PUT',
        body: {
          frequency: frequency.value,
          dayOfWeek: 6,
          dayOfMonth: 1,
          hour: 9,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris',
          channel: channel.value
        }
      });
      uiStore.pushToast(t('profile.notifSavedToast'), 'success');
    }
    await authStore.updateProfile({ onboardingNotifSeen: true });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('profile.notifOnboardingTitle')"
    max-width="500px"
    @close="markSeenAndSave(true)"
  >
    <div class="ds-stack">
      <p class="ds-text-muted">{{ t('profile.notifOnboardingDesc') }}</p>

      <div class="ds-field">
        <label class="ds-label" for="onb-freq">{{ t('profile.notifFrequencyLabel') }}</label>
        <select id="onb-freq" v-model="frequency" class="ds-input">
          <option value="off">{{ t('profile.notifOff') }}</option>
          <option value="daily">{{ t('profile.notifDaily') }}</option>
          <option value="weekly">{{ t('profile.notifWeekly') }}</option>
          <option value="monthly">{{ t('profile.notifMonthly') }}</option>
        </select>
      </div>

      <div v-if="frequency !== 'off'" class="ds-field">
        <label class="ds-label" for="onb-chan">{{ t('profile.notifChannelLabel') }}</label>
        <select id="onb-chan" v-model="channel" class="ds-input">
          <option value="email">{{ t('profile.notifChannelEmail') }}</option>
          <option value="push">{{ t('profile.notifChannelPush') }}</option>
          <option value="both">{{ t('profile.notifChannelBoth') }}</option>
        </select>
      </div>
    </div>

    <template #footer>
      <button type="button" class="ds-btn" :disabled="saving" @click="markSeenAndSave(true)">
        {{ t('profile.notifOnboardingSkipBtn') }}
      </button>
      <button type="button" class="ds-btn ds-btn--primary" :disabled="saving" @click="markSeenAndSave(false)">
        {{ saving ? t('app.loading') : t('profile.saveNotifsBtn') }}
      </button>
    </template>
  </BaseModal>
</template>
