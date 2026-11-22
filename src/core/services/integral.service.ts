// src/core/services/integral.service.ts
// Fonction métier autonome et réutilisable depuis n'importe quel écran (Édition de fiche, Fiche livre,
// Recherche textuelle, Scan simple, Rafale, Photo IA) pour convertir un ouvrage en Intégrale (ou inversement).

import {
  buildIntegralMetadata,
  formatIntegralRangeLabel,
  parseIncludedVolumeNumbers
} from '../bibliographic/integral.util';
import { databaseService } from '../database/database.service';
import { scannerState } from '../../state/scanner';
import type { HumanizedBook } from '../types';
import { patchV4BookMetadata, v4BookRecordToHumanizedBook } from './v4-client.service';

export interface SetBookIntegralInput {
  isIntegral: boolean;
  includedVolumeNumbers?: string[] | string;
  seriesNumber?: string;
  persistToServer?: boolean;
}

/**
 * Transforme un ouvrage en Intégrale (en précisant ses tomes inclus) ou le repasse en tome standard.
 * Met à jour la base serveur V4 (Option B par foyer) lorsque l'ouvrage existe déjà côté serveur,
 * puis persiste immédiatement la fiche mise à jour dans IndexedDB et notifie l'UI.
 */
export async function transformBookIntegralStatus(
  book: HumanizedBook,
  config: SetBookIntegralInput
): Promise<HumanizedBook> {
  const isIntegral = Boolean(config.isIntegral);
  const includedVolumeNumbers = isIntegral
    ? parseIncludedVolumeNumbers(config.includedVolumeNumbers)
    : [];

  const nextSeriesNumber = isIntegral
    ? formatIntegralRangeLabel(includedVolumeNumbers, book.seriesNumber)
    : config.seriesNumber !== undefined
      ? config.seriesNumber.trim() || undefined
      : book.seriesNumber && /^int\b/i.test(book.seriesNumber.trim())
        ? undefined
        : book.seriesNumber;

  let v4UpdatedBook: HumanizedBook | null = null;
  if (config.persistToServer !== false && (book.bookId || book.isbn13 || book.uri)) {
    const serverRec = await patchV4BookMetadata({
      bookId: book.bookId,
      uri: book.uri,
      isbn13: book.isbn13,
      series: book.series,
      seriesId: book.seriesId,
      seriesNumber: nextSeriesNumber || '',
      isIntegral,
      includedVolumeNumbers
    }).catch(() => null);

    if (serverRec) {
      v4UpdatedBook = v4BookRecordToHumanizedBook(serverRec, book.ownershipStatus);
    }
  }

  const merged: HumanizedBook = {
    ...book,
    ...(v4UpdatedBook || {}),
    uri: book.uri,
    localCover: book.localCover,
    loan: book.loan,
    wishedByUserId: book.wishedByUserId,
    wishedByName: book.wishedByName,
    ownershipStatus: book.ownershipStatus,
    isIntegral,
    integralMetadata: isIntegral
      ? buildIntegralMetadata(includedVolumeNumbers, v4UpdatedBook?.integralMetadata || book.integralMetadata)
      : { includedVolumeNumbers: [], includedWorkIds: [], includedIsbns: [] },
    seriesNumber: nextSeriesNumber,
    isLocallyEdited: true
  };

  if (config.persistToServer !== false) {
    const existing = await databaseService.getBookFromCache(merged.uri).catch(() => null);
    if (existing || merged.ownershipStatus !== 'none') {
      await databaseService.saveBookToCache(JSON.parse(JSON.stringify(merged)));
      scannerState.notifyCatalogChanged();
    }
  }

  return merged;
}
