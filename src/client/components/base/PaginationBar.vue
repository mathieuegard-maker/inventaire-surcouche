<!-- src/client/components/base/PaginationBar.vue -->
<!-- Pagination flottante fixe en bas de l'écran (juste au-dessus de la barre de navigation mobile) :
     toujours sous le pouce pour changer de page ou de taille (20 / 50 / 100), s'efface automatiquement
     dès qu'une sélection active affiche BatchActionBar ou qu'une modale s'ouvre. -->
<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown, ChevronLeft, ChevronRight } from '@lucide/vue';
import { useUiStore } from '../../stores/ui.store';
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

const uiStore = useUiStore();

const pagesList = computed(() =>
  Array.from({ length: Math.max(1, props.totalPages) }, (_, idx) => idx + 1)
);

const shouldRender = computed(() => {
  if (props.totalPages > 1) return true;
  if (props.pageSize !== undefined && (props.totalItems ?? 0) > 0) return true;
  return false;
});

const isVisibleFloating = computed(
  () => shouldRender.value && uiStore.batchBarActiveCount === 0 && uiStore.modalStack.length === 0
);

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
  <!-- Espace de respiration en fin de liste pour ne jamais masquer la dernière carte sous la barre fixe -->
  <div v-if="shouldRender" class="pagination-spacer" aria-hidden="true" />

  <Teleport to="body">
    <nav
      v-if="isVisibleFloating"
      class="pagination-dock"
      :aria-label="t('collection.pageInfo', { page, total: Math.max(1, totalPages) })"
    >
      <div class="pagination-dock__inner">
        <div class="pagination-dock__nav">
          <button
            type="button"
            class="ds-btn ds-btn--sm pagination-dock__arrow"
            :disabled="page <= 1"
            :aria-label="t('collection.prevPage')"
            @click="goToPage(page - 1)"
          >
            <ChevronLeft :size="17" aria-hidden="true" />
          </button>

          <label class="pagination-dock__jump">
            <span class="pagination-dock__jump-label">
              {{ page }} / {{ Math.max(1, totalPages) }}
            </span>
            <ChevronDown :size="13" class="pagination-dock__jump-caret" aria-hidden="true" />
            <select
              class="pagination-dock__jump-select"
              :value="page"
              :disabled="totalPages <= 1"
              :aria-label="t('collection.jumpToPage')"
              @change="onSelectPage"
            >
              <option v-for="p in pagesList" :key="p" :value="p">
                {{ t('collection.pageOption', { page: p, total: Math.max(1, totalPages) }) }}
              </option>
            </select>
          </label>

          <button
            type="button"
            class="ds-btn ds-btn--sm pagination-dock__arrow"
            :disabled="page >= totalPages"
            :aria-label="t('collection.nextPage')"
            @click="goToPage(page + 1)"
          >
            <ChevronRight :size="17" aria-hidden="true" />
          </button>
        </div>

        <label v-if="pageSize !== undefined" class="pagination-dock__size">
          <select
            class="ds-input pagination-dock__size-select"
            :value="pageSize"
            :aria-label="t('collection.pageSizeLabel')"
            @change="onSelectPageSize"
          >
            <option v-for="size in pageSizeOptions" :key="size" :value="size">
              {{ t('collection.pageSizeOption', { size }) }}
            </option>
          </select>
        </label>
      </div>
    </nav>
  </Teleport>
</template>

<style scoped>
.pagination-spacer {
  height: 64px;
}

.pagination-dock {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--space-3);
  z-index: 120;
  width: min(calc(100vw - 1.25rem), 460px);
  pointer-events: auto;
}

.pagination-dock__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 6px 10px;
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-md);
}

.pagination-dock__nav {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.pagination-dock__arrow {
  min-inline-size: 36px;
  min-block-size: 36px;
  padding: 0;
  border-radius: var(--radius-pill);
  box-shadow: none;
}

.pagination-dock__jump {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-block-size: 36px;
  padding: 0 0.7rem;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-weight: 700;
  font-size: 0.84rem;
  cursor: pointer;
}

.pagination-dock__jump-caret {
  color: var(--text-muted);
}

.pagination-dock__jump-select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}

.pagination-dock__size {
  display: inline-flex;
  align-items: center;
}

.pagination-dock__size-select {
  width: auto;
  min-block-size: 36px;
  padding: 0.25rem 0.65rem;
  border-radius: var(--radius-pill);
  font-size: 0.82rem;
  font-weight: 600;
}

@media (max-width: 820px) {
  .pagination-dock {
    bottom: calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px) + 8px);
  }
}
</style>
