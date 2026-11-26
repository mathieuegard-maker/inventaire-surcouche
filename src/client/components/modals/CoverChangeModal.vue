<!-- src/client/components/modals/CoverChangeModal.vue -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import CoverPicker, { type CoverPropagationPlan } from '../books/CoverPicker.vue';
import { useLibraryStore } from '../../stores/library.store';
import { useUiStore } from '../../stores/ui.store';
import { ApiClientError } from '../../api/client';
import type { BookView } from '../../../shared/types/domain.types';
import { t } from '../../../shared/locales';

const props = defineProps<{
  open: boolean;
  book: BookView;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved'): void;
}>();

const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const draftCoverKey = ref<string | null>(null);
const propagationPlan = ref<CoverPropagationPlan | null>(null);
const saving = ref(false);

watch(
  () => [props.open, props.book.id, props.book.coverKey] as const,
  ([isOpen]) => {
    if (isOpen) {
      draftCoverKey.value = props.book.coverKey;
      propagationPlan.value = null;
    }
  },
  { immediate: true }
);

async function handleConfirm(): Promise<void> {
  if (!draftCoverKey.value) return;
  saving.value = true;
  try {
    const plan = propagationPlan.value;
    const isSeriesEditionApply = Boolean(
      props.book.seriesId &&
        plan &&
        plan.targetEdition &&
        (plan.scope !== 'single' || plan.targetEdition.isbn13)
    );

    if (isSeriesEditionApply && props.book.seriesId && plan) {
      const res = await libraryStore.applySeriesEditionCovers(props.book.seriesId, {
        sourceBookId: props.book.id,
        sourceCoverKey: draftCoverKey.value,
        scope: plan.scope,
        bookIds: plan.scope === 'selected' ? plan.selectedBookIds : [],
        targetEdition: {
          isbn13: plan.targetEdition?.isbn13 ?? null,
          publisher: plan.targetEdition?.publisher ?? null,
          collectionName: plan.targetEdition?.collectionName ?? null,
          isbnPrefix: plan.targetEdition?.isbnPrefix ?? null,
          lineageKey: plan.targetEdition?.lineageKey ?? null,
          label: plan.targetEdition?.lineageLabel ?? null
        },
        searchMissingInBackground: plan.searchMissingInBackground
      });

      if (res.backgroundJobId && res.missingBookIds.length > 0) {
        uiStore.pushToast(
          t('book.coverAppliedWithJobToast', {
            count: res.appliedCount,
            missing: res.missingBookIds.length
          }),
          'success'
        );
      } else if (res.appliedCount > 1) {
        uiStore.pushToast(t('book.coverAppliedMultiToast', { count: res.appliedCount }), 'success');
      } else {
        uiStore.pushToast(t('book.coverAppliedSingleToast'), 'success');
      }
    } else {
      await libraryStore.saveBookOverrides(props.book.id, {
        coverKey: draftCoverKey.value
      });
      uiStore.pushToast(t('book.coverAppliedSingleToast'), 'success');
    }

    emit('saved');
    emit('close');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('book.changeCoverModalTitle')"
    @close="!saving && emit('close')"
  >
    <CoverPicker
      v-if="open"
      v-model="draftCoverKey"
      :book-id="book.id"
      :series-id="book.seriesId"
      @update:propagation-plan="propagationPlan = $event"
    />

    <template #footer>
      <button type="button" class="ds-btn" :disabled="saving" @click="emit('close')">
        {{ t('app.cancel') }}
      </button>
      <button
        type="button"
        class="ds-btn ds-btn--primary"
        :disabled="saving || !draftCoverKey"
        @click="handleConfirm"
      >
        {{ saving ? t('app.loading') : t('app.save') }}
      </button>
    </template>
  </BaseModal>
</template>
