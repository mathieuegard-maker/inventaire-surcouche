<script setup lang="ts">
import { computed } from 'vue';
import BaseButton from './BaseButton.vue';
import { TEXTS } from '../locales/fr';
import type { SearchResponse } from '../../core/types';

const props = defineProps<{
  searchResult: SearchResponse;
}>();

const emit = defineEmits<{
  (e: 'action-add-inventory', uri: string): void;
  (e: 'action-add-wishlist', uri: string): void;
  (e: 'action-lend', uri: string): void;
  (e: 'action-view-series', seriesId: string): void;
}>();

const isOwned = computed(() => props.searchResult.ownership.isWorkOwned);
const book = computed(() => props.searchResult.mainBook);
const series = computed(() => props.searchResult.series);

// Calcul robuste pour déterminer si le livre fait partie d'une série 
// et extraire l'identifiant (ou le nom) à envoyer au Middle-End
const seriesIdentifier = computed(() => {
  return series.value?.id || book.value.seriesId || series.value?.name || book.value.series || book.value.seriesName;
});
const hasSeries = computed(() => !!seriesIdentifier.value);
</script>

<template>
  <div class="result-card success">
    <div class="result-title">{{ TEXTS.scanner.successDetected }}</div>
    
    <div class="book-card-layout">
      <img 
        v-if="book.coverUrl" 
        :src="book.coverUrl" 
        :alt="book.title" 
        class="book-cover-image" 
      />
      <div v-else class="book-cover-placeholder">
        Pas de<br>couverture
      </div>

      <div class="book-info-layout">
        <div>
          <h3 class="book-title">{{ book.title }}</h3>
          <h4 v-if="book.subtitle" class="book-subtitle">{{ book.subtitle }}</h4>
        </div>

        <div v-if="hasSeries" class="book-meta-group">
          <p class="book-meta-item">
            <strong>{{ TEXTS.bookCard.series }} :</strong> 
            {{ series?.name || book.series || book.seriesName }}
            <span v-if="book.seriesNumber"> ({{ TEXTS.bookCard.volume }} {{ book.seriesNumber }})</span>
          </p>
        </div>

        <div class="book-meta-group" v-if="book.authors?.length || book.scriptwriters?.length || book.illustrators?.length">
          <p class="book-meta-item" v-if="book.authors?.length">
            <strong>{{ TEXTS.bookCard.meta.authors }} :</strong> {{ book.authors.join(', ') }}
          </p>
          <p class="book-meta-item" v-if="book.scriptwriters?.length">
            <strong>{{ TEXTS.bookCard.meta.scriptwriters }} :</strong> {{ book.scriptwriters.join(', ') }}
          </p>
          <p class="book-meta-item" v-if="book.illustrators?.length">
            <strong>{{ TEXTS.bookCard.meta.illustrators }} :</strong> {{ book.illustrators.join(', ') }}
          </p>
        </div>

        <div class="book-meta-group">
          <p class="book-meta-item" v-if="book.publisher">
            <strong>{{ TEXTS.bookCard.meta.publisher }} :</strong> {{ book.publisher }} 
            <span v-if="book.collection">[{{ book.collection }}]</span>
          </p>
          <p class="book-meta-item" v-if="book.genres?.length">
            <strong>{{ TEXTS.bookCard.meta.genres }} :</strong> {{ book.genres.join(', ') }}
          </p>
          <p class="book-meta-item" v-if="book.publishDate">
            <strong>{{ TEXTS.bookCard.meta.publishDate }} :</strong> {{ book.publishDate }}
          </p>
          <p class="book-meta-item" v-if="book.pageCount">
            <strong>{{ TEXTS.bookCard.meta.pageCount }} :</strong> {{ book.pageCount }}
          </p>
          <p class="book-meta-item" v-if="book.format">
            <strong>{{ TEXTS.bookCard.meta.format }} :</strong> {{ book.format }}
          </p>
          <p class="book-meta-item" v-if="book.language">
            <strong>{{ TEXTS.bookCard.meta.language }} :</strong> {{ book.language }}
          </p>
          <p class="book-meta-item" v-if="book.isbn13">
            <strong>ISBN :</strong> {{ book.isbn13 }}
          </p>
        </div>

        <div class="badge-container">
          <span class="badge" :class="isOwned ? 'owned' : 'missing'">
            {{ isOwned ? TEXTS.bookCard.owned : TEXTS.bookCard.missing }}
          </span>
        </div>
      </div>
    </div>

    <div class="book-actions-layout">
      <template v-if="!isOwned">
        <BaseButton @click="emit('action-add-inventory', book.uri)">
          {{ TEXTS.bookCard.btnAddInventory }}
        </BaseButton>
        
        <BaseButton @click="emit('action-add-wishlist', book.uri)">
          {{ TEXTS.bookCard.btnAddWishlist }}
        </BaseButton>
      </template>

      <template v-else>
        <BaseButton @click="emit('action-lend', book.uri)">
          {{ TEXTS.bookCard.btnLend }}
        </BaseButton>
      </template>

      <BaseButton v-if="hasSeries" @click="emit('action-view-series', seriesIdentifier)">
        {{ TEXTS.bookCard.btnViewSeries }}
      </BaseButton>
    </div>
  </div>
</template>