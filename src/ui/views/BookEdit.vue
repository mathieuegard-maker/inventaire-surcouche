<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { entityResolver } from '../../core/resolvers/entity.resolver';
import { externalMetadataService } from '../../core/services/external-metadata.service';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BaseButton from '../components/BaseButton.vue';
import DedupModal from '../components/DedupModal.vue';
import SeriesMergeModal from '../components/SeriesMergeModal.vue';
import { bookSemanticOrchestrator } from '../../core/orchestrators/book-semantic.orchestrator';
import { SUGGESTED_GENRE_CHIPS } from '../../core/utils/category-classifier.util';
import { imageUtil } from '../../core/utils/image.util';
import { compressImageToWebpDataUrl } from '../../core/utils/webp-compressor.util';
import { useSemanticResolution } from '../composables/useSemanticResolution';
import { connectionState } from '../../state/connection';
import type { HumanizedBook } from '../../core/types';

const route = useRoute();
const router = useRouter();

const uri = decodeURIComponent(route.params.uri as string);

const isLoading = ref(true);
const loadingStatus = ref("Chargement du livre...");
const errorMsg = ref<string | null>(null);
const successMsg = ref<string | null>(null);

// Données du livre d'origine
const originalBook = ref<HumanizedBook | null>(null);

// Formulaire modifiable (gauche)
const titleInput = ref('');
const authorsInput = ref('');
const seriesInput = ref('');
const seriesNumberInput = ref('');
const publisherInput = ref('');
const publishDateInput = ref('');
const pageCountInput = ref<number | undefined>(undefined);
const coverUrlInput = ref('');
const genresInput = ref<string[]>([]);
const customGenreInput = ref('');
const noSeries = ref(false);
const showSeriesMergeModal = ref(false);
const brokenCandidateUrls = ref<Record<string, boolean>>({});

const suggestedCoverCandidates = computed(() => {
  const isbn = originalBook.value?.isbn13 || originalBook.value?.isbn10;
  const all = imageUtil.buildCoverCandidates(isbn, [
    suggestions.value?.coverUrl,
    ...(suggestions.value?.coverFallbackUrls || []),
    originalBook.value?.coverUrl,
    ...(originalBook.value?.coverFallbackUrls || [])
  ]);
  return all.filter((u) => !brokenCandidateUrls.value[u]);
});

const markCoverCandidateBroken = (url: string) => {
  brokenCandidateUrls.value = { ...brokenCandidateUrls.value, [url]: true };
};

const selectCandidateCover = (url: string) => {
  coverUrlInput.value = url;
};

async function handleCustomCoverUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !originalBook.value) return;
  try {
    const webpDataUrl = await compressImageToWebpDataUrl(file, {
      maxWidth: 420,
      maxHeight: 600,
      quality: 0.8,
      cropRatio: 0.7
    });
    coverUrlInput.value = webpDataUrl;
    originalBook.value.localCover = webpDataUrl;
    originalBook.value.coverUrl = webpDataUrl;
    originalBook.value.isLocallyEdited = true;
    await databaseService.saveBookToCache(originalBook.value);
  } catch (e: any) {
    errorMsg.value = e.message || 'Impossible de compresser la couverture.';
  } finally {
    input.value = '';
  }
}

function handleSeriesMerged(payload: { seriesId: string; seriesTitle: string }) {
  seriesInput.value = payload.seriesTitle;
  resolvedSeriesUri.value = payload.seriesId;
  noSeries.value = false;
  if (originalBook.value) {
    originalBook.value.seriesId = payload.seriesId;
    originalBook.value.series = payload.seriesTitle;
  }
}

const toggleGenreTag = (tag: string) => {
  const idx = genresInput.value.findIndex((g) => g.toLowerCase() === tag.toLowerCase());
  if (idx >= 0) {
    genresInput.value = genresInput.value.filter((_, i) => i !== idx);
  } else {
    genresInput.value = [...genresInput.value, tag];
  }
};

const addCustomGenreTag = () => {
  const clean = customGenreInput.value.trim();
  if (!clean) return;
  if (!genresInput.value.some((g) => g.toLowerCase() === clean.toLowerCase())) {
    genresInput.value = [...genresInput.value, clean];
  }
  customGenreInput.value = '';
};

const isGenreSelected = (tag: string) =>
  genresInput.value.some((g) => g.toLowerCase() === tag.toLowerCase());

// Suggestions de la BNF/OL (droite)
const suggestions = ref<any>(null);
const isSuggestionsLoading = ref(false);

watch(noSeries, (val) => {
  if (val) {
    seriesInput.value = '';
    seriesNumberInput.value = '';
  }
});

watch(seriesInput, (val) => {
  if (val.trim()) {
    noSeries.value = false;
  }
});

onMounted(async () => {
  try {
    loadingStatus.value = "Chargement des données actuelles...";
    let currentBook = await databaseService.getBookFromCache(uri);
    if (!currentBook) {
      currentBook = await entityResolver.resolvePhysicalEntity(uri);
    }

    if (!currentBook) {
      errorMsg.value = "Impossible de récupérer les détails de cette édition.";
      isLoading.value = false;
      return;
    }

    originalBook.value = currentBook;
    
    // Pré-remplissage du formulaire
    titleInput.value = currentBook.title || '';
    authorsInput.value = currentBook.authors ? currentBook.authors.join(', ') : '';
    seriesInput.value = currentBook.series || '';
    seriesNumberInput.value = currentBook.seriesNumber || '';
    noSeries.value = !currentBook.series;
    publisherInput.value = currentBook.publisher || '';
    publishDateInput.value = currentBook.publishDate || '';
    pageCountInput.value = currentBook.pageCount;
    coverUrlInput.value = currentBook.coverUrl || '';
    genresInput.value = Array.isArray(currentBook.genres)
      ? currentBook.genres.filter((g) => !g.startsWith('wd:') && !g.startsWith('inv:'))
      : [];

    isLoading.value = false;

    // Lancement de la recherche de suggestions en arrière-plan
    const isbn = currentBook.isbn13 || currentBook.isbn10;
    if (isbn) {
      isSuggestionsLoading.value = true;
      console.log(`[BOOK EDIT] Recherche de suggestions BNF/OL pour l'ISBN : ${isbn}`);
      try {
        const extData = await externalMetadataService.fetchFromExternalSources(isbn);
        if (extData) {
          suggestions.value = extData;
          console.log(`[BOOK EDIT] Suggestions récupérées avec succès :`, extData);
        }
      } catch (err: any) {
        console.warn(`[BOOK EDIT] Échec de la recherche de suggestions :`, err.message);
      } finally {
        isSuggestionsLoading.value = false;
      }
    }
  } catch (err: any) {
    console.error("[BOOK EDIT] Erreur d'initialisation :", err);
    errorMsg.value = "Une erreur est survenue lors de la récupération des données : " + err.message;
    isLoading.value = false;
  }
});

// Méthodes utilitaires pour appliquer les suggestions
const applySuggestion = (field: string) => {
  if (!suggestions.value) return;
  
  if (field === 'title') {
    titleInput.value = suggestions.value.title || '';
  } else if (field === 'authors') {
    authorsInput.value = suggestions.value.authors ? suggestions.value.authors.join(', ') : '';
  } else if (field === 'series') {
    seriesInput.value = suggestions.value.series || '';
    noSeries.value = !suggestions.value.series;
  } else if (field === 'seriesNumber') {
    seriesNumberInput.value = suggestions.value.seriesNumber || '';
  } else if (field === 'publisher') {
    publisherInput.value = suggestions.value.publisher || '';
  } else if (field === 'publishDate') {
    publishDateInput.value = suggestions.value.publishDate || '';
  } else if (field === 'pageCount') {
    pageCountInput.value = suggestions.value.pageCount;
  } else if (field === 'coverUrl') {
    coverUrlInput.value = suggestions.value.coverUrl || '';
  } else if (field === 'genres' && Array.isArray(suggestions.value.genres)) {
    genresInput.value = [...suggestions.value.genres];
  }
};

const applyAllSuggestions = () => {
  if (!suggestions.value) return;
  applySuggestion('title');
  applySuggestion('authors');
  applySuggestion('series');
  applySuggestion('seriesNumber');
  applySuggestion('publisher');
  applySuggestion('publishDate');
  applySuggestion('pageCount');
  applySuggestion('coverUrl');
  applySuggestion('genres');
};

const normStr = (v: unknown) => String(v ?? '').trim();
const hasDiffTitle = computed(() => Boolean(suggestions.value?.title && normStr(suggestions.value.title) !== normStr(titleInput.value)));
const hasDiffAuthors = computed(() => {
  const sug = suggestions.value?.authors;
  if (!Array.isArray(sug) || sug.length === 0) return false;
  return normStr(sug.join(', ')) !== normStr(authorsInput.value);
});
const hasDiffSeries = computed(() => Boolean(!noSeries.value && suggestions.value?.series && normStr(suggestions.value.series) !== normStr(seriesInput.value)));
const hasDiffSeriesNumber = computed(() => Boolean(!noSeries.value && suggestions.value?.seriesNumber && normStr(suggestions.value.seriesNumber) !== normStr(seriesNumberInput.value)));
const hasDiffPublisher = computed(() => Boolean(suggestions.value?.publisher && normStr(suggestions.value.publisher) !== normStr(publisherInput.value)));
const hasDiffPublishDate = computed(() => Boolean(suggestions.value?.publishDate && normStr(suggestions.value.publishDate) !== normStr(publishDateInput.value)));
const hasDiffPageCount = computed(() => Boolean(suggestions.value?.pageCount && Number(suggestions.value.pageCount) !== Number(pageCountInput.value || 0)));
const hasDiffCoverUrl = computed(() => Boolean(suggestions.value?.coverUrl && normStr(suggestions.value.coverUrl) !== normStr(coverUrlInput.value)));
const hasDiffGenres = computed(() => {
  const sug = suggestions.value?.genres;
  if (!Array.isArray(sug) || sug.length === 0) return false;
  return sug.join('|').toLowerCase() !== genresInput.value.join('|').toLowerCase();
});
const hasAnySuggestionDiff = computed(
  () =>
    hasDiffTitle.value ||
    hasDiffAuthors.value ||
    hasDiffSeries.value ||
    hasDiffSeriesNumber.value ||
    hasDiffPublisher.value ||
    hasDiffPublishDate.value ||
    hasDiffPageCount.value ||
    hasDiffCoverUrl.value ||
    hasDiffGenres.value
);

const {
  currentStep,
  selectedOptionUri,
  resolvedSeriesUri,
  resolvedAuthorUris,
  showResolutionModal,
  startResolution,
  confirmStep,
  cancelResolution
} = useSemanticResolution();

const handleSave = async () => {
  errorMsg.value = null;
  successMsg.value = null;

  if (connectionState.isOffline.value) {
    errorMsg.value = "Toute action de modification doit être effectuée en ligne. Le mode hors ligne est réservé à la consultation.";
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if (!titleInput.value.trim()) {
    errorMsg.value = "Le titre de l'ouvrage ne peut pas être vide.";
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  isLoading.value = true;
  loadingStatus.value = "Analyse sémantique des données...";

  try {
    const steps = await bookSemanticOrchestrator.analyzeDuplicates(
      authorsInput.value,
      seriesInput.value,
      noSeries.value,
      originalBook.value
    );

    isLoading.value = false;

    if (steps.length > 0) {
      startResolution(steps);
    } else {
      await saveChanges();
    }
  } catch (err: any) {
    isLoading.value = false;
    errorMsg.value = "Erreur lors de la préparation de la sauvegarde : " + err.message;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
};

const confirmResolutionStep = async () => {
  await confirmStep(saveChanges);
};

const saveChanges = async () => {
  if (!originalBook.value) return;
  isLoading.value = true;
  loadingStatus.value = "Enregistrement des modifications...";
  errorMsg.value = null;

  try {
    const cleanSeries = noSeries.value ? '' : seriesInput.value.trim();
    const originalSeries = originalBook.value.series || '';
    const hasSeriesChanged = cleanSeries.toLowerCase() !== originalSeries.toLowerCase();
    const effectiveSeriesUri = resolvedSeriesUri.value ?? (!hasSeriesChanged && cleanSeries ? originalBook.value.seriesId : undefined);

    const updatedData = {
      title: titleInput.value.trim(),
      authors: authorsInput.value.split(',').map(a => a.trim()).filter(Boolean),
      series: cleanSeries,
      seriesNumber: noSeries.value ? '' : seriesNumberInput.value.trim(),
      publisher: publisherInput.value.trim(),
      publishDate: publishDateInput.value.trim(),
      pageCount: pageCountInput.value,
      coverUrl: coverUrlInput.value.trim(),
      genres: genresInput.value
    };

    await bookSemanticOrchestrator.saveEditedBook(
      originalBook.value,
      updatedData,
      effectiveSeriesUri,
      resolvedAuthorUris.value
    );

    successMsg.value = "Modifications enregistrées avec succès !";
    isLoading.value = false;

    setTimeout(() => {
      router.push(`/book/${encodeURIComponent(uri)}`);
    }, 1500);
  } catch (err: any) {
    console.error("[BOOK EDIT] Échec de la sauvegarde :", err);
    isLoading.value = false;
    errorMsg.value = "Erreur lors de la sauvegarde : " + err.message;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader title="Édition Sémantique" showBack />

    <div v-if="isLoading" style="display: flex; flex-direction: column; align-items: center; gap: var(--spacing-md); margin-top: var(--spacing-xl);">
      <BaseLoading />
      <p style="font-family: var(--font-main); font-size: 13px; color: var(--color-text-muted); font-weight: bold; text-align: center; text-transform: uppercase;">
        {{ loadingStatus }}
      </p>
    </div>

    <div v-else class="edit-unknown-container">
      <BaseBanner v-if="errorMsg" type="error" :message="errorMsg" />
      <BaseBanner v-if="successMsg" type="success" :message="successMsg" />

      <div v-if="!errorMsg && !successMsg" class="edit-box">
        <div class="info-alert-banner" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--spacing-sm);">
          <p style="margin: 0; flex: 1; min-width: 250px;">
            <strong>Mode Correction Sémantique :</strong> Modifiez les données ci-dessous. Les suggestions BnF/OL n'apparaissent que si une différence est détectée.
          </p>
          <BaseButton 
            v-if="suggestions && hasAnySuggestionDiff" 
            @click="applyAllSuggestions" 
            style="padding: 6px 12px; font-size: 11px; font-weight: bold;"
          >
            [ TOUT APPLIQUER ]
          </BaseButton>
        </div>

        <div class="edit-split-layout">
          <!-- Titre -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffTitle }">
            <div class="form-group">
              <label class="form-label">Titre (Modifiable)</label>
              <input type="text" v-model="titleInput" class="wireframe-input" />
            </div>

            <div v-if="isSuggestionsLoading || hasDiffTitle" class="suggestion-group">
              <label class="form-label">Titre suggéré (BNF/OL)</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.title">{{ suggestions.title }}</span>
                <BaseButton @click="applySuggestion('title')" class="apply-btn-inline">
                  [ COPIER ]
                </BaseButton>
              </div>
            </div>
          </div>

          <!-- Auteurs -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffAuthors }">
            <div class="form-group">
              <label class="form-label">Auteurs (Séparés par des virgules)</label>
              <input type="text" v-model="authorsInput" class="wireframe-input" />
            </div>

            <div v-if="isSuggestionsLoading || hasDiffAuthors" class="suggestion-group">
              <label class="form-label">Auteurs suggérés</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.authors?.join(', ')">{{ suggestions.authors.join(', ') }}</span>
                <BaseButton @click="applySuggestion('authors')" class="apply-btn-inline">
                  [ COPIER ]
                </BaseButton>
              </div>
            </div>
          </div>

          <!-- Série -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffSeries }">
            <div class="form-group">
              <label class="form-label">Série</label>
              <input 
                type="text" 
                v-model="seriesInput" 
                placeholder="Nom de la série" 
                :disabled="noSeries" 
                class="wireframe-input" 
                :class="{ 'disabled-input': noSeries }"
              />
              <div class="checkbox-container">
                <input type="checkbox" id="noSeriesCheckbox" v-model="noSeries" class="wireframe-checkbox" />
                <label for="noSeriesCheckbox" class="checkbox-label">Ce livre ne fait pas partie d'une série</label>
              </div>
              <div v-if="originalBook" style="margin-top: 6px;">
                <button
                  type="button"
                  class="wireframe-btn apply-btn-inline"
                  style="width: auto;"
                  @click="showSeriesMergeModal = true"
                >
                  [ {{ originalBook.series ? 'CHANGER / FUSIONNER LA SÉRIE' : 'RATTACHER À UNE SÉRIE' }} ]
                </button>
              </div>
            </div>

            <div v-if="isSuggestionsLoading || hasDiffSeries" class="suggestion-group">
              <label class="form-label">Série suggérée</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.series">{{ suggestions.series }}</span>
                <BaseButton @click="applySuggestion('series')" class="apply-btn-inline">
                  [ COPIER ]
                </BaseButton>
              </div>
            </div>
          </div>

          <!-- Tome -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffSeriesNumber }">
            <div class="form-group">
              <label class="form-label">Numéro de tome</label>
              <input 
                type="text" 
                v-model="seriesNumberInput" 
                placeholder="Ex: 39" 
                :disabled="noSeries" 
                class="wireframe-input" 
                :class="{ 'disabled-input': noSeries }"
              />
            </div>

            <div v-if="isSuggestionsLoading || hasDiffSeriesNumber" class="suggestion-group">
              <label class="form-label">Tome suggéré</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else class="suggestion-content-inline">
                <span class="suggestion-value-text">{{ suggestions.seriesNumber }}</span>
                <BaseButton @click="applySuggestion('seriesNumber')" class="apply-btn-inline">
                  [ COPIER ]
                </BaseButton>
              </div>
            </div>
          </div>

          <!-- Éditeur -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffPublisher }">
            <div class="form-group">
              <label class="form-label">Éditeur</label>
              <input type="text" v-model="publisherInput" class="wireframe-input" />
            </div>

            <div v-if="isSuggestionsLoading || hasDiffPublisher" class="suggestion-group">
              <label class="form-label">Éditeur suggéré</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.publisher">{{ suggestions.publisher }}</span>
                <BaseButton @click="applySuggestion('publisher')" class="apply-btn-inline">
                  [ COPIER ]
                </BaseButton>
              </div>
            </div>
          </div>

          <!-- Année de publication -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffPublishDate }">
            <div class="form-group">
              <label class="form-label">Année de publication</label>
              <input type="text" v-model="publishDateInput" class="wireframe-input" />
            </div>

            <div v-if="isSuggestionsLoading || hasDiffPublishDate" class="suggestion-group">
              <label class="form-label">Année suggérée</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else class="suggestion-content-inline">
                <span class="suggestion-value-text">{{ suggestions.publishDate }}</span>
                <BaseButton @click="applySuggestion('publishDate')" class="apply-btn-inline">
                  [ COPIER ]
                </BaseButton>
              </div>
            </div>
          </div>

          <!-- Nombre de pages -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffPageCount }">
            <div class="form-group">
              <label class="form-label">Nombre de pages</label>
              <input type="number" v-model="pageCountInput" class="wireframe-input" />
            </div>

            <div v-if="isSuggestionsLoading || hasDiffPageCount" class="suggestion-group">
              <label class="form-label">Pages suggérées</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else class="suggestion-content-inline">
                <span class="suggestion-value-text">{{ suggestions.pageCount }}</span>
                <BaseButton @click="applySuggestion('pageCount')" class="apply-btn-inline">
                  [ COPIER ]
                </BaseButton>
              </div>
            </div>
          </div>

          <!-- Couverture -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffCoverUrl }">
            <div class="form-group">
              <label class="form-label">URL de la couverture</label>
              <input type="text" v-model="coverUrlInput" class="wireframe-input" />
              <div style="margin-top: 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                <label class="wireframe-btn apply-btn-inline" style="cursor: pointer; width: auto;">
                  <input type="file" accept="image/*" capture="environment" hidden @change="handleCustomCoverUpload" />
                  [ PHOTO COUVERTURE (WEBP) ]
                </label>
                <img
                  v-if="coverUrlInput"
                  :src="imageUtil.resolveCoverUrl(coverUrlInput)"
                  alt="Couverture actuelle"
                  style="width: 30px; height: 42px; border: var(--border-width) solid var(--color-border); object-fit: cover;"
                />
              </div>
            </div>

            <div v-if="isSuggestionsLoading || hasDiffCoverUrl || suggestedCoverCandidates.length > 0" class="suggestion-group">
              <label class="form-label">Couvertures trouvées par nos sources</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestedCoverCandidates.length > 0" class="cover-candidates-gallery">
                <button
                  v-for="(candUrl, idx) in suggestedCoverCandidates"
                  :key="candUrl"
                  type="button"
                  :class="['cover-candidate-thumb-btn', { selected: normStr(coverUrlInput) === normStr(candUrl) }]"
                  :title="`Choisir couverture #${idx + 1}`"
                  @click="selectCandidateCover(candUrl)"
                >
                  <img
                    :src="imageUtil.resolveExternalUrl(candUrl)"
                    :alt="`Couverture #${idx + 1}`"
                    class="cover-candidate-img"
                    @error="markCoverCandidateBroken(candUrl)"
                  />
                </button>
              </div>
              <div v-else class="suggestion-content-inline">
                <div style="display: flex; gap: var(--spacing-sm); align-items: center; min-width: 0; flex: 1;">
                  <img v-if="suggestions.coverUrl" :src="imageUtil.resolveCoverUrl(suggestions.coverUrl)" style="width: 30px; height: 42px; border: var(--border-width) solid var(--color-border); object-fit: cover; flex-shrink: 0;" />
                  <span class="suggestion-value-text" style="font-size: 11px;">Image disponible</span>
                </div>
                <BaseButton @click="applySuggestion('coverUrl')" class="apply-btn-inline">
                  Copier
                </BaseButton>
              </div>
            </div>
          </div>

          <!-- Genre(s) multiples -->
          <div class="comparison-row" :class="{ 'single-col-row': !isSuggestionsLoading && !hasDiffGenres }">
            <div class="form-group">
              <label class="form-label">Genre(s) (choix multiple : ex. BD + Jeunesse + Fantastique)</label>
              <div v-if="genresInput.length > 0" class="selected-genres-row">
                <span v-for="g in genresInput" :key="g" class="genre-active-chip">
                  {{ g }}
                  <button type="button" class="chip-remove-btn" @click="toggleGenreTag(g)" title="Retirer">×</button>
                </span>
              </div>
              <div class="genres-picker-grid">
                <button
                  v-for="chip in SUGGESTED_GENRE_CHIPS"
                  :key="chip"
                  type="button"
                  class="genre-toggle-chip"
                  :class="{ active: isGenreSelected(chip) }"
                  @click="toggleGenreTag(chip)"
                >
                  {{ isGenreSelected(chip) ? '✓ ' : '+ ' }}{{ chip }}
                </button>
              </div>
              <div class="custom-genre-add-row">
                <input
                  type="text"
                  v-model="customGenreInput"
                  placeholder="Ajouter un genre personnalisé..."
                  class="wireframe-input"
                  @keydown.enter.prevent="addCustomGenreTag"
                />
                <BaseButton @click="addCustomGenreTag" class="apply-btn-inline">+ Ajouter</BaseButton>
              </div>
            </div>

            <div v-if="isSuggestionsLoading || hasDiffGenres" class="suggestion-group">
              <label class="form-label">Genre(s) croisés (BnF + Open Library + Google Books)</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Croisement multi-sources...</div>
              <div v-else class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.genres.join(', ')">
                  {{ suggestions.genres.join(' • ') }}
                </span>
                <BaseButton @click="applySuggestion('genres')" class="apply-btn-inline">
                  [ COPIER ]
                </BaseButton>
              </div>
            </div>
          </div>
        </div>

        <div class="form-actions-row">
          <BaseButton @click="router.back()" style="flex: 1;" class="btn-cancel">
            [ ANNULER ]
          </BaseButton>
          <BaseButton type="primary" @click="handleSave" style="flex: 2;" class="btn-save">
            [ ENREGISTRER LES MODIFICATIONS ]
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- Modale de Déduplication Sémantique (Séries / Auteurs) -->
    <DedupModal
      :show="showResolutionModal"
      :step="currentStep"
      v-model:selectedUri="selectedOptionUri"
      @confirm="confirmResolutionStep"
      @cancel="cancelResolution"
    />

    <!-- Modale de rattachement / fusion de série -->
    <SeriesMergeModal
      v-if="originalBook"
      :show="showSeriesMergeModal"
      :bookUris="[originalBook.uri, ...(originalBook.workUri ? [originalBook.workUri] : [])]"
      :currentSeriesId="originalBook.seriesId"
      :currentSeriesTitle="seriesInput || originalBook.series"
      :initialVolumeLabel="seriesNumberInput || originalBook.seriesNumber"
      @close="showSeriesMergeModal = false"
      @merged="handleSeriesMerged"
    />
  </div>
</template>

<style scoped>
.edit-unknown-container {
  width: 100% !important;
  margin-bottom: var(--spacing-lg) !important;
}

.edit-box {
  display: flex !important;
  flex-direction: column !important;
  gap: var(--spacing-md) !important;
  border: var(--border-width) solid var(--color-border) !important;
  background-color: var(--color-bg-main) !important;
  padding: var(--spacing-md) !important;
  margin-top: var(--spacing-sm) !important;
}

.info-alert-banner {
  border: var(--border-width) solid var(--color-border) !important;
  background-color: var(--color-bg-alt) !important;
  padding: var(--spacing-sm) var(--spacing-md) !important;
  font-family: var(--font-main) !important;
  font-size: 12px !important;
  line-height: 1.5 !important;
  color: var(--color-text-main) !important;
}

.edit-split-layout {
  display: flex !important;
  flex-direction: column !important;
  gap: var(--spacing-md) !important;
  width: 100% !important;
}

.comparison-row {
  display: grid !important;
  grid-template-columns: 1fr 1fr !important;
  gap: var(--spacing-lg) !important;
  align-items: center !important;
  border-bottom: 1px dashed var(--color-border) !important;
  padding-bottom: var(--spacing-md) !important;
  width: 100% !important;
}

.comparison-row.single-col-row {
  grid-template-columns: 1fr !important;
}

.comparison-row:last-child {
  border-bottom: none !important;
  padding-bottom: 0 !important;
}

.form-group {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
  min-width: 0 !important;
}

.suggestion-group {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
  min-width: 0 !important;
}

.form-label {
  font-family: var(--font-main) !important;
  font-size: 11px !important;
  font-weight: bold !important;
  text-transform: uppercase !important;
  color: var(--color-text-main) !important;
}

.disabled-input {
  background-color: var(--color-bg-alt) !important;
  color: var(--color-text-muted) !important;
  cursor: not-allowed !important;
}

.checkbox-container {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  margin-top: 4px !important;
}

.checkbox-label {
  font-family: var(--font-main) !important;
  font-size: 12px !important;
  color: var(--color-text-main) !important;
  cursor: pointer !important;
  user-select: none !important;
}

.suggestion-content-inline {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: var(--spacing-sm) !important;
  background-color: var(--color-bg-alt) !important;
  border: var(--border-width) solid var(--color-border) !important;
  padding: 8px var(--spacing-sm) !important;
  min-height: 40px !important;
  width: 100% !important;
  box-sizing: border-box !important;
}

.suggestion-value-text {
  font-family: var(--font-main) !important;
  font-size: 12px !important;
  font-weight: bold !important;
  color: var(--color-text-main) !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  flex: 1 !important;
  min-width: 0 !important;
}

.apply-btn-inline {
  font-size: 11px !important;
  padding: 0 8px !important;
  flex-shrink: 0 !important;
  margin: 0 !important;
  width: auto !important;
  height: 26px !important;
  line-height: 26px !important;
}

.suggestion-match-inline {
  font-size: 11px !important;
  color: #2e7d32 !important;
  font-weight: bold !important;
  flex-shrink: 0 !important;
}

.suggestion-loading-inline, .suggestion-none-inline {
  display: flex !important;
  align-items: center !important;
  background-color: var(--color-bg-alt) !important;
  border: var(--border-width) solid var(--color-border) !important;
  padding: 8px var(--spacing-sm) !important;
  min-height: 40px !important;
  font-size: 11px !important;
  color: var(--color-text-muted) !important;
  text-transform: uppercase !important;
  width: 100% !important;
  box-sizing: border-box !important;
}

.form-actions-row {
  display: flex !important;
  gap: var(--spacing-md) !important;
  margin-top: var(--spacing-sm) !important;
  border-top: var(--border-width) dashed var(--color-border) !important;
  padding-top: var(--spacing-md) !important;
}

@media (max-width: 768px) {
  .comparison-row {
    grid-template-columns: 1fr !important;
    gap: var(--spacing-sm) !important;
    padding-bottom: var(--spacing-sm) !important;
  }
}

.selected-genres-row {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 6px !important;
  margin-bottom: 6px !important;
}

.genre-active-chip {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  background: #1e293b !important;
  color: #ffffff !important;
  padding: 3px 8px !important;
  font-size: 11px !important;
  font-weight: 700 !important;
  border: 1.5px solid #0f172a !important;
}

.chip-remove-btn {
  background: none !important;
  border: none !important;
  color: #fca5a5 !important;
  font-weight: 900 !important;
  cursor: pointer !important;
  padding: 0 2px !important;
}

.genres-picker-grid {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 5px !important;
  max-height: 150px !important;
  overflow-y: auto !important;
  padding: 6px !important;
  border: 1px solid #cbd5e1 !important;
  background: #f8fafc !important;
}

.genre-toggle-chip {
  background: #ffffff !important;
  color: #0f172a !important;
  border: 1px solid #94a3b8 !important;
  padding: 3px 7px !important;
  font-size: 11px !important;
  font-weight: 600 !important;
  cursor: pointer !important;
}

.genre-toggle-chip.active {
  background: #dcfce7 !important;
  color: #166534 !important;
  border-color: #166534 !important;
  font-weight: 800 !important;
}

.custom-genre-add-row {
  display: flex !important;
  gap: 6px !important;
  align-items: center !important;
  margin-top: 6px !important;
}

.cover-candidates-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.45rem;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  background: var(--color-bg-alt, #f8fafc);
}

.cover-candidate-thumb-btn {
  padding: 2px;
  border: 2px solid transparent;
  border-radius: 6px;
  background: #ffffff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s ease, transform 0.12s ease;
}

.cover-candidate-thumb-btn:hover {
  border-color: #94a3b8;
  transform: translateY(-1px);
}

.cover-candidate-thumb-btn.selected {
  border-color: var(--color-primary, #4f46e5);
  box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.2);
}

.cover-candidate-img {
  width: 44px;
  height: 62px;
  object-fit: cover;
  border-radius: 4px;
  display: block;
}
</style>
