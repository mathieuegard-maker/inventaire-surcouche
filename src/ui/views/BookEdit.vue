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
import { deduplicateCoverUrls } from '../../core/utils/cover-dedup.util';
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

// Formulaire modifiable
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

// Métadonnées externes pour pré-remplissage des champs vides & galerie de couvertures dédupliquée visuellement
const extMetadata = ref<any>(null);
const editionExtraCovers = ref<string[]>([]);
const deduplicatedCovers = ref<string[]>([]);
const isLoadingExtCovers = ref(false);

const rawCandidateUrls = computed(() => {
  const isbn = originalBook.value?.isbn13 || originalBook.value?.isbn10;
  return imageUtil.buildCoverCandidates(isbn, [
    originalBook.value?.coverUrl,
    extMetadata.value?.coverUrl,
    ...editionExtraCovers.value,
    ...(extMetadata.value?.coverFallbackUrls || []),
    ...(originalBook.value?.coverFallbackUrls || [])
  ]);
});

const suggestedCoverCandidates = computed(() => {
  const sourceList = deduplicatedCovers.value.length > 0 ? deduplicatedCovers.value : rawCandidateUrls.value;
  return sourceList.filter((u) => !brokenCandidateUrls.value[u]);
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

const normStr = (v: unknown) => String(v ?? '').trim();

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
    const hadInitialSeries = Boolean(currentBook.series?.trim());

    // Pré-remplissage du formulaire avec les données actuelles
    titleInput.value = currentBook.title || '';
    authorsInput.value = currentBook.authors ? currentBook.authors.join(', ') : '';
    seriesInput.value = currentBook.series || '';
    seriesNumberInput.value = currentBook.seriesNumber || '';
    noSeries.value = !hadInitialSeries;
    publisherInput.value = currentBook.publisher || '';
    publishDateInput.value = currentBook.publishDate || '';
    pageCountInput.value = currentBook.pageCount;
    coverUrlInput.value = currentBook.coverUrl || '';
    genresInput.value = Array.isArray(currentBook.genres)
      ? currentBook.genres.filter((g) => !g.startsWith('wd:') && !g.startsWith('inv:'))
      : [];

    isLoading.value = false;

    // Recherche en arrière-plan sur nos sources + autres éditions de l'œuvre (Inventaire/Wikidata/OL) + déduplication visuelle dHash
    const isbn = currentBook.isbn13 || currentBook.isbn10;
    if (isbn || currentBook.workUri || currentBook.title) {
      isLoadingExtCovers.value = true;
      try {
        const coverParams = new URLSearchParams({
          isbn: isbn || '',
          workUri: currentBook.workUri || '',
          title: currentBook.title || '',
          author: currentBook.authors?.[0] || ''
        });
        const [extData, edCoversData] = await Promise.all([
          isbn ? externalMetadataService.fetchFromExternalSources(isbn).catch(() => null) : Promise.resolve(null),
          fetch(`/api/gateway?action=work-edition-covers&${coverParams.toString()}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        ]);

        if (Array.isArray(edCoversData?.coverUrls)) {
          editionExtraCovers.value = edCoversData.coverUrls;
        }

        if (extData) {
          extMetadata.value = extData;
          if (!titleInput.value.trim() && extData.title) {
            titleInput.value = extData.title;
          }
          if (!authorsInput.value.trim() && Array.isArray(extData.authors) && extData.authors.length > 0) {
            authorsInput.value = extData.authors.join(', ');
          }
          if (!hadInitialSeries && !seriesInput.value.trim() && extData.series) {
            seriesInput.value = extData.series;
            noSeries.value = false;
          }
          if (!noSeries.value && !seriesNumberInput.value.trim() && extData.seriesNumber) {
            seriesNumberInput.value = extData.seriesNumber;
          }
          if (!publisherInput.value.trim() && extData.publisher) {
            publisherInput.value = extData.publisher;
          }
          if (!publishDateInput.value.trim() && extData.publishDate) {
            publishDateInput.value = extData.publishDate;
          }
          if (!pageCountInput.value && extData.pageCount) {
            pageCountInput.value = extData.pageCount;
          }
          if (!coverUrlInput.value.trim() && extData.coverUrl) {
            coverUrlInput.value = extData.coverUrl;
          }
          if (genresInput.value.length === 0 && Array.isArray(extData.genres) && extData.genres.length > 0) {
            genresInput.value = [...extData.genres];
          }
        }

        // Afficher immédiatement la galerie, puis filtrer les doublons visuels en arrière-plan
        isLoadingExtCovers.value = false;
        void deduplicateCoverUrls(rawCandidateUrls.value, {
          maxCandidates: 36
        }).then((deduped) => {
          if (deduped.length > 0) deduplicatedCovers.value = deduped;
        });
      } catch (err: any) {
        console.warn('[BOOK EDIT] Recherche sources externes non critique :', err.message);
      } finally {
        isLoadingExtCovers.value = false;
      }
    }
  } catch (err: any) {
    console.error("[BOOK EDIT] Erreur d'initialisation :", err);
    errorMsg.value = "Une erreur est survenue lors de la récupération des données : " + err.message;
    isLoading.value = false;
  }
});

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
  loadingStatus.value = "Analyse des données...";

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
    }, 900);
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
    <BaseHeader title="Modifier la fiche" showBack />

    <div v-if="isLoading" class="edit-loading-box">
      <BaseLoading />
      <p class="edit-loading-label">{{ loadingStatus }}</p>
    </div>

    <div v-else class="edit-unknown-container">
      <BaseBanner v-if="errorMsg" type="error" :message="errorMsg" />
      <BaseBanner v-if="successMsg" type="success" :message="successMsg" />

      <div v-if="!errorMsg && !successMsg" class="edit-box">
        <div class="edit-form-grid">
          <!-- Titre -->
          <div class="form-group">
            <label class="form-label">Titre</label>
            <input type="text" v-model="titleInput" class="wireframe-input" />
          </div>

          <!-- Auteurs -->
          <div class="form-group">
            <label class="form-label">Auteurs (séparés par des virgules)</label>
            <input type="text" v-model="authorsInput" class="wireframe-input" />
          </div>

          <!-- Série & Tome -->
          <div class="edit-two-cols">
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
                  {{ originalBook.series ? 'Changer / fusionner la série' : 'Rattacher à une série' }}
                </button>
              </div>
            </div>

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
          </div>

          <!-- Éditeur / Année / Pages -->
          <div class="edit-three-cols">
            <div class="form-group">
              <label class="form-label">Éditeur</label>
              <input type="text" v-model="publisherInput" class="wireframe-input" />
            </div>

            <div class="form-group">
              <label class="form-label">Année de publication</label>
              <input type="text" v-model="publishDateInput" class="wireframe-input" />
            </div>

            <div class="form-group">
              <label class="form-label">Nombre de pages</label>
              <input type="number" v-model="pageCountInput" class="wireframe-input" />
            </div>
          </div>

          <!-- Couverture + sélecteur multi-sources -->
          <div class="form-group">
            <label class="form-label">Couverture</label>
            <div class="cover-url-preview-row">
              <img
                v-if="coverUrlInput"
                :src="imageUtil.resolveCoverUrl(coverUrlInput)"
                alt="Couverture actuelle"
                class="current-cover-thumb"
              />
              <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;">
                <input type="text" v-model="coverUrlInput" placeholder="URL ou image WebP..." class="wireframe-input" />
                <div>
                  <label class="wireframe-btn apply-btn-inline" style="cursor: pointer; width: auto; display: inline-flex; align-items: center;">
                    <input type="file" accept="image/*" capture="environment" hidden @change="handleCustomCoverUpload" />
                    Prendre / importer une photo (WebP)
                  </label>
                </div>
              </div>
            </div>

            <div v-if="isLoadingExtCovers" class="covers-hint-line">
              Recherche de couvertures alternatives en cours...
            </div>
            <div v-else-if="suggestedCoverCandidates.length > 0" class="cover-candidates-block">
              <span class="cover-candidates-title">Couvertures disponibles (cliquez pour choisir) :</span>
              <div class="cover-candidates-gallery">
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
            </div>
          </div>

          <!-- Genres personnels (appliqués à toute la série en cas de modification) -->
          <div class="form-group">
            <label class="form-label">
              Genre(s)
              <span v-if="!noSeries && (seriesInput || originalBook?.series)" class="series-genre-hint">
                (appliqués automatiquement à toute la série)
              </span>
            </label>
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
                class="wireframe-input custom-genre-input"
                @keydown.enter.prevent="addCustomGenreTag"
              />
              <button
                type="button"
                class="wireframe-btn custom-genre-add-btn"
                @click="addCustomGenreTag"
              >
                + Ajouter
              </button>
            </div>
          </div>
        </div>

        <div class="form-actions-row">
          <BaseButton @click="router.back()" style="flex: 1;" class="btn-cancel">
            Annuler
          </BaseButton>
          <BaseButton type="primary" @click="handleSave" style="flex: 2;" class="btn-save">
            Enregistrer les modifications
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- Modale de Déduplication (Séries / Auteurs) -->
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
.edit-loading-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  margin-top: var(--spacing-xl);
}

.edit-loading-label {
  font-family: var(--font-main);
  font-size: 0.85rem;
  color: var(--color-text-muted);
  font-weight: 600;
  text-align: center;
}

.edit-unknown-container {
  width: 100%;
  margin-bottom: var(--spacing-lg);
}

.edit-box {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 14px);
  background-color: var(--color-bg-main);
  box-shadow: var(--shadow-card);
  padding: var(--spacing-lg, 1.25rem);
  margin-top: var(--spacing-sm);
}

.edit-form-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
}

.edit-two-cols {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 0.85rem;
  align-items: start;
}

.edit-three-cols {
  display: grid;
  grid-template-columns: 1.5fr 1fr 1fr;
  gap: 0.85rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.form-label {
  font-family: var(--font-main);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--color-text-main);
}

.series-genre-hint {
  font-weight: 500;
  color: var(--color-text-muted);
  font-size: 0.74rem;
}

.disabled-input {
  background-color: var(--color-bg-alt);
  color: var(--color-text-muted);
  cursor: not-allowed;
}

.checkbox-container {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-top: 0.25rem;
}

.checkbox-label {
  font-family: var(--font-main);
  font-size: 0.82rem;
  color: var(--color-text-main);
  cursor: pointer;
  user-select: none;
}

.apply-btn-inline {
  font-size: 0.78rem;
  padding: 0.35rem 0.75rem;
  border-radius: var(--radius-sm, 8px);
  flex-shrink: 0;
  min-height: 32px;
}

.cover-url-preview-row {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}

.current-cover-thumb {
  width: 52px;
  height: 74px;
  border-radius: var(--radius-sm, 8px);
  border: 1px solid var(--color-border);
  object-fit: cover;
  flex-shrink: 0;
}

.covers-hint-line {
  font-size: 0.78rem;
  color: var(--color-text-muted);
  margin-top: 0.25rem;
}

.cover-candidates-block {
  margin-top: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.cover-candidates-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-muted);
}

.cover-candidates-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.5rem;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 10px);
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
  width: 46px;
  height: 66px;
  object-fit: cover;
  border-radius: 4px;
  display: block;
}

.selected-genres-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.25rem;
}

.genre-active-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  background: var(--color-primary, #4f46e5);
  color: #ffffff;
  border-radius: 999px;
  padding: 0.25rem 0.65rem;
  font-size: 0.78rem;
  font-weight: 600;
}

.chip-remove-btn {
  background: none;
  border: none;
  color: #e0e7ff;
  font-weight: 800;
  cursor: pointer;
  padding: 0 2px;
  font-size: 0.9rem;
  line-height: 1;
}

.genres-picker-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  max-height: 155px;
  overflow-y: auto;
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  background: var(--color-bg-alt);
}

.genre-toggle-chip {
  background: #ffffff;
  color: var(--color-text-main);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 0.25rem 0.6rem;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.genre-toggle-chip.active {
  background: #dcfce7;
  color: #166534;
  border-color: #86efac;
}

.custom-genre-add-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.3rem;
}

.custom-genre-input {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}

.custom-genre-add-btn {
  flex: 0 0 auto;
  width: auto !important;
  white-space: nowrap;
  padding: 0 0.95rem;
  font-size: 0.82rem;
}

.form-actions-row {
  display: flex;
  gap: 0.75rem;
  margin-top: var(--spacing-sm);
  border-top: 1px solid var(--color-border);
  padding-top: var(--spacing-md);
}

@media (max-width: 680px) {
  .edit-two-cols,
  .edit-three-cols {
    grid-template-columns: 1fr;
  }
}
</style>
