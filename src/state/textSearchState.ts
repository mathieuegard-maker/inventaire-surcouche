// src/state/textSearchState.ts
// État réactif persistant en mémoire de la Recherche textuelle (/scan?mode=search).
// Permet d'ouvrir une fiche livre ou une série puis de revenir en arrière sans jamais perdre sa recherche.

import { ref } from 'vue';
import type { CatalogSearchSeriesHit } from '../core/services/catalog-search.service';
import type { HumanizedBook } from '../core/types';

export interface TextSearchFormState {
  title: string;
  series: string;
  volumeNumber: string;
  author: string;
  edition: string;
  publisher: string;
  isbn: string;
}

const form = ref<TextSearchFormState>({
  title: '',
  series: '',
  volumeNumber: '',
  author: '',
  edition: '',
  publisher: '',
  isbn: ''
});

const seriesResults = ref<CatalogSearchSeriesHit[]>([]);
const bookResults = ref<HumanizedBook[]>([]);
const searchDone = ref(false);
const searchError = ref('');

export const textSearchState = {
  form,
  seriesResults,
  bookResults,
  searchDone,
  searchError,

  reset() {
    form.value = {
      title: '',
      series: '',
      volumeNumber: '',
      author: '',
      edition: '',
      publisher: '',
      isbn: ''
    };
    seriesResults.value = [];
    bookResults.value = [];
    searchDone.value = false;
    searchError.value = '';
  }
};
