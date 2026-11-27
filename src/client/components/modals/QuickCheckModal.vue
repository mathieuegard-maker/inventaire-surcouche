<!-- src/client/components/modals/QuickCheckModal.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  AlertCircle,
  BookOpenCheck,
  CheckCircle2,
  ExternalLink,
  Layers,
  PlusCircle,
  ScanBarcode,
  Star
} from '@lucide/vue';
import BaseModal from '../base/BaseModal.vue';
import CameraBarcodeModal from './CameraBarcodeModal.vue';
import { useLibraryStore } from '../../stores/library.store';
import { useUiStore } from '../../stores/ui.store';
import type { BookView, OwnershipStatus } from '../../../shared/types/domain.types';
import { t } from '../../../shared/locales';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const router = useRouter();
const libraryStore = useLibraryStore();
const uiStore = useUiStore();

const cameraOpen = ref(false);
const resultOpen = ref(false);
const isResolving = ref(false);
const isSavingStatus = ref(false);
const scannedIsbn = ref('');
const resolvedBook = ref<BookView | null>(null);
const resolveError = ref(false);

const statusKind = computed<'lent' | 'owned' | 'covered' | 'wish' | 'none' | 'not_found'>(() => {
  const book = resolvedBook.value;
  if (!book) return 'not_found';
  if (book.activeLoan) return 'lent';
  if (book.ownershipStatus === 'owned') return 'owned';
  if (book.ownedViaIntegral) return 'covered';
  if (book.ownershipStatus === 'wish') return 'wish';
  return 'none';
});

const statusBannerClass = computed(() => {
  switch (statusKind.value) {
    case 'owned':
    case 'covered':
      return 'ds-banner--success';
    case 'lent':
    case 'wish':
      return 'ds-banner--warning';
    case 'not_found':
      return 'ds-banner--danger';
    default:
      return 'ds-banner--info';
  }
});

const statusMessage = computed(() => {
  const book = resolvedBook.value;
  if (!book) return t('dashboard.quickCheckNotFound', { isbn: scannedIsbn.value });
  if (book.activeLoan) {
    return t('dashboard.quickCheckOwnedLent', { name: book.activeLoan.borrowerName });
  }
  if (book.ownershipStatus === 'owned') return t('dashboard.quickCheckOwned');
  if (book.ownedViaIntegral) {
    return t('dashboard.quickCheckCovered', { title: book.ownedViaIntegral.title });
  }
  if (book.ownershipStatus === 'wish') return t('dashboard.quickCheckWished');
  return t('dashboard.quickCheckNotOwned');
});

function resetState(): void {
  cameraOpen.value = false;
  resultOpen.value = false;
  isResolving.value = false;
  isSavingStatus.value = false;
  scannedIsbn.value = '';
  resolvedBook.value = null;
  resolveError.value = false;
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetState();
      cameraOpen.value = true;
    } else {
      resetState();
    }
  },
  { immediate: true }
);

function handleCameraClose(): void {
  cameraOpen.value = false;
  if (!resultOpen.value) {
    emit('close');
  }
}

function handleResultClose(): void {
  resultOpen.value = false;
  emit('close');
}

function scanAnother(): void {
  resultOpen.value = false;
  resolvedBook.value = null;
  resolveError.value = false;
  scannedIsbn.value = '';
  cameraOpen.value = true;
}

async function handleScannedIsbn(isbn13: string): Promise<void> {
  scannedIsbn.value = isbn13;
  resolvedBook.value = null;
  resolveError.value = false;
  resultOpen.value = true;
  cameraOpen.value = false;

  // 1. Recherche instantanée dans le miroir local (fonctionne aussi hors-ligne en librairie)
  const localHit =
    libraryStore.books.find(
      (b) => b.primaryIsbn13 === isbn13 || b.knownIsbns.includes(isbn13)
    ) ?? null;

  if (localHit) {
    resolvedBook.value = localHit;
    return;
  }

  // 2. Interrogation serveur (mode preview, sans modifier la bibliothèque)
  isResolving.value = true;
  try {
    const preview = await libraryStore.resolveIsbnPreview(isbn13);
    if (preview) {
      // Vérifie aussi par identifiant d'œuvre au cas où l'utilisateur possède déjà une autre édition
      const byId = libraryStore.books.find((b) => b.id === preview.id) ?? null;
      resolvedBook.value = byId ?? preview;
    } else {
      resolvedBook.value = null;
      resolveError.value = true;
    }
  } catch {
    resolvedBook.value = null;
    resolveError.value = true;
  } finally {
    isResolving.value = false;
  }
}

async function quickAdd(status: OwnershipStatus): Promise<void> {
  const book = resolvedBook.value;
  if (!book || isSavingStatus.value) return;
  isSavingStatus.value = true;
  try {
    await libraryStore.applyBatchStatus({ bookIds: [book.id], status });
    const updated = libraryStore.books.find((b) => b.id === book.id);
    resolvedBook.value = updated ?? { ...book, ownershipStatus: status };
    uiStore.pushToast(
      status === 'owned' ? t('dashboard.quickCheckAddOwned') : t('dashboard.quickCheckAddWish'),
      'success'
    );
  } catch (err) {
    uiStore.pushToast(err instanceof Error ? err.message : t('app.retry'), 'danger');
  } finally {
    isSavingStatus.value = false;
  }
}

function openBookDetail(): void {
  const book = resolvedBook.value;
  if (!book) return;
  emit('close');
  void router.push(`/book/${encodeURIComponent(book.id)}`);
}

function openManualCreate(): void {
  const isbn = scannedIsbn.value;
  emit('close');
  void router.push({ path: '/book/create', query: isbn ? { isbn } : undefined });
}
</script>

<template>
  <CameraBarcodeModal
    :open="cameraOpen"
    mode="simple"
    :title="t('dashboard.quickCheckModalTitle')"
    @detected="handleScannedIsbn"
    @close="handleCameraClose"
  />

  <BaseModal
    :open="resultOpen"
    :title="t('dashboard.quickCheckModalTitle')"
    max-width="480px"
    @close="handleResultClose"
  >
    <div v-if="isResolving" class="quick-check-loading ds-stack--sm">
      <p class="ds-text-muted">{{ t('dashboard.quickCheckScanning') }}</p>
      <span class="ds-badge">{{ scannedIsbn }}</span>
    </div>

    <div v-else class="ds-stack">
      <div class="ds-banner quick-check-banner" :class="statusBannerClass" role="status">
        <CheckCircle2 v-if="statusKind === 'owned'" :size="20" aria-hidden="true" />
        <Layers v-else-if="statusKind === 'covered'" :size="20" aria-hidden="true" />
        <BookOpenCheck v-else-if="statusKind === 'lent'" :size="20" aria-hidden="true" />
        <Star v-else-if="statusKind === 'wish'" :size="20" aria-hidden="true" />
        <AlertCircle v-else :size="20" aria-hidden="true" />
        <strong>{{ statusMessage }}</strong>
      </div>

      <div v-if="resolvedBook" class="quick-check-book">
        <div class="quick-check-book__cover">
          <img
            v-if="resolvedBook.coverUrl"
            :src="resolvedBook.coverUrl"
            :alt="resolvedBook.title"
          />
          <span v-else class="quick-check-book__placeholder">
            {{ resolvedBook.title.slice(0, 2).toUpperCase() }}
          </span>
        </div>
        <div class="quick-check-book__meta ds-stack--xs">
          <strong>{{ resolvedBook.title }}</strong>
          <p v-if="resolvedBook.seriesName" class="ds-text-muted">
            {{ resolvedBook.seriesName }}
            <template v-if="resolvedBook.volumeLabel"> — {{ resolvedBook.volumeLabel }}</template>
            <template v-else-if="resolvedBook.volumeNumber !== null">
              — T.{{ resolvedBook.volumeNumber }}
            </template>
          </p>
          <p class="ds-text-muted">
            {{ resolvedBook.authors.join(', ') || t('app.unknownAuthor') }}
          </p>
          <p v-if="resolvedBook.publisher || resolvedBook.publishYear" class="ds-text-muted quick-check-book__pub">
            {{ [resolvedBook.publisher, resolvedBook.publishYear].filter(Boolean).join(' · ') }}
          </p>
        </div>
      </div>

      <!-- Actions rapides si l'ouvrage existe mais n'est pas encore possédé -->
      <div v-if="resolvedBook && statusKind === 'none'" class="quick-check-actions">
        <button
          type="button"
          class="ds-btn ds-btn--primary"
          :disabled="isSavingStatus"
          @click="quickAdd('owned')"
        >
          <PlusCircle :size="16" aria-hidden="true" />
          {{ t('dashboard.quickCheckAddOwned') }}
        </button>
        <button
          type="button"
          class="ds-btn"
          :disabled="isSavingStatus"
          @click="quickAdd('wish')"
        >
          <Star :size="16" aria-hidden="true" />
          {{ t('dashboard.quickCheckAddWish') }}
        </button>
      </div>

      <div v-else-if="resolvedBook && statusKind === 'wish'" class="quick-check-actions">
        <button
          type="button"
          class="ds-btn ds-btn--primary"
          :disabled="isSavingStatus"
          @click="quickAdd('owned')"
        >
          <PlusCircle :size="16" aria-hidden="true" />
          {{ t('dashboard.quickCheckAddOwned') }}
        </button>
      </div>

      <div v-else-if="!resolvedBook && resolveError" class="quick-check-actions">
        <button type="button" class="ds-btn ds-btn--primary" @click="openManualCreate">
          {{ t('book.manualCreateBtn') }}
        </button>
      </div>
    </div>

    <template #footer>
      <button type="button" class="ds-btn ds-btn--primary" @click="scanAnother">
        <ScanBarcode :size="16" aria-hidden="true" />
        {{ t('dashboard.quickCheckScanAnother') }}
      </button>
      <button v-if="resolvedBook" type="button" class="ds-btn" @click="openBookDetail">
        <ExternalLink :size="15" aria-hidden="true" />
        {{ t('dashboard.openSheet') }}
      </button>
      <button type="button" class="ds-btn ds-btn--ghost" @click="handleResultClose">
        {{ t('app.close') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.quick-check-loading {
  align-items: center;
  text-align: center;
  padding: var(--space-4) 0;
}

.quick-check-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 0.95rem;
}

.quick-check-book {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

.quick-check-book__cover {
  flex: 0 0 72px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
}

.quick-check-book__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.quick-check-book__placeholder {
  font-weight: 700;
  color: var(--text-muted);
}

.quick-check-book__meta {
  min-inline-size: 0;
  flex: 1;
}

.quick-check-book__meta p {
  margin: 0;
  font-size: 0.85rem;
}

.quick-check-book__pub {
  font-size: 0.8rem;
}

.quick-check-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.quick-check-actions .ds-btn {
  flex: 1 1 160px;
}
</style>
