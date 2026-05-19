<script setup lang="ts">
import { TEXTS } from '../locales/fr';
import type { SearchResponse } from '../../core/types';

defineProps<{
  searchResult: SearchResponse;
}>();
</script>

<template>
  <div class="result-card success">
    <p class="result-title">{{ TEXTS.scanner.successDetected }}</p>
    <div class="book-details">
      <div class="book-info">
        <p class="book-title"><strong>{{ searchResult.mainBook.title }}</strong></p>
        <p class="book-authors" v-if="searchResult.mainBook.authors?.length">
          {{ searchResult.mainBook.authors.join(', ') }}
        </p>
        <p class="book-isbn" v-if="searchResult.mainBook.isbn13">
          ISBN : {{ searchResult.mainBook.isbn13 }}
        </p>
        <p class="ownership-status">
          Statut de possession : 
          <span class="badge" :class="searchResult.ownership.isWorkOwned ? 'owned' : 'missing'">
            {{ searchResult.ownership.isWorkOwned ? 'Possédé' : 'Absent' }}
          </span>
        </p>
      </div>
    </div>
  </div>
</template>