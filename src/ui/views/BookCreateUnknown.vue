<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { isbnUtil } from '../../core/utils/isbn.util';
import { externalMetadataService } from '../../core/services/external-metadata.service';
import { bookCacheService } from '../../core/services/book-cache.service';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BaseButton from '../components/BaseButton.vue';
import { TEXTS } from '../locales/fr';
import type { HumanizedBook } from '../../core/types';
import { imageUtil } from '../../core/utils/image.util';

const route = useRoute();
const router = useRouter();

const isLoading = ref(true);
const errorMsg = ref<string | null>(null);
const successMsg = ref<string | null>(null);

// Champs réactifs du formulaire
const isbnInput = ref('');
const titleInput = ref('');
const authorsInput = ref('');
const publisherInput = ref('');
const publishDateInput = ref('');
const pageCountInput = ref<number | undefined>(undefined);
const coverUrlInput = ref('');
const seriesInput = ref('');
const seriesNumberInput = ref('');
const noSeries = ref(false);

// Watchers intelligents pour une UX fluide
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

let normalizedIsbn = '';

onMounted(async () => {
  const isbnQuery = route.query.isbn as string;
  if (!isbnQuery) {
    errorMsg.value = "ISBN manquant dans la requête de création.";
    isLoading.value = false;
    return;
  }

  normalizedIsbn = isbnUtil.normalize(isbnQuery);
  isbnInput.value = normalizedIsbn;

  if (!isbnUtil.isValidFormat(normalizedIsbn)) {
    errorMsg.value = "Le format de l'ISBN fourni est invalide.";
    isLoading.value = false;
    return;
  }

  console.log(`[CREATE UNKNOWN] Lancement de l'aspiration externe pour l'ISBN : ${normalizedIsbn}`);
  try {
    const extData = await externalMetadataService.fetchFromExternalSources(normalizedIsbn);
    
    if (extData) {
      titleInput.value = extData.title || '';
      authorsInput.value = extData.authors ? extData.authors.join(', ') : '';
      publisherInput.value = extData.publisher || '';
      publishDateInput.value = extData.publishDate || '';
      pageCountInput.value = extData.pageCount;
      coverUrlInput.value = extData.coverUrl || '';
      seriesInput.value = extData.series || '';
      seriesNumberInput.value = extData.seriesNumber || '';
      console.log(`[CREATE UNKNOWN] Métadonnées externes pré-remplies avec succès.`);
    } else {
      console.log(`[CREATE UNKNOWN] Aucune métadonnée externe trouvée pour pré-remplir l'ISBN ${normalizedIsbn}.`);
    }
  } catch (e: any) {
    console.error("[CREATE UNKNOWN] Erreur de récupération sémantique :", e);
  } finally {
    isLoading.value = false;
  }
});

const handleSave = async () => {
  errorMsg.value = null;
  successMsg.value = null;

  if (!titleInput.value.trim()) {
    errorMsg.value = "Le titre du livre est obligatoire.";
    return;
  }

  if (!noSeries.value && !seriesInput.value.trim()) {
    errorMsg.value = "Vous devez indiquer une série ou cocher la case 'Ce livre ne fait pas partie d'une série'.";
    return;
  }

  isLoading.value = true;

  try {
    const cleanTitle = titleInput.value.trim();
    const cleanAuthors = authorsInput.value
      .split(',')
      .map(a => a.trim())
      .filter(Boolean);

    const book: HumanizedBook = {
      uri: `isbn:${normalizedIsbn}`,
      isbn13: normalizedIsbn.length === 13 ? normalizedIsbn : undefined,
      isbn10: normalizedIsbn.length === 10 ? normalizedIsbn : undefined,
      type: 'edition',
      title: cleanTitle,
      authors: cleanAuthors,
      illustrators: [],
      scriptwriters: [],
      publisher: publisherInput.value.trim() || undefined,
      publishDate: publishDateInput.value.trim() || undefined,
      pageCount: pageCountInput.value || undefined,
      coverUrl: coverUrlInput.value.trim() || undefined,
      genres: [],
      ownershipStatus: 'none', // Par défaut 'none' pour laisser l'utilisateur l'ajouter ensuite
      series: noSeries.value ? undefined : (seriesInput.value.trim() || undefined),
      seriesNumber: noSeries.value ? undefined : (seriesNumberInput.value.trim() || undefined)
    };

    console.log(`[CREATE UNKNOWN] Sauvegarde du nouveau livre local :`, book);
    await bookCacheService.saveAndProcessImage(book);

    successMsg.value = "Ouvrage créé avec succès dans la base locale ! Redirection...";
    setTimeout(() => {
      router.push(`/book/${encodeURIComponent(book.uri)}`);
    }, 1500);
  } catch (err: any) {
    console.error("[CREATE UNKNOWN] Erreur lors de la sauvegarde :", err);
    errorMsg.value = "Impossible de sauvegarder l'ouvrage localement : " + err.message;
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader title="Création d'ouvrage" showBack />

    <BaseLoading v-if="isLoading && !successMsg" />

    <div v-else class="creation-unknown-container">
      <BaseBanner v-if="errorMsg" type="error" :message="errorMsg" />
      <BaseBanner v-if="successMsg" type="success" :message="successMsg" />

      <div v-if="!successMsg" class="creation-box">
        <div class="info-alert-banner">
          <p>
            <strong>ISBN inconnu d'inventaire.io :</strong> Nous avons cherché des informations sur la BNF et Open Library pour vous aider à pré-remplir la fiche de cet ouvrage. Vous pouvez modifier et valider les champs ci-dessous pour l'enregistrer dans votre base locale.
          </p>
        </div>

        <div class="book-creation-form-layout">
          <!-- Aperçu de la couverture à gauche -->
          <div class="form-cover-preview-section">
            <div class="preview-title">Aperçu couverture</div>
            <div v-if="coverUrlInput" class="cover-preview-box">
              <img :src="imageUtil.resolveCoverUrl(coverUrlInput)" alt="Prévisualisation" class="cover-preview-img" />
            </div>
            <div v-else class="cover-preview-placeholder">
              Aucune image
            </div>
          </div>

          <!-- Formulaire à droite -->
          <div class="form-fields-section">
            <div class="form-group">
              <label class="form-label">ISBN (Fixe)</label>
              <input type="text" v-model="isbnInput" disabled class="wireframe-input isbn-disabled-input" />
            </div>

            <div class="form-group">
              <label class="form-label">Titre (Obligatoire)</label>
              <input type="text" v-model="titleInput" placeholder="Ex: Astérix le Gaulois" class="wireframe-input" />
            </div>

            <div class="form-group">
              <label class="form-label">Auteurs (Séparés par des virgules)</label>
              <input type="text" v-model="authorsInput" placeholder="Ex: René Goscinny, Albert Uderzo" class="wireframe-input" />
            </div>

            <div class="form-group">
              <label class="form-label">Série (Obligatoire, ou cocher "Non" ci-dessous)</label>
              <div class="series-fields-row">
                <input 
                  type="text" 
                  v-model="seriesInput" 
                  placeholder="Nom de la série (Ex: Astérix)" 
                  :disabled="noSeries" 
                  class="wireframe-input series-name-input" 
                  :class="{ 'isbn-disabled-input': noSeries }"
                />
                <input 
                  type="text" 
                  v-model="seriesNumberInput" 
                  placeholder="Tome (Ex: 39)" 
                  :disabled="noSeries" 
                  class="wireframe-input series-volume-input" 
                  :class="{ 'isbn-disabled-input': noSeries }"
                />
              </div>
              <div class="checkbox-container">
                <input type="checkbox" id="noSeriesCheckbox" v-model="noSeries" class="wireframe-checkbox" />
                <label for="noSeriesCheckbox" class="checkbox-label">Ce livre ne fait pas partie d'une série</label>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Éditeur</label>
              <input type="text" v-model="publisherInput" placeholder="Ex: Albert René" class="wireframe-input" />
            </div>

            <div class="form-group">
              <label class="form-label">Année de publication</label>
              <input type="text" v-model="publishDateInput" placeholder="Ex: 1999" class="wireframe-input" />
            </div>

            <div class="form-group">
              <label class="form-label">Nombre de pages</label>
              <input type="number" v-model="pageCountInput" placeholder="Ex: 48" class="wireframe-input" />
            </div>

            <div class="form-group">
              <label class="form-label">URL de l'image de couverture</label>
              <input type="text" v-model="coverUrlInput" placeholder="Ex: https://covers.openlibrary.org/b/id/..." class="wireframe-input" />
            </div>
          </div>
        </div>

        <div class="form-actions-row">
          <BaseButton type="primary" @click="handleSave" class="btn-save-creation">
            [ CRÉER L'OUVRAGE LOCALEMENT ]
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.creation-unknown-container {
  width: 100% !important;
  margin-bottom: var(--spacing-lg) !important;
}

.creation-box {
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

.book-creation-form-layout {
  display: flex !important;
  flex-direction: row !important;
  gap: var(--spacing-lg) !important;
  align-items: flex-start !important;
  width: 100% !important;
}

.form-cover-preview-section {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  width: 180px !important;
  flex-shrink: 0 !important;
}

.preview-title {
  font-family: var(--font-main) !important;
  font-size: 11px !important;
  font-weight: bold !important;
  text-transform: uppercase !important;
  margin-bottom: var(--spacing-xs) !important;
  color: var(--color-text-muted) !important;
}

.cover-preview-box {
  width: 100% !important;
  border: var(--border-width) solid var(--color-border) !important;
  background-color: var(--color-bg-alt) !important;
  display: flex !important;
  justify-content: center !important;
  align-items: center !important;
}

.cover-preview-img {
  width: 100% !important;
  height: auto !important;
  object-fit: contain !important;
}

.cover-preview-placeholder {
  width: 100% !important;
  height: 240px !important;
  border: var(--border-width) solid var(--color-border) !important;
  background-color: var(--color-bg-alt) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
  font-size: 12px !important;
  color: var(--color-text-muted) !important;
  text-transform: uppercase !important;
}

.form-fields-section {
  flex: 1 !important;
  display: flex !important;
  flex-direction: column !important;
  gap: var(--spacing-sm) !important;
}

.form-group {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
}

.form-label {
  font-family: var(--font-main) !important;
  font-size: 11px !important;
  font-weight: bold !important;
  text-transform: uppercase !important;
  color: var(--color-text-main) !important;
}

.isbn-disabled-input {
  background-color: var(--color-bg-alt) !important;
  color: var(--color-text-muted) !important;
  cursor: not-allowed !important;
}

.form-actions-row {
  display: flex !important;
  justify-content: flex-end !important;
  margin-top: var(--spacing-sm) !important;
  border-top: var(--border-width) dashed var(--color-border) !important;
  padding-top: var(--spacing-md) !important;
}

.btn-save-creation {
  width: 100% !important;
}

.series-fields-row {
  display: flex !important;
  gap: var(--spacing-sm) !important;
  width: 100% !important;
}

.series-name-input {
  flex: 1 !important;
}

.series-volume-input {
  width: 120px !important;
  flex-shrink: 0 !important;
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

@media (max-width: 600px) {
  .book-creation-form-layout {
    flex-direction: column !important;
    align-items: center !important;
  }
  .form-cover-preview-section {
    width: 150px !important;
    margin-bottom: var(--spacing-md) !important;
  }
  .cover-preview-placeholder {
    height: 200px !important;
  }
}
</style>
