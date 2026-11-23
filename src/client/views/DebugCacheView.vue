<!-- src/client/views/DebugCacheView.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseModal from '../components/base/BaseModal.vue';
import { useLibraryStore } from '../stores/library.store';
import { useUiStore } from '../stores/ui.store';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import { t } from '../../shared/locales';

const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const query = ref('');
const clearModalOpen = ref(false);

const filteredBooks = computed(() => {
  const needle = normalizeTextKey(query.value);
  if (!needle) return libraryStore.books;
  return libraryStore.books.filter((b) =>
    normalizeTextKey([b.id, b.title, b.seriesName ?? '', ...b.knownIsbns].join(' ')).includes(needle)
  );
});

const lastSyncFormatted = computed(() => {
  if (!libraryStore.lastSyncAt) return t('debug.neverSynced');
  try {
    return new Date(libraryStore.lastSyncAt).toLocaleString('fr-FR');
  } catch {
    return libraryStore.lastSyncAt;
  }
});

async function handleRefresh(): Promise<void> {
  await libraryStore.hydrateFromLocalCache();
}

async function handleForceSync(): Promise<void> {
  const ok = await libraryStore.syncNow({ forceFullPull: true });
  uiStore.pushToast(ok ? t('batch.statusUpdatedToast') : t('app.offlineBanner'), ok ? 'success' : 'warning');
}

async function confirmClear(): Promise<void> {
  await libraryStore.clearCache();
  clearModalOpen.value = false;
  uiStore.pushToast(t('batch.statusUpdatedToast'), 'info');
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-row ds-row--between">
      <h1>{{ t('debug.title') }}</h1>
      <div class="ds-row">
        <button type="button" class="ds-btn ds-btn--sm" @click="handleRefresh">
          {{ t('debug.refreshBtn') }}
        </button>
        <button
          type="button"
          class="ds-btn ds-btn--primary ds-btn--sm"
          :disabled="libraryStore.isSyncing"
          @click="handleForceSync"
        >
          {{ t('debug.forceSyncBtn') }}
        </button>
        <button type="button" class="ds-btn ds-btn--danger ds-btn--sm" @click="clearModalOpen = true">
          {{ t('debug.clearBtn') }}
        </button>
      </div>
    </div>

    <div class="ds-card ds-stack">
      <p>
        {{
          t('debug.statsSummary', {
            books: libraryStore.books.length,
            series: libraryStore.series.length,
            loans: libraryStore.loans.length,
            outbox: libraryStore.outboxCount
          })
        }}
      </p>
      <p class="ds-text-muted">
        {{ t('debug.lastSyncLabel', { date: lastSyncFormatted }) }}
      </p>
      <input
        v-model="query"
        type="search"
        class="ds-input"
        :placeholder="t('debug.searchPlaceholder')"
      />
    </div>

    <div class="ds-stack">
      <div v-for="book in filteredBooks.slice(0, 100)" :key="book.id" class="ds-panel ds-row ds-row--between">
        <div>
          <strong>{{ book.title }}</strong>
          <p class="ds-text-muted">
            {{ book.id }} · {{ book.ownershipStatus }} · {{ book.primaryIsbn13 || '—' }}
          </p>
        </div>
        <span v-if="book.coverKey" class="ds-badge">{{ book.coverKey }}</span>
      </div>
    </div>

    <BaseModal :open="clearModalOpen" :title="t('debug.clearConfirmTitle')" @close="clearModalOpen = false">
      <p>{{ t('debug.clearConfirmDesc') }}</p>
      <template #footer>
        <button type="button" class="ds-btn" @click="clearModalOpen = false">
          {{ t('app.cancel') }}
        </button>
        <button type="button" class="ds-btn ds-btn--danger" @click="confirmClear">
          {{ t('app.confirm') }}
        </button>
      </template>
    </BaseModal>
  </section>
</template>
