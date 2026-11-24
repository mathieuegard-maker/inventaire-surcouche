<!-- src/client/components/books/CoverPicker.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useLibraryStore, type CoverCandidateItem } from '../../stores/library.store';
import { useUiStore } from '../../stores/ui.store';
import { ApiClientError } from '../../api/client';
import { t } from '../../../shared/locales';

const props = defineProps<{
  bookId?: string;
  modelValue: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', coverKey: string | null): void;
}>();

const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const fileInputRef = ref<HTMLInputElement | null>(null);
const urlInput = ref('');
const candidates = ref<CoverCandidateItem[]>([]);
const busy = ref(false);
const searchingExternal = ref(false);

async function loadCandidates(includeExternal = false): Promise<void> {
  if (!props.bookId) return;
  if (includeExternal) searchingExternal.value = true;
  try {
    candidates.value = await libraryStore.fetchCoverCandidates(props.bookId, includeExternal);
    if (includeExternal && candidates.value.length === 0) {
      uiStore.pushToast(t('book.noCoversFound'), 'info');
    }
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    searchingExternal.value = false;
  }
}

function triggerFileInput(): void {
  fileInputRef.value?.click();
}

async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  busy.value = true;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('FileReader error'));
      reader.readAsDataURL(file);
    });
    const stored = await libraryStore.uploadCoverDataUrl(dataUrl);
    emit('update:modelValue', stored.coverKey);
    if (!candidates.value.some((c) => c.coverKey === stored.coverKey)) {
      candidates.value.unshift({
        id: stored.coverKey,
        kind: 'local',
        coverKey: stored.coverKey,
        url: stored.coverUrl,
        label: t('book.coverSectionTitle')
      });
    }
    uiStore.pushToast(t('book.coverImportedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    busy.value = false;
    input.value = '';
  }
}

async function handleImportUrl(): Promise<void> {
  const cleanUrl = urlInput.value.trim();
  if (!cleanUrl) return;
  busy.value = true;
  try {
    const stored = await libraryStore.importCoverUrl(cleanUrl);
    emit('update:modelValue', stored.coverKey);
    urlInput.value = '';
    if (!candidates.value.some((c) => c.coverKey === stored.coverKey)) {
      candidates.value.unshift({
        id: stored.coverKey,
        kind: 'local',
        coverKey: stored.coverKey,
        url: stored.coverUrl,
        label: t('book.coverSectionTitle')
      });
    }
    uiStore.pushToast(t('book.coverImportedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    busy.value = false;
  }
}

async function selectCandidate(item: CoverCandidateItem): Promise<void> {
  if (item.kind === 'local' && item.coverKey) {
    emit('update:modelValue', item.coverKey);
    return;
  }
  // Source externe -> téléchargement & compression WebP côté serveur
  busy.value = true;
  try {
    const stored = await libraryStore.importCoverUrl(item.url);
    item.kind = 'local';
    item.coverKey = stored.coverKey;
    item.url = stored.coverUrl;
    emit('update:modelValue', stored.coverKey);
    uiStore.pushToast(t('book.coverImportedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void loadCandidates(false);
});
</script>

<template>
  <div class="ds-panel ds-stack">
    <div class="ds-row ds-row--between">
      <strong class="ds-label">{{ t('book.coverSectionTitle') }}</strong>
      <div class="ds-row">
        <input
          ref="fileInputRef"
          type="file"
          accept="image/*"
          class="cover-file-hidden"
          @change="handleFileChange"
        />
        <button type="button" class="ds-btn ds-btn--sm" :disabled="busy" @click="triggerFileInput">
          {{ t('book.uploadCoverBtn') }}
        </button>
        <button
          v-if="bookId"
          type="button"
          class="ds-btn ds-btn--sm"
          :disabled="busy || searchingExternal"
          @click="loadCandidates(true)"
        >
          {{ searchingExternal ? t('app.loading') : t('book.findMoreCoversBtn') }}
        </button>
      </div>
    </div>

    <div class="ds-row">
      <div v-if="modelValue" class="cover-preview">
        <img :src="`/api/covers/${modelValue}`" :alt="t('book.coverSectionTitle')" />
      </div>

      <div class="cover-url-box ds-row">
        <input
          v-model="urlInput"
          type="url"
          class="ds-input cover-url-input"
          :placeholder="t('book.coverUrlPlaceholder')"
        />
        <button
          type="button"
          class="ds-btn ds-btn--sm"
          :disabled="busy || !urlInput.trim()"
          @click="handleImportUrl"
        >
          {{ t('book.importCoverUrlBtn') }}
        </button>
      </div>
    </div>

    <div v-if="candidates.length > 0" class="ds-stack">
      <span class="ds-text-muted">{{ t('book.coverGalleryTitle') }}</span>
      <div class="cover-gallery">
        <button
          v-for="item in candidates"
          :key="item.id"
          type="button"
          class="cover-thumb"
          :class="{ 'cover-thumb--active': item.coverKey && item.coverKey === modelValue }"
          :disabled="busy"
          :title="item.label"
          @click="selectCandidate(item)"
        >
          <img :src="item.url" :alt="item.label" loading="lazy" referrerpolicy="no-referrer" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cover-file-hidden {
  display: none;
}

.cover-preview {
  width: 72px;
  height: 104px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 2px solid var(--accent);
  background: var(--bg-surface);
  flex-shrink: 0;
}

.cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-url-box {
  flex: 1;
  min-width: 200px;
}

.cover-url-input {
  flex: 1;
  min-width: 160px;
}

.cover-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: var(--space-2);
}

.cover-thumb {
  aspect-ratio: 2 / 3;
  padding: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 2px solid var(--border-subtle);
  background: var(--bg-surface);
  cursor: pointer;
}

.cover-thumb--active {
  border-color: var(--accent);
}

.cover-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
