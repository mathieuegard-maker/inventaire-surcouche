<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';
import { imageUtil } from '../../core/utils/image.util';

const props = defineProps<{
  book: HumanizedBook;
  modelValue?: boolean;
  selectableOnly?: boolean;
  extraBadges?: Array<{ label: string; tone?: 'info' | 'consensus' | 'warn' }>;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const router = useRouter();
const coverExhausted = ref(false);

watch(
  () => `${props.book.uri}|${props.book.localCover || ''}|${props.book.coverUrl || ''}`,
  () => {
    coverExhausted.value = false;
  }
);

const onCoverError = (event: Event) => {
  imageUtil.handleImageError(event, {
    isbn: props.book.isbn13 || props.book.isbn10,
    fallbackUrls: props.book.coverFallbackUrls,
    onExhausted: () => {
      coverExhausted.value = true;
    }
  });
};

const onCoverLoad = (event: Event) => {
  const img = event.target as HTMLImageElement | null;
  if (img && img.naturalWidth > 0 && (img.naturalWidth < 15 || img.naturalHeight < 15)) {
    onCoverError(event);
  }
};

const translateFriendName = (name?: string): string => {
  if (!name) return TEXTS.loansView?.unknownFriend || 'Inconnu';
  if (name === 'Inconnu') return TEXTS.loansView?.unknownFriend || 'Inconnu';
  if (name === 'Inconnu (Ajout web)') return TEXTS.loansView?.unknownFriendWeb || 'Inconnu (Ajout web)';
  if (name === 'Inconnu (Restauration)') return TEXTS.loansView?.unknownFriendRestored || 'Inconnu (Restauration)';
  return name;
};

const navigateToDetail = () => {
  if (props.selectableOnly) {
    emit('update:modelValue', !props.modelValue);
    return;
  }
  if (props.book.uri) {
    router.push(`/book/${encodeURIComponent(props.book.uri)}`);
  }
};

const handleZoneClick = () => {
  emit('update:modelValue', !props.modelValue);
};
</script>

<template>
  <div class="mini-card-row" @click="navigateToDetail">
    
    <div class="row-cover-container">
      <img
        v-if="!coverExhausted && (book.localCover || book.coverUrl || book.isbn13 || book.isbn10)"
        :src="imageUtil.resolveCoverUrl(book.localCover ? book : (book.coverUrl || imageUtil.buildCoverCandidates(book.isbn13 || book.isbn10)[0] || ''))"
        :data-cover-isbn="book.isbn13 || book.isbn10"
        :alt="book.title"
        class="row-cover-image"
        @load="onCoverLoad"
        @error="onCoverError"
      />
      <div v-else class="row-cover-fallback">
        <span class="fallback-title">{{ book.title }}</span>
      </div>
      
      <div v-if="book.seriesNumber" class="volume-number">
        {{ /^(?:int|hs)\b/i.test(book.seriesNumber.trim()) ? book.seriesNumber : `T.${book.seriesNumber}` }}
      </div>
    </div>

    <div class="row-info-content">
      <p class="row-title">{{ book.title }}</p>
      
      <p v-if="book.loan?.friendName" class="row-authors">
        Prêté à : {{ translateFriendName(book.loan.friendName) }}
      </p>
      <p v-else-if="book.series" class="row-series-meta">
        {{ book.series }}
        <span v-if="book.seriesNumber">
          — {{ /^(?:int|hs)\b/i.test(book.seriesNumber.trim()) ? book.seriesNumber : `Tome ${book.seriesNumber}` }}
        </span>
      </p>
      
      <p v-if="book.authors?.length && !book.loan" class="row-authors">
        {{ book.authors.join(', ') }}
      </p>

      <div v-if="extraBadges && extraBadges.length > 0" class="row-extra-badges">
        <span
          v-for="(badge, bi) in extraBadges"
          :key="bi"
          :class="['row-mini-badge', badge.tone || 'info']"
        >
          {{ badge.label }}
        </span>
      </div>

      <div v-if="$slots.extra" class="row-extra-slot" @click.stop>
        <slot name="extra" />
      </div>
    </div>

    <div class="row-status-text-column">
      <span :class="['status-text-label', book.loan ? 'lent' : book.ownershipStatus]">
        {{ 
          book.loan ? TEXTS.bookStatus?.lent || 'Prêté' :
          book.ownershipStatus === 'owned' ? TEXTS.bookStatus?.owned : 
          book.ownershipStatus === 'wish' ? (book.wishedByName ? `Souhaité · ${book.wishedByName}` : TEXTS.bookStatus?.wish) : 
          TEXTS.bookStatus?.none 
        }}
      </span>
    </div>

    <div class="row-selection-area" @click.stop="handleZoneClick">
      <input 
        type="checkbox" 
        class="wireframe-checkbox item-checkbox"
        :checked="modelValue"
        @click.stop
        @change.stop="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
    </div>

  </div>
</template>

<style scoped>
.row-extra-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.25rem;
}

.row-mini-badge {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.06rem 0.38rem;
  border-radius: 9999px;
}

.row-mini-badge.info {
  background: #e0f2fe;
  color: #0369a1;
}

.row-mini-badge.consensus {
  background: #ede9fe;
  color: #5b21b6;
}

.row-mini-badge.warn {
  background: #fef3c7;
  color: #92400e;
}
</style>