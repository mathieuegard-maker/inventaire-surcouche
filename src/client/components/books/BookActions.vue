<!-- src/client/components/books/BookActions.vue -->
<script setup lang="ts">
import { ref } from 'vue';
import { ArrowLeftRight, Check, Plus, Star, Trash2 } from '@lucide/vue';
import ConfirmDeleteModal from '../modals/ConfirmDeleteModal.vue';
import LendModal from '../modals/LendModal.vue';
import { useLibraryStore } from '../../stores/library.store';
import { useUiStore } from '../../stores/ui.store';
import type { BookView } from '../../../shared/types/domain.types';
import { t } from '../../../shared/locales';

const props = defineProps<{
  book: BookView;
}>();

const emit = defineEmits<{
  (e: 'updated'): void;
}>();

const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const busy = ref(false);
const lendOpen = ref(false);
const deleteOpen = ref(false);

async function setStatus(status: 'owned' | 'wish'): Promise<void> {
  busy.value = true;
  try {
    const res = await libraryStore.applyBatchStatus({
      bookIds: [props.book.id],
      status
    });
    if (res.offlineQueued) {
      uiStore.pushToast(t('batch.offlineQueuedToast'), 'info');
    }
    emit('updated');
  } finally {
    busy.value = false;
  }
}

async function handleReturn(): Promise<void> {
  busy.value = true;
  try {
    const res = await libraryStore.returnBooks([props.book.id]);
    if (res.offlineQueued) {
      uiStore.pushToast(t('batch.offlineQueuedToast'), 'info');
    }
    emit('updated');
  } finally {
    busy.value = false;
  }
}

async function confirmLend(payload: { borrowerName: string; notes?: string }): Promise<void> {
  busy.value = true;
  try {
    const res = await libraryStore.lendBooks({
      bookIds: [props.book.id],
      borrowerName: payload.borrowerName,
      notes: payload.notes
    });
    lendOpen.value = false;
    if (res.offlineQueued) {
      uiStore.pushToast(t('batch.offlineQueuedToast'), 'info');
    }
    emit('updated');
  } finally {
    busy.value = false;
  }
}

async function confirmDelete(payload: {
  bookIds: string[];
  lentDecisions: Record<string, 'keep' | 'return_and_delete'>;
}): Promise<void> {
  busy.value = true;
  try {
    const res = await libraryStore.applyBatchStatus({
      bookIds: payload.bookIds,
      status: 'none',
      lentDecisions: payload.lentDecisions
    });
    deleteOpen.value = false;
    if (res.offlineQueued) {
      uiStore.pushToast(t('batch.offlineQueuedToast'), 'info');
    }
    emit('updated');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="book-primary-actions">
    <button
      v-if="book.ownershipStatus !== 'owned' && !book.ownedViaIntegral"
      type="button"
      class="ds-btn ds-btn--primary ds-btn--lg"
      :disabled="busy"
      @click="setStatus('owned')"
    >
      <Plus :size="18" aria-hidden="true" />
      <span>{{ t('book.addOwnedBtn') }}</span>
    </button>

    <button
      v-if="book.ownershipStatus === 'none' && !book.ownedViaIntegral"
      type="button"
      class="ds-btn ds-btn--soft ds-btn--lg"
      :disabled="busy"
      @click="setStatus('wish')"
    >
      <Star :size="18" aria-hidden="true" />
      <span>{{ t('book.addWishBtn') }}</span>
    </button>

    <button
      v-if="book.ownershipStatus === 'owned' && !book.activeLoan"
      type="button"
      class="ds-btn ds-btn--primary ds-btn--lg"
      :disabled="busy"
      @click="lendOpen = true"
    >
      <ArrowLeftRight :size="18" aria-hidden="true" />
      <span>{{ t('book.lendBtn') }}</span>
    </button>

    <button
      v-if="book.activeLoan"
      type="button"
      class="ds-btn ds-btn--primary ds-btn--lg"
      :disabled="busy"
      @click="handleReturn"
    >
      <Check :size="18" aria-hidden="true" />
      <span>{{ t('loans.returnBook') }}</span>
    </button>

    <button
      v-if="book.ownershipStatus === 'owned' || book.ownershipStatus === 'wish' || book.activeLoan"
      type="button"
      class="ds-btn ds-btn--danger-soft ds-btn--lg"
      :disabled="busy"
      @click="deleteOpen = true"
    >
      <Trash2 :size="18" aria-hidden="true" />
      <span>{{ t('app.delete') }}</span>
    </button>

    <LendModal
      :open="lendOpen"
      :book-count="1"
      :contacts="libraryStore.contacts"
      :busy="busy"
      @close="lendOpen = false"
      @confirm="confirmLend"
    />

    <ConfirmDeleteModal
      :open="deleteOpen"
      :books="[book]"
      :busy="busy"
      @close="deleteOpen = false"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.book-primary-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(155px, 100%), 1fr));
  gap: var(--space-2);
}
</style>
