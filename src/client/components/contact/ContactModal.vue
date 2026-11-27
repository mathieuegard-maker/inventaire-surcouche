<!-- src/client/components/contact/ContactModal.vue -->
<!-- Modale de contact accessible vers l'administrateur (accessible connecté depuis Mon Profil ou non connecté depuis Connexion). -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { AlertCircle, CheckCircle2, Send } from '@lucide/vue';
import BaseModal from '../base/BaseModal.vue';
import { useAuthStore } from '../../stores/auth.store';
import { useUiStore } from '../../stores/ui.store';
import { apiRequest, ApiClientError } from '../../api/client';
import { t } from '../../../shared/locales';
import type { ContactCategory } from '../../../shared/schemas';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const route = useRoute();
const authStore = useAuthStore();
const uiStore = useUiStore();

const category = ref<ContactCategory>('question');
const email = ref('');
const senderName = ref('');
const subject = ref('');
const message = ref('');
const websiteHoneypot = ref('');

const emailTouched = ref(false);
const messageTouched = ref(false);
const submitting = ref(false);
const serverError = ref('');
const sentSuccess = ref(false);

const emailInputRef = ref<HTMLInputElement | null>(null);
const messageInputRef = ref<HTMLTextAreaElement | null>(null);

const categoryOptions = computed<Array<{ value: ContactCategory; label: string }>>(() => [
  { value: 'question', label: t('contact.categoryQuestion') },
  { value: 'bug', label: t('contact.categoryBug') },
  { value: 'suggestion', label: t('contact.categorySuggestion') },
  { value: 'other', label: t('contact.categoryOther') }
]);

const emailIsValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()));
const messageIsValid = computed(() => message.value.trim().length >= 10);

const showEmailError = computed(() => emailTouched.value && !emailIsValid.value);
const showMessageError = computed(() => messageTouched.value && !messageIsValid.value);

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    category.value = 'question';
    email.value = authStore.profile?.user.email ?? '';
    senderName.value = authStore.profile?.user.username ?? '';
    subject.value = '';
    message.value = '';
    websiteHoneypot.value = '';
    emailTouched.value = false;
    messageTouched.value = false;
    serverError.value = '';
    sentSuccess.value = false;
  }
);

function handleClose(): void {
  if (submitting.value) return;
  emit('close');
}

async function handleSubmit(): Promise<void> {
  serverError.value = '';
  emailTouched.value = true;
  messageTouched.value = true;

  if (!emailIsValid.value) {
    emailInputRef.value?.focus();
    return;
  }
  if (!messageIsValid.value) {
    messageInputRef.value?.focus();
    return;
  }

  submitting.value = true;
  try {
    await apiRequest('/api/contact', {
      method: 'POST',
      body: {
        email: email.value.trim(),
        senderName: senderName.value.trim() || undefined,
        category: category.value,
        subject: subject.value.trim() || undefined,
        message: message.value.trim(),
        pageUrl: route.fullPath || '/',
        website: websiteHoneypot.value
      }
    });
    sentSuccess.value = true;
    uiStore.pushToast(t('contact.successToast'), 'success');
  } catch (err) {
    serverError.value = err instanceof ApiClientError ? err.message : t('app.retry');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('contact.modalTitle')"
    max-width="540px"
    @close="handleClose"
  >
    <div v-if="sentSuccess" class="ds-stack contact-success" role="status" aria-live="polite">
      <div class="ds-banner ds-banner--success contact-banner-row">
        <CheckCircle2 :size="18" aria-hidden="true" />
        <span>{{ t('contact.successBanner') }}</span>
      </div>
    </div>

    <form
      v-else
      id="contact-admin-form"
      class="ds-stack--sm"
      method="POST"
      novalidate
      @submit.prevent="handleSubmit"
    >
      <p class="ds-text-muted">{{ t('contact.modalIntro') }}</p>

      <div v-if="serverError" class="ds-banner ds-banner--danger contact-banner-row" role="alert">
        <AlertCircle :size="16" aria-hidden="true" />
        <span>{{ serverError }}</span>
      </div>

      <!-- Champ honeypot anti-spam masqué aux lecteurs d'écran et à la navigation clavier -->
      <div class="contact-hp" aria-hidden="true">
        <label for="contact-website">Site web</label>
        <input
          id="contact-website"
          v-model="websiteHoneypot"
          type="text"
          name="website"
          tabindex="-1"
          autocomplete="off"
        />
      </div>

      <fieldset class="contact-fieldset">
        <legend class="ds-label">{{ t('contact.categoryLegend') }}</legend>
        <div class="contact-radios">
          <label
            v-for="opt in categoryOptions"
            :key="opt.value"
            class="contact-radio-pill"
            :class="{ 'contact-radio-pill--active': category === opt.value }"
          >
            <input
              v-model="category"
              type="radio"
              name="contact-category"
              :value="opt.value"
              class="contact-radio-input"
            />
            <span>{{ opt.label }}</span>
          </label>
        </div>
      </fieldset>

      <div class="ds-field">
        <label class="ds-label" for="contact-email">
          {{ t('contact.emailLabel') }} <span aria-hidden="true">*</span>
        </label>
        <span id="contact-email-hint" class="contact-hint">{{ t('contact.emailHint') }}</span>
        <input
          id="contact-email"
          ref="emailInputRef"
          v-model="email"
          name="email"
          type="email"
          class="ds-input contact-validated-input"
          :class="{ 'contact-input--invalid': showEmailError }"
          autocomplete="email"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
          enterkeyhint="next"
          required
          :aria-invalid="showEmailError ? 'true' : 'false'"
          :aria-describedby="showEmailError ? 'contact-email-hint contact-email-error' : 'contact-email-hint'"
          @blur="emailTouched = true"
        />
        <p v-if="showEmailError" id="contact-email-error" class="contact-error">
          <AlertCircle :size="14" aria-hidden="true" />
          <span>{{ t('contact.emailError') }}</span>
        </p>
      </div>

      <div v-if="!authStore.isAuthenticated" class="ds-field">
        <label class="ds-label" for="contact-name">{{ t('contact.nameLabel') }}</label>
        <input
          id="contact-name"
          v-model="senderName"
          name="senderName"
          type="text"
          class="ds-input"
          autocomplete="name"
          maxlength="80"
          enterkeyhint="next"
        />
      </div>

      <div class="ds-field">
        <label class="ds-label" for="contact-subject">{{ t('contact.subjectLabel') }}</label>
        <input
          id="contact-subject"
          v-model="subject"
          name="subject"
          type="text"
          class="ds-input"
          :placeholder="t('contact.subjectPlaceholder')"
          maxlength="140"
          enterkeyhint="next"
        />
      </div>

      <div class="ds-field">
        <label class="ds-label" for="contact-message">
          {{ t('contact.messageLabel') }} <span aria-hidden="true">*</span>
        </label>
        <span id="contact-message-hint" class="contact-hint">{{ t('contact.messageHint') }}</span>
        <textarea
          id="contact-message"
          ref="messageInputRef"
          v-model="message"
          name="message"
          rows="5"
          class="ds-textarea contact-validated-input"
          :class="{ 'contact-input--invalid': showMessageError }"
          :placeholder="t('contact.messagePlaceholder')"
          minlength="10"
          maxlength="4000"
          required
          :aria-invalid="showMessageError ? 'true' : 'false'"
          :aria-describedby="showMessageError ? 'contact-message-hint contact-message-error' : 'contact-message-hint'"
          @blur="messageTouched = true"
        />
        <p v-if="showMessageError" id="contact-message-error" class="contact-error">
          <AlertCircle :size="14" aria-hidden="true" />
          <span>{{ t('contact.messageError') }}</span>
        </p>
      </div>
    </form>

    <template #footer>
      <template v-if="sentSuccess">
        <button type="button" class="ds-btn ds-btn--primary" @click="handleClose">
          {{ t('contact.closeAfterSuccessBtn') }}
        </button>
      </template>
      <template v-else>
        <button type="button" class="ds-btn" :disabled="submitting" @click="handleClose">
          {{ t('app.cancel') }}
        </button>
        <button
          type="submit"
          form="contact-admin-form"
          class="ds-btn ds-btn--primary"
          :disabled="submitting"
        >
          <Send :size="15" aria-hidden="true" />
          {{ submitting ? t('contact.sendingBtn') : t('contact.submitBtn') }}
        </button>
      </template>
    </template>
  </BaseModal>
</template>

<style scoped>
.contact-hp {
  position: absolute;
  inset-inline-start: -9999px;
  width: 1px;
  height: 1px;
  overflow: hidden;
  pointer-events: none;
}

.contact-fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.contact-radios {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.contact-radio-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-block-size: 40px;
  padding: 0.4rem 0.75rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.contact-radio-pill:hover {
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.contact-radio-pill--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.contact-radio-input {
  accent-color: var(--accent);
  margin: 0;
}

.contact-hint {
  display: block;
  font-size: 0.82rem;
  color: var(--text-muted);
  margin-block-end: 2px;
}

.contact-validated-input:user-invalid,
.contact-input--invalid {
  border-color: var(--danger);
}

.contact-error {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-block-start: 4px;
  font-size: 0.84rem;
  color: var(--danger);
}

.contact-banner-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.contact-success {
  padding-block: var(--space-2);
}
</style>
