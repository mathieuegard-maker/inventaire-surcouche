<!-- src/client/components/books/BookActions.vue -->
<script setup lang="ts">
import { ref } from 'vue';
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
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('batch.statusUpdatedToast'), 'success');
    emit('updated');
  } finally {
    busy.value = false;
  }
}

async function handleReturn(): Promise<void> {
  busy.value = true;
  try {
    const res = await libraryStore.returnBooks([props.book.id]);
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('loans.returnedToast'), 'success');
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
    uiStore.pushToast(
      res.offlineQueued ? t('batch.offlineQueuedToast') : t('loans.lentToast', { name: payload.borrowerName }),
      'success'
    );
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
    uiStore.pushToast(res.offlineQueued ? t('batch.offlineQueuedToast') : t('batch.statusUpdatedToast'), 'success');
    emit('updated');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="ds-row">
    <button
      v-if="book.ownershipStatus !== 'owned' && !book.ownedViaIntegral"
      type="button"
      class="ds-btn ds-btn--primary"
      :disabled="busy"
      @click="setStatus('owned')"
    >
      {{ t('book.addOwnedBtn') }}
    </button>

    <button
      v-if="book.ownershipStatus === 'none' && !book.ownedViaIntegral"
      type="button"
      class="ds-btn"
      :disabled="busy"
      @click="setStatus('wish')"
    >
      {{ t('book.addWishBtn') }}
    </button>

    <button
      v-if="book.ownershipStatus === 'owned' && !book.activeLoan"
      type="button"
      class="ds-btn"
      :disabled="busy"
      @click="lendOpen = true"
    >
      {{ t('book.lendBtn') }}
    </button>

    <button
      v-if="book.activeLoan"
      type="button"
      class="ds-btn ds-btn--primary"
      :disabled="busy"
      @click="handleReturn"
    >
      {{ t('loans.returnBook') }}
    </button>

    <button
      v-if="book.ownershipStatus === 'owned' || book.ownershipStatus === 'wish' || book.activeLoan"
      type="button"
      class="ds-btn ds-btn--danger"
      :disabled="busy"
      @click="deleteOpen = true"
    >
      {{ t('app.delete') }}
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
