<!-- src/client/components/modals/LendModal.vue -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import type { CachedLoanContact } from '../../cache/indexeddb';
import { t } from '../../../shared/locales';

const props = defineProps<{
  open: boolean;
  bookCount: number;
  contacts: CachedLoanContact[];
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', payload: { borrowerName: string; notes?: string }): void;
}>();

const borrowerName = ref('');
const notes = ref('');

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      borrowerName.value = '';
      notes.value = '';
    }
  }
);

function pickContact(name: string): void {
  borrowerName.value = name;
}

function handleSubmit(): void {
  const clean = borrowerName.value.trim();
  if (!clean) return;
  emit('confirm', {
    borrowerName: clean,
    notes: notes.value.trim() || undefined
  });
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('loans.lendModalTitle', { count: bookCount })"
    @close="emit('close')"
  >
    <form id="lend-modal-form" class="ds-stack" @submit.prevent="handleSubmit">
      <div class="ds-field">
        <label class="ds-label" for="lend-borrower-input">{{ t('loans.borrowerInputLabel') }}</label>
        <input
          id="lend-borrower-input"
          v-model="borrowerName"
          type="text"
          class="ds-input"
          :placeholder="t('loans.borrowerInputPlaceholder')"
          required
        />
      </div>

      <div v-if="contacts.length > 0" class="ds-chips">
        <button
          v-for="contact in contacts"
          :key="contact.name"
          type="button"
          class="ds-chip lend-contact-chip"
          @click="pickContact(contact.name)"
        >
          <span>{{ contact.name }}</span>
          <span v-if="contact.isFriend" class="ds-badge ds-badge--accent">{{ t('loans.friendTag') }}</span>
        </button>
      </div>

      <div class="ds-field">
        <label class="ds-label" for="lend-notes-input">{{ t('loans.notesLabel') }}</label>
        <input
          id="lend-notes-input"
          v-model="notes"
          type="text"
          class="ds-input"
          :placeholder="t('loans.notesPlaceholder')"
        />
      </div>
    </form>

    <template #footer>
      <button type="button" class="ds-btn" :disabled="busy" @click="emit('close')">
        {{ t('app.cancel') }}
      </button>
      <button
        type="submit"
        form="lend-modal-form"
        class="ds-btn ds-btn--primary"
        :disabled="busy || !borrowerName.trim()"
      >
        {{ busy ? t('app.loading') : t('loans.confirmLend') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.lend-contact-chip {
  cursor: pointer;
}

.lend-contact-chip:hover {
  border-color: var(--accent);
}
</style>
