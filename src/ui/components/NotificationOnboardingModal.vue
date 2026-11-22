<script setup lang="ts">
import { ref } from 'vue';
import { userService } from '../../core/services/user.service';

defineProps<{
  show: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const frequency = ref<'off' | 'daily' | 'weekly' | 'monthly'>('weekly');
const channel = ref<'push' | 'email' | 'both'>('push');
const weekday = ref<number>(6);
const hour = ref<number>(9);
const saving = ref(false);
const errorMsg = ref('');

const urlBase64ToUint8Array = (base64String: string) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
};

const dismissLater = async () => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('biblio_show_notif_onboarding');
  }
  await userService.markNotifOnboardingSeen();
  emit('close');
};

const handleSave = async () => {
  saving.value = true;
  errorMsg.value = '';
  try {
    const timezone =
      (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Europe/Paris';

    if (frequency.value !== 'off' && channel.value !== 'email') {
      const prefs = await userService.getNotificationPrefs().catch(() => null);
      if (
        prefs?.vapidPublicKey &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        'serviceWorker' in navigator
      ) {
        const permission = await Notification.requestPermission().catch(() => 'denied');
        if (permission === 'granted') {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg?.pushManager) {
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
              sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(prefs.vapidPublicKey)
              });
            }
            await userService.subscribeWebPush(sub.toJSON()).catch(() => {});
          }
        }
      }
    }

    await userService.saveNotificationPrefs({
      digestFrequency: frequency.value,
      digestHour: hour.value,
      digestWeekday: weekday.value,
      digestDayOfMonth: 1,
      digestTimezone: timezone,
      digestChannel: channel.value
    });

    await dismissLater();
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : 'Erreur lors de la sauvegarde.';
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="dismissLater">
      <div class="modal-box" role="dialog" aria-modal="true" aria-label="Notifications des nouveautés">
        <h2>Notifications des nouveautés</h2>
        <p class="modal-text">
          Souhaitez-vous être prévenu lorsque de nouveaux tomes paraissent dans les séries que vous possédez ? Vous pourrez modifier ce réglage à tout moment dans <strong>Mon profil → Notifications</strong>.
        </p>

        <div class="onboard-fields">
          <label class="ds-field">
            <span>Fréquence</span>
            <select v-model="frequency" class="ds-input">
              <option value="weekly">Hebdomadaire (recommandé)</option>
              <option value="daily">Quotidien</option>
              <option value="monthly">Mensuel</option>
              <option value="off">Désactivé</option>
            </select>
          </label>

          <template v-if="frequency !== 'off'">
            <label class="ds-field">
              <span>Canal de réception</span>
              <select v-model="channel" class="ds-input">
                <option value="push">Notification sur l’appareil (Push)</option>
                <option value="email">E-mail</option>
                <option value="both">Notification Push + E-mail</option>
              </select>
            </label>
          </template>
        </div>

        <p v-if="errorMsg" class="onboard-err">{{ errorMsg }}</p>

        <div class="modal-actions">
          <button type="button" class="btn-action" :disabled="saving" @click="handleSave">
            {{ saving ? 'Enregistrement...' : 'Enregistrer' }}
          </button>
          <button type="button" class="btn-close" :disabled="saving" @click="dismissLater">
            Plus tard
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.onboard-fields {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.onboard-err {
  margin: 0;
  color: #b91c1c;
  font-size: 0.85rem;
  font-weight: 600;
}
</style>
