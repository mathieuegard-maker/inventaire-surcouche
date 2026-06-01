<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { databaseService } from '../../core/database/database.service';
import { entityResolver } from '../../core/resolvers/entity.resolver';
import { externalMetadataService } from '../../core/services/external-metadata.service';
import BaseHeader from '../components/BaseHeader.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BaseButton from '../components/BaseButton.vue';
import { imageUtil } from '../../core/utils/image.util';
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
const noSeries = ref(false);

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
    loadingStatus.value = "Chargement des données actuelles depuis inventaire.io...";
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
};

const handleSave = () => {
  successMsg.value = "Sauvegarde simulée avec succès ! (Étape 1 validée)";
  console.log("[BOOK EDIT] Formulaire soumis :", {
    title: titleInput.value,
    authors: authorsInput.value.split(',').map(a => a.trim()).filter(Boolean),
    series: seriesInput.value,
    seriesNumber: seriesNumberInput.value,
    publisher: publisherInput.value,
    publishDate: publishDateInput.value,
    pageCount: pageCountInput.value,
    coverUrl: coverUrlInput.value
  });
  setTimeout(() => {
    router.push(`/book/${encodeURIComponent(uri)}`);
  }, 1500);
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
            <strong>Mode Correction Sémantique :</strong> Modifiez les données à gauche ou copiez les suggestions de la BNF/OL à droite.
          </p>
          <BaseButton 
            v-if="suggestions" 
            @click="applyAllSuggestions" 
            style="padding: 6px 12px; font-size: 11px; font-weight: bold;"
          >
            [ TOUT APPLIQUER ]
          </BaseButton>
        </div>

        <div class="edit-split-layout">
          <!-- Titre -->
          <div class="comparison-row">
            <div class="form-group">
              <label class="form-label">Titre (Modifiable)</label>
              <input type="text" v-model="titleInput" class="wireframe-input" />
            </div>
            
            <div class="suggestion-group">
              <label class="form-label">Titre suggéré (BNF/OL)</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestions" class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.title">{{ suggestions.title || 'Non spécifié' }}</span>
                <BaseButton 
                  v-if="suggestions.title && suggestions.title !== titleInput" 
                  @click="applySuggestion('title')" 
                  class="apply-btn-inline"
                >
                  [ ➔ COPIER ]
                </BaseButton>
                <span v-else class="suggestion-match-inline">✅ Conforme</span>
              </div>
              <div v-else class="suggestion-none-inline">Aucune suggestion</div>
            </div>
          </div>

          <!-- Auteurs -->
          <div class="comparison-row">
            <div class="form-group">
              <label class="form-label">Auteurs (Séparés par des virgules)</label>
              <input type="text" v-model="authorsInput" class="wireframe-input" />
            </div>
            
            <div class="suggestion-group">
              <label class="form-label">Auteurs suggérés</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestions" class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.authors?.join(', ')">{{ suggestions.authors && suggestions.authors.length > 0 ? suggestions.authors.join(', ') : 'Non spécifié' }}</span>
                <BaseButton 
                  v-if="suggestions.authors && suggestions.authors.join(', ') !== authorsInput" 
                  @click="applySuggestion('authors')" 
                  class="apply-btn-inline"
                >
                  [ ➔ COPIER ]
                </BaseButton>
                <span v-else class="suggestion-match-inline">✅ Conforme</span>
              </div>
              <div v-else class="suggestion-none-inline">Aucune suggestion</div>
            </div>
          </div>

          <!-- Série -->
          <div class="comparison-row">
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
            </div>
            
            <div class="suggestion-group">
              <label class="form-label">Série suggérée</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestions" class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.series">{{ suggestions.series || 'Aucune' }}</span>
                <BaseButton 
                  v-if="suggestions.series !== seriesInput" 
                  @click="applySuggestion('series')" 
                  class="apply-btn-inline"
                >
                  [ ➔ COPIER ]
                </BaseButton>
                <span v-else class="suggestion-match-inline">✅ Conforme</span>
              </div>
              <div v-else class="suggestion-none-inline">Aucune suggestion</div>
            </div>
          </div>

          <!-- Tome -->
          <div class="comparison-row">
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
            
            <div class="suggestion-group">
              <label class="form-label">Tome suggéré</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestions" class="suggestion-content-inline">
                <span class="suggestion-value-text">{{ suggestions.seriesNumber || 'Aucun' }}</span>
                <BaseButton 
                  v-if="suggestions.seriesNumber !== seriesNumberInput" 
                  @click="applySuggestion('seriesNumber')" 
                  class="apply-btn-inline"
                >
                  [ ➔ COPIER ]
                </BaseButton>
                <span v-else class="suggestion-match-inline">✅ Conforme</span>
              </div>
              <div v-else class="suggestion-none-inline">Aucune suggestion</div>
            </div>
          </div>

          <!-- Éditeur -->
          <div class="comparison-row">
            <div class="form-group">
              <label class="form-label">Éditeur</label>
              <input type="text" v-model="publisherInput" class="wireframe-input" />
            </div>
            
            <div class="suggestion-group">
              <label class="form-label">Éditeur suggéré</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestions" class="suggestion-content-inline">
                <span class="suggestion-value-text" :title="suggestions.publisher">{{ suggestions.publisher || 'Non spécifié' }}</span>
                <BaseButton 
                  v-if="suggestions.publisher && suggestions.publisher !== publisherInput" 
                  @click="applySuggestion('publisher')" 
                  class="apply-btn-inline"
                >
                  [ ➔ COPIER ]
                </BaseButton>
                <span v-else class="suggestion-match-inline">✅ Conforme</span>
              </div>
              <div v-else class="suggestion-none-inline">Aucune suggestion</div>
            </div>
          </div>

          <!-- Année de publication -->
          <div class="comparison-row">
            <div class="form-group">
              <label class="form-label">Année de publication</label>
              <input type="text" v-model="publishDateInput" class="wireframe-input" />
            </div>
            
            <div class="suggestion-group">
              <label class="form-label">Année suggérée</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestions" class="suggestion-content-inline">
                <span class="suggestion-value-text">{{ suggestions.publishDate || 'Non spécifié' }}</span>
                <BaseButton 
                  v-if="suggestions.publishDate && suggestions.publishDate !== publishDateInput" 
                  @click="applySuggestion('publishDate')" 
                  class="apply-btn-inline"
                >
                  [ ➔ COPIER ]
                </BaseButton>
                <span v-else class="suggestion-match-inline">✅ Conforme</span>
              </div>
              <div v-else class="suggestion-none-inline">Aucune suggestion</div>
            </div>
          </div>

          <!-- Nombre de pages -->
          <div class="comparison-row">
            <div class="form-group">
              <label class="form-label">Nombre de pages</label>
              <input type="number" v-model="pageCountInput" class="wireframe-input" />
            </div>
            
            <div class="suggestion-group">
              <label class="form-label">Pages suggérées</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestions" class="suggestion-content-inline">
                <span class="suggestion-value-text">{{ suggestions.pageCount || 'Non spécifié' }}</span>
                <BaseButton 
                  v-if="suggestions.pageCount && suggestions.pageCount !== pageCountInput" 
                  @click="applySuggestion('pageCount')" 
                  class="apply-btn-inline"
                >
                  [ ➔ COPIER ]
                </BaseButton>
                <span v-else class="suggestion-match-inline">✅ Conforme</span>
              </div>
              <div v-else class="suggestion-none-inline">Aucune suggestion</div>
            </div>
          </div>

          <!-- Couverture -->
          <div class="comparison-row">
            <div class="form-group">
              <label class="form-label">URL de la couverture</label>
              <input type="text" v-model="coverUrlInput" class="wireframe-input" />
            </div>
            
            <div class="suggestion-group">
              <label class="form-label">Couverture suggérée</label>
              <div v-if="isSuggestionsLoading" class="suggestion-loading-inline">Recherche...</div>
              <div v-else-if="suggestions" class="suggestion-content-inline">
                <div style="display: flex; gap: var(--spacing-sm); align-items: center; min-width: 0; flex: 1;">
                  <img v-if="suggestions.coverUrl" :src="suggestions.coverUrl" style="width: 30px; height: 42px; border: var(--border-width) solid var(--color-border); object-fit: cover; flex-shrink: 0;" />
                  <span class="suggestion-value-text" style="font-size: 11px;">{{ suggestions.coverUrl ? 'Image disponible' : 'Aucune' }}</span>
                </div>
                <BaseButton 
                  v-if="suggestions.coverUrl && suggestions.coverUrl !== coverUrlInput" 
                  @click="applySuggestion('coverUrl')" 
                  class="apply-btn-inline"
                >
                  [ ➔ COPIER ]
                </BaseButton>
                <span v-else class="suggestion-match-inline">✅ Conforme</span>
              </div>
              <div v-else class="suggestion-none-inline">Aucune suggestion</div>
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
  padding: 4px 8px !important;
  flex-shrink: 0 !important;
  margin: 0 !important;
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
</style>
