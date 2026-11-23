<!-- src/client/components/modals/BatchGenreModal.vue -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import { t } from '../../../shared/locales';

const props = defineProps<{
  open: boolean;
  bookCount: number;
  defaultGenres: string[];
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', genres: string[]): void;
  (e: 'add-default-genre', genre: string): void;
}>();

const selectedGenres = ref<string[]>([]);
const customInput = ref('');

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      selectedGenres.value = [];
      customInput.value = '';
    }
  }
);

function toggleGenre(genre: string): void {
  const idx = selectedGenres.value.indexOf(genre);
  if (idx >= 0) {
    selectedGenres.value.splice(idx, 1);
  } else {
    selectedGenres.value.push(genre);
  }
}

function addCustomToBatch(): void {
  const clean = customInput.value.trim();
  if (!clean) return;
  if (!selectedGenres.value.includes(clean)) {
    selectedGenres.value.push(clean);
  }
  customInput.value = '';
}

function addCustomToDefaults(): void {
  const clean = customInput.value.trim();
  if (!clean) return;
  if (!selectedGenres.value.includes(clean)) {
    selectedGenres.value.push(clean);
  }
  emit('add-default-genre', clean);
  customInput.value = '';
}

function handleConfirm(): void {
  if (selectedGenres.value.length === 0) return;
  emit('confirm', [...selectedGenres.value]);
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('batch.genresModalTitle', { count: bookCount })"
    max-width="560px"
    @close="emit('close')"
  >
    <div class="ds-stack">
      <div class="ds-chips">
        <button
          v-for="genre in defaultGenres"
          :key="genre"
          type="button"
          class="ds-chip genre-pick-chip"
          :class="{ 'genre-pick-chip--active': selectedGenres.includes(genre) }"
          @click="toggleGenre(genre)"
        >
          {{ genre }}
        </button>
      </div>

      <div class="ds-row">
        <input
          v-model="customInput"
          type="text"
          class="ds-input genre-custom-input"
          :placeholder="t('batch.genresCustomPlaceholder')"
          @keydown.enter.prevent="addCustomToBatch"
        />
        <button type="button" class="ds-btn ds-btn--sm" :disabled="!customInput.trim()" @click="addCustomToBatch">
          {{ t('batch.genresAddToBatch') }}
        </button>
        <button type="button" class="ds-btn ds-btn--sm" :disabled="!customInput.trim()" @click="addCustomToDefaults">
          {{ t('book.addGenreToDefaults') }}
        </button>
      </div>

      <div v-if="selectedGenres.length > 0" class="ds-chips">
        <span v-for="genre in selectedGenres" :key="genre" class="ds-chip genre-pick-chip--active">
          <span>{{ genre }}</span>
          <button type="button" class="ds-chip__remove" :aria-label="t('app.delete')" @click="toggleGenre(genre)">
            ×
          </button>
        </span>
      </div>
    </div>

    <template #footer>
      <button type="button" class="ds-btn" :disabled="busy" @click="emit('close')">
        {{ t('app.cancel') }}
      </button>
      <button
        type="button"
        class="ds-btn ds-btn--primary"
        :disabled="busy || selectedGenres.length === 0"
        @click="handleConfirm"
      >
        {{ busy ? t('app.loading') : t('batch.genresApplyBtn', { count: selectedGenres.length }) }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.genre-pick-chip {
  cursor: pointer;
}

.genre-pick-chip--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.genre-custom-input {
  flex: 1;
  min-width: 180px;
}
</style>
