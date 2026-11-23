<!-- src/client/components/books/BookCard.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { BookView } from '../../../shared/types/domain.types';
import { formatIntegralRangeLabel } from '../../../shared/bibliographic/integral.util';
import { t } from '../../../shared/locales';

const props = withDefaults(
  defineProps<{
    book: BookView;
    selectable?: boolean;
    selected?: boolean;
    showWishedBy?: boolean;
  }>(),
  {
    selectable: false,
    selected: false,
    showWishedBy: false
  }
);

const emit = defineEmits<{
  (e: 'toggle-select', bookId: string): void;
  (e: 'open', bookId: string): void;
}>();

const authorLine = computed(() =>
  props.book.authors.length > 0 ? props.book.authors.join(', ') : t('app.unknownAuthor')
);

const volumeBadge = computed(() => {
  if (props.book.isIntegral) {
    return formatIntegralRangeLabel(props.book.includedVolumes, props.book.volumeLabel ?? undefined);
  }
  if (props.book.volumeLabel) {
    return `T.${props.book.volumeLabel}`;
  }
  return '';
});
</script>

<template>
  <article
    class="book-card"
    :class="{ 'book-card--selected': selected }"
  >
    <div v-if="selectable" class="book-card__select">
      <input
        type="checkbox"
        :checked="selected"
        :aria-label="t('collection.selectItem', { title: book.title })"
        @change="emit('toggle-select', book.id)"
      />
    </div>

    <div class="book-card__main" @click="emit('open', book.id)">
      <div class="book-card__cover">
        <img
          v-if="book.coverUrl"
          :src="book.coverUrl"
          :alt="book.title"
          loading="lazy"
          decoding="async"
        />
        <div v-else class="book-card__placeholder">
          <span>{{ book.title.slice(0, 2).toUpperCase() }}</span>
        </div>
      </div>

      <div class="book-card__body">
        <div class="book-card__badges">
          <span v-if="volumeBadge" class="ds-badge">{{ volumeBadge }}</span>
          <span v-if="book.activeLoan" class="book-badge book-badge--lent">
            {{ t('loans.lentTo', { name: book.activeLoan.borrowerName }) }}
          </span>
          <span v-else-if="book.ownershipStatus === 'owned'" class="book-badge book-badge--owned">
            {{ t('book.statusOwned') }}
          </span>
          <span v-else-if="book.ownershipStatus === 'wish'" class="book-badge book-badge--wish">
            {{ t('book.statusWished') }}
          </span>
          <span v-else-if="book.ownedViaIntegral" class="book-badge book-badge--integral">
            {{ t('book.statusCoveredByIntegral') }}
          </span>
        </div>

        <h3 class="book-card__title">{{ book.title }}</h3>
        <p v-if="book.seriesName" class="book-card__series">{{ book.seriesName }}</p>
        <p class="ds-text-muted book-card__author">{{ authorLine }}</p>

        <p v-if="showWishedBy && book.wishedByName" class="ds-text-muted book-card__wished-by">
          {{ t('wishlist.wishedBy', { name: book.wishedByName }) }}
        </p>
      </div>
    </div>

    <div v-if="$slots.actions" class="book-card__actions">
      <slot name="actions" />
    </div>
  </article>
</template>

<style scoped>
.book-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.book-card--selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.book-card__select {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  z-index: 2;
}

.book-card__select input[type='checkbox'] {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
  cursor: pointer;
}

.book-card__main {
  display: flex;
  gap: var(--space-3);
  cursor: pointer;
}

.book-card__cover {
  flex: 0 0 64px;
  width: 64px;
  height: 92px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

.book-card__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.book-card__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: var(--text-muted);
}

.book-card__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-right: var(--space-5);
}

.book-card__badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.book-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 0.74rem;
  font-weight: 600;
}

.book-badge--owned {
  background: var(--status-owned-bg);
  color: var(--status-owned-text);
}

.book-badge--wish {
  background: var(--status-wish-bg);
  color: var(--status-wish-text);
}

.book-badge--lent {
  background: var(--status-lent-bg);
  color: var(--status-lent-text);
}

.book-badge--integral {
  background: var(--status-integral-bg);
  color: var(--status-integral-text);
}

.book-card__title {
  font-size: 0.96rem;
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.book-card__series {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--accent);
}

.book-card__author,
.book-card__wished-by {
  font-size: 0.82rem;
}

.book-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}
</style>
