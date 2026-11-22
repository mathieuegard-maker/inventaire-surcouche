// src/ui/composables/useBookBatchActions.ts
// Composable DRY partagé pour la sélection multiple, les actions par lot (Collection, Wishlist, Prêt, Retour, Suppression)
// et l'édition rapide d'Intégrale dans toutes les listes de livres.

import { computed, ref, type Ref } from 'vue';
import { databaseService } from '../../core/database/database.service';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { inventoryService } from '../../core/services/inventory.service';
import { wishlistService } from '../../core/services/wishlist.service';
import { transformBookIntegralStatus } from '../../core/services/integral.service';
import {
  ingestIsbnsViaV4,
  v4BookRecordToHumanizedBook
} from '../../core/services/v4-client.service';
import { formatIncludedVolumeNumbers } from '../../core/bibliographic/integral.util';
import type { SourceChannel } from '../../core/services/v4-pipeline.service';
import type { HumanizedBook } from '../../core/types';
import { scannerState } from '../../state/scanner';

export type BatchBookAction = 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN' | 'DELETE';

export function useBookBatchActions(
  booksRef: Ref<HumanizedBook[]>,
  options: {
    sourceChannel: SourceChannel;
    fallbackToBackgroundCreation?: boolean;
  }
) {
  const selectedUris = ref<string[]>([]);
  const showLendModal = ref(false);
  const batchBusy = ref(false);
  const feedbackMessage = ref('');
  const errorMessage = ref('');

  // Éditeur rapide d'intégrale partagé par ligne
  const editingIntegralUri = ref<string | null>(null);
  const integralFlag = ref(false);
  const integralVolsText = ref('');
  const integralSaving = ref(false);

  const isAllSelected = computed(
    () => booksRef.value.length > 0 && selectedUris.value.length === booksRef.value.length
  );

  const selectedBooks = computed(() =>
    booksRef.value.filter((b) => selectedUris.value.includes(b.uri))
  );

  const toggleAll = (checked: boolean) => {
    selectedUris.value = checked ? booksRef.value.map((b) => b.uri) : [];
  };

  const toggleSelection = (uri: string, checked: boolean) => {
    if (checked) {
      if (!selectedUris.value.includes(uri)) selectedUris.value.push(uri);
    } else {
      const idx = selectedUris.value.indexOf(uri);
      if (idx > -1) selectedUris.value.splice(idx, 1);
    }
  };

  const clearSelection = () => {
    selectedUris.value = [];
  };

  const toggleIntegralEditor = (book: HumanizedBook) => {
    if (editingIntegralUri.value === book.uri) {
      editingIntegralUri.value = null;
      return;
    }
    editingIntegralUri.value = book.uri;
    integralFlag.value = Boolean(book.isIntegral);
    integralVolsText.value = formatIncludedVolumeNumbers(
      book.integralMetadata?.includedVolumeNumbers
    );
  };

  const applyIntegralEditor = async (book: HumanizedBook) => {
    if (integralSaving.value) return;
    integralSaving.value = true;
    try {
      const updated = await transformBookIntegralStatus(book, {
        isIntegral: integralFlag.value,
        includedVolumeNumbers: integralVolsText.value,
        persistToServer: book.ownershipStatus !== 'none' || Boolean(book.bookId)
      });
      Object.assign(book, updated);
      editingIntegralUri.value = null;
    } finally {
      integralSaving.value = false;
    }
  };

  const dispatchBatchAction = async (action: BatchBookAction) => {
    if (selectedBooks.value.length === 0) return;
    if (action === 'LEND') {
      showLendModal.value = true;
      return;
    }

    batchBusy.value = true;
    errorMessage.value = '';
    feedbackMessage.value = '';
    let processed = 0;

    try {
      for (const book of selectedBooks.value) {
        if (action === 'DELETE') {
          if (book.ownershipStatus === 'owned') {
            await inventoryService.removeFromLibrary(book.uri);
          } else if (book.ownershipStatus === 'wish') {
            await wishlistService.removeFromWishlist([book.uri]);
          }
          book.ownershipStatus = 'none';
          if (book.loan) delete book.loan;
          processed++;
          continue;
        }

        if (action === 'RETURN') {
          await queueService.enqueueAction('RETURN', book.uri);
          if (book.loan) delete book.loan;
          processed++;
          continue;
        }

        if (action === 'ADD_INVENTORY' || action === 'ADD_WISHLIST') {
          const targetStatus = action === 'ADD_INVENTORY' ? 'owned' : 'wish';
          const v4Action = action === 'ADD_INVENTORY' ? 'owned' : 'wishlist';
          const cleanIsbn = book.isbn13 || (book.uri.startsWith('isbn:') ? book.uri.slice(5) : '');
          let handledByV4 = false;

          if (cleanIsbn) {
            const batch = await ingestIsbnsViaV4({
              isbns: [cleanIsbn],
              sourceChannel: options.sourceChannel,
              action: v4Action,
              hints: {
                [cleanIsbn]: {
                  title: book.title,
                  series: book.series,
                  volumeNumber: book.isIntegral ? undefined : book.seriesNumber,
                  isIntegral: Boolean(book.isIntegral),
                  includedVolumeNumbers: book.isIntegral
                    ? book.integralMetadata?.includedVolumeNumbers
                    : undefined,
                  coverUrl: book.coverUrl
                }
              }
            });
            const first = batch?.results?.[0];
            if (first?.book) {
              const humanized = v4BookRecordToHumanizedBook(first.book, targetStatus);
              await databaseService.saveBookToCache(humanized);
              await databaseService.addRegistryEntry(
                action === 'ADD_INVENTORY' ? 'inventory' : 'wishlist',
                humanized.uri
              );
              Object.assign(book, humanized);
              handledByV4 = true;
            }
          }

          if (!handledByV4) {
            if (options.fallbackToBackgroundCreation && book.uri.startsWith('isbn:')) {
              await backgroundCreationOrchestrator.enqueueBookCreation({
                tempBook: { ...book, ownershipStatus: targetStatus },
                expandSeries: Boolean(book.series)
              });
            } else {
              await queueService.enqueueAction(action, book.uri);
            }
            book.ownershipStatus = targetStatus;
          }
          processed++;
        }
      }

      selectedUris.value = [];
      feedbackMessage.value = `${processed} ouvrage(s) mis à jour.`;
      scannerState.notifyCatalogChanged();
    } catch (err: unknown) {
      errorMessage.value = err instanceof Error ? err.message : 'Erreur lors du traitement.';
    } finally {
      batchBusy.value = false;
    }
  };

  const confirmGroupLend = async (friendName: string) => {
    showLendModal.value = false;
    if (!friendName || selectedBooks.value.length === 0) return;

    const count = selectedBooks.value.length;
    for (const book of selectedBooks.value) {
      if (book.ownershipStatus !== 'owned') {
        await queueService.enqueueAction('ADD_INVENTORY', book.uri);
        book.ownershipStatus = 'owned';
      }
      await queueService.enqueueAction('LEND', book.uri, { friendName });
      book.loan = { uri: book.uri, friendName, loanDate: Date.now() };
    }
    feedbackMessage.value = `${count} livre(s) prêté(s) à ${friendName}.`;
    selectedUris.value = [];
    scannerState.notifyCatalogChanged();
  };

  return {
    selectedUris,
    selectedBooks,
    isAllSelected,
    showLendModal,
    batchBusy,
    feedbackMessage,
    errorMessage,
    editingIntegralUri,
    integralFlag,
    integralVolsText,
    integralSaving,
    toggleAll,
    toggleSelection,
    clearSelection,
    toggleIntegralEditor,
    applyIntegralEditor,
    dispatchBatchAction,
    confirmGroupLend
  };
}
