<!-- src/client/components/base/PaginationBar.vue -->
<!-- Pagination standardisée pour TOUTES les listes : choix 20 / 50 / 100 par page,
     saut direct compact « ‹ [3 / 17 ▾] › » et retour automatique en haut de page. -->
<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown, ChevronLeft, ChevronRight } from '@lucide/vue';
import { t } from '../../../shared/locales';

const props = withDefaults(
  defineProps<{
    page: number;
    totalPages: number;
    pageSize?: number;
    pageSizeOptions?: readonly number[];
    totalItems?: number;
    autoScrollTop?: boolean;
  }>(),
  {
    pageSizeOptions: () => [20, 50, 100],
    autoScrollTop: true
  }
);

const emit = defineEmits<{
  (e: 'update:page', next: number): void;
  (e: 'update:pageSize', next: number): void;
}>();

const pagesList = computed(() =>
  Array.from({ length: Math.max(1, props.totalPages) }, (_, idx) => idx + 1)
);

const shouldRender = computed(() => {
  if (props.totalPages > 1) return true;
  if (props.pageSize !== undefined && (props.totalItems ?? 0) > (props.pageSizeOptions[0] ?? 20)) {
    return true;
  }
  return props.pageSize !== undefined && (props.totalItems ?? 0) > 0;
});

function scrollToTop(): void {
  if (!props.autoScrollTop || typeof window === 'undefined') return;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToPage(next: number): void {
  const clamped = Math.min(Math.max(1, next), Math.max(1, props.totalPages));
  if (clamped === props.page) return;
  emit('update:page', clamped);
  scrollToTop();
}

function onSelectPage(event: Event): void {
  const val = Number((event.target as HTMLSelectElement).value);
  if (Number.isFinite(val)) {
    goToPage(val);
  }
}

function onSelectPageSize(event: Event): void {
  const val = Number((event.target as HTMLSelectElement).value);
  if (Number.isFinite(val) && val > 0) {
    emit('update:pageSize', val);
    scrollToTop();
  }
}
</script>

<template>
  <nav
    v-if="shouldRender"
    class="pagination-bar"
    :aria-label="t('collection.pageInfo', { page, total: Math.max(1, totalPages) })"
  >
    <div v-if="totalPages > 1" class="pagination-bar__nav">
      <button
        type="button"
        class="ds-btn ds-btn--sm pagination-bar__arrow"
        :disabled="page <= 1"
        :aria-label="t('collection.prevPage')"
        @click="goToPage(page - 1)"
      >
        <ChevronLeft :size="18" aria-hidden="true" />
      </button>

      <label class="pagination-bar__jump">
        <span class="pagination-bar__jump-label">
          {{ page }} / {{ totalPages }}
        </span>
        <ChevronDown :size="14" class="pagination-bar__jump-caret" aria-hidden="true" />
        <select
          class="pagination-bar__jump-select"
          :value="page"
          :aria-label="t('collection.jumpToPage')"
          @change="onSelectPage"
        >
          <option v-for="p in pagesList" :key="p" :value="p">
            {{ t('collection.pageOption', { page: p, total: totalPages }) }}
          </option>
        </select>
      </label>

      <button
        type="button"
        class="ds-btn ds-btn--sm pagination-bar__arrow"
        :disabled="page >= totalPages"
        :aria-label="t('collection.nextPage')"
        @click="goToPage(page + 1)"
      >
        <ChevronRight :size="18" aria-hidden="true" />
      </button>
    </div>

    <label v-if="pageSize !== undefined" class="pagination-bar__size">
      <select
        class="ds-input pagination-bar__size-select"
        :value="pageSize"
        :aria-label="t('collection.pageSizeLabel')"
        @change="onSelectPageSize"
      >
        <option v-for="size in pageSizeOptions" :key="size" :value="size">
          {{ t('collection.pageSizeOption', { size }) }}
        </option>
      </select>
    </label>
  </nav>
</template>

<style scoped>
.pagination-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-4) 0 var(--space-2);
}

.pagination-bar__nav {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.pagination-bar__arrow {
  min-inline-size: 40px;
  padding: 0 var(--space-2);
}

.pagination-bar__jump {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-block-size: 38px;
  padding: 0 0.85rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-weight: 600;
  font-size: 0.88rem;
  box-shadow: var(--shadow-sm);
  cursor: pointer;
}

.pagination-bar__jump-caret {
  color: var(--text-muted);
}

.pagination-bar__jump-select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.pagination-bar__size {
  display: inline-flex;
  align-items: center;
}

.pagination-bar__size-select {
  width: auto;
  min-block-size: 38px;
  padding: 0.3rem 0.7rem;
  font-size: 0.85rem;
  font-weight: 600;
}
</style>
