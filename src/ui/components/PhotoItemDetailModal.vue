<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RecognizedBookCandidate } from '../../core/services/byok-vision.service';
import type { PhotoResolutionOption, ResolvedPhotoItem } from '../../core/services/photo-book-resolution.service';
import { imageUtil } from '../../core/utils/image.util';

const props = defineProps<{
  show: boolean;
  item: ResolvedPhotoItem | null;
  sourcePhotoUrl?: string;
  positionLabel?: string;
  retrying?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'select-option', option: PhotoResolutionOption | null): void;
  (
    e: 'update-fields',
    payload: {
      title: string;
      series: string;
      seriesNumber: string;
      isIntegral: boolean;
      includedVolumeNumbers?: string[];
      selected: boolean;
    }
  ): void;
  (e: 'retry-bnf', candidate: RecognizedBookCandidate): void;
}>();

const localTitle = ref('');
const localSeries = ref('');
const localVolume = ref('');
const localAuthor = ref('');
const localIsbn = ref('');
const localIsIntegral = ref(false);
const localIncludedVolumesText = ref('');
const localSelected = ref(true);
const showManualForm = ref(false);
const zoomedImageUrl = ref<string | null>(null);
const zoomedImageAlt = ref('');

function parseIncludedVolumesInput(raw: string): string[] {
  const result = new Set<number>();
  const cleaned = (raw || '').trim();
  if (!cleaned) return [];
  // Plages : "1 à 3", "1-3", "4 au 6"
  const rangeRe = /(\d{1,3})\s*(?:[àa]|au|-|–)\s*(\d{1,3})/gi;
  let m: RegExpExecArray | null;
  let stripped = cleaned;
  while ((m = rangeRe.exec(cleaned)) !== null) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (start > 0 && end >= start && end - start <= 30) {
      for (let i = start; i <= end; i++) result.add(i);
    }
    stripped = stripped.replace(m[0], ' ');
  }
  // Numéros isolés : "1, 2, 3" ou "1 2 3"
  for (const tok of stripped.split(/[^0-9]+/)) {
    if (!tok) continue;
    const n = parseInt(tok, 10);
    if (n > 0 && n <= 200) result.add(n);
  }
  return Array.from(result)
    .sort((a, b) => a - b)
    .map(String);
}

const parsedIncludedVolumes = computed(() => parseIncludedVolumesInput(localIncludedVolumesText.value));

watch(
  () => [
    props.show,
    props.item?.id,
    props.item?.isbn13,
    props.item?.title,
    props.item?.isIntegral,
    props.item?.selected
  ],
  () => {
    if (!props.item) return;
    localTitle.value = props.item.title || props.item.rawCandidate.title || '';
    localSeries.value = props.item.series || props.item.rawCandidate.series || '';
    localVolume.value = props.item.seriesNumber || props.item.rawCandidate.volumeNumber || '';
    localAuthor.value = props.item.authors?.[0] || props.item.rawCandidate.author || '';
    localIsbn.value = props.item.isbn13 || props.item.rawCandidate.isbn || '';
    localIsIntegral.value = Boolean(props.item.isIntegral);
    localIncludedVolumesText.value = props.item.includedVolumeNumbers?.length
      ? props.item.includedVolumeNumbers.join(', ')
      : '';
    localSelected.value = Boolean(props.item.selected);
    showManualForm.value = props.item.status === 'unresolved' || (props.item.alternatives?.length || 0) === 0;
    zoomedImageUrl.value = null;
  },
  { immediate: true }
);

const spinePositionText = computed(() => {
  const c = props.item?.rawCandidate;
  if (!c?.spineIndex) return '';
  if (c.totalSpines && c.totalSpines >= c.spineIndex) {
    const fromRight = c.totalSpines - c.spineIndex + 1;
    return `Tranche n° ${c.spineIndex} depuis la gauche • n° ${fromRight} depuis la droite (sur ${c.totalSpines})`;
  }
  return `Tranche n° ${c.spineIndex} depuis la gauche`;
});

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (zoomedImageUrl.value) {
      zoomedImageUrl.value = null;
      return;
    }
    if (props.show) emit('close');
  }
};
onMounted(() => window.addEventListener('keydown', onKeyDown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown));

const openZoom = (url: string | undefined, alt: string) => {
  if (!url) return;
  zoomedImageUrl.value = url;
  zoomedImageAlt.value = alt;
};

const commitFieldChanges = () => {
  emit('update-fields', {
    title: localTitle.value.trim(),
    series: localSeries.value.trim(),
    seriesNumber: localVolume.value.trim(),
    isIntegral: localIsIntegral.value,
    includedVolumeNumbers: localIsIntegral.value ? parsedIncludedVolumes.value : undefined,
    selected: localSelected.value
  });
};

const handleOptionTap = (opt: PhotoResolutionOption | null) => {
  emit('select-option', opt);
  if (opt) {
    localTitle.value = opt.title || localTitle.value;
    localSeries.value = opt.series || localSeries.value;
    localVolume.value = opt.seriesNumber || '';
    localIsIntegral.value = Boolean(opt.isIntegral);
    localSelected.value = true;
  } else {
    localSelected.value = false;
  }
};

const handleSearchBnf = () => {
  if (!props.item) return;
  emit('retry-bnf', {
    ...props.item.rawCandidate,
    title: localTitle.value.trim(),
    series: localSeries.value.trim() || undefined,
    volumeNumber: localVolume.value.trim() || undefined,
    author: localAuthor.value.trim() || undefined,
    isbn: localIsbn.value.trim() || undefined
  });
};

const handleConfirmClose = () => {
  commitFieldChanges();
  emit('close');
};
</script>

<template>
  <Teleport to="body">
    <div v-if="show && item" class="detail-backdrop" @click.self="handleConfirmClose">
      <div class="detail-sheet" role="dialog" aria-modal="true" aria-label="Détail édition et arbitrage">
        <!-- En-tête sticky navigation -->
        <header class="detail-header">
          <button type="button" class="back-pill-btn" @click="handleConfirmClose">
            ← Retour à la liste
          </button>
          <span v-if="positionLabel" class="pos-pill">{{ positionLabel }}</span>
        </header>

        <div class="detail-body">
          <!-- Localisation physique sur l'étagère + photo d'origine -->
          <div v-if="spinePositionText || item.rawCandidate.rawSpineText || sourcePhotoUrl" class="shelf-locator-box">
            <div v-if="spinePositionText" class="shelf-pos-line">
              <strong>Position sur votre photo :</strong> {{ spinePositionText }}
            </div>
            <div v-if="item.rawCandidate.rawSpineText" class="shelf-ocr-line">
              Texte lu sur la tranche : « {{ item.rawCandidate.rawSpineText }} »
            </div>
            <button
              v-if="sourcePhotoUrl"
              type="button"
              class="shelf-photo-btn"
              title="Agrandir la photo d'origine"
              @click="openZoom(sourcePhotoUrl, 'Photo d’origine de votre étagère')"
            >
              <img :src="sourcePhotoUrl" alt="Photo de l'étagère" class="shelf-photo-preview" />
              <span class="zoom-hint-pill">🔍 Agrandir la photo</span>
            </button>
          </div>

          <!-- Aperçu agrandi du livre actuellement retenu -->
          <div class="current-summary-card">
            <div class="summary-cover-wrap">
              <button
                v-if="item.coverUrl"
                type="button"
                class="cover-zoom-btn"
                title="Agrandir la couverture"
                @click="openZoom(imageUtil.resolveCoverUrl(item.coverUrl), localTitle)"
              >
                <img
                  :src="imageUtil.resolveCoverUrl(item.coverUrl)"
                  :alt="localTitle"
                  class="summary-cover"
                  @error="imageUtil.advanceCoverFallback(item)"
                />
                <span class="cover-zoom-badge">🔍</span>
              </button>
              <div v-else class="summary-cover-placeholder">
                <span>{{ localTitle.slice(0, 24) }}</span>
              </div>
            </div>
            <div class="summary-meta">
              <div class="summary-badges">
                <span v-if="localIsIntegral" class="badge integral">
                  Intégrale<template v-if="parsedIncludedVolumes.length"> (T.{{ parsedIncludedVolumes.join(', ') }})</template>
                </span>
                <span v-else-if="localSeries" class="badge series">
                  {{ localSeries }}<template v-if="localVolume"> T.{{ localVolume }}</template>
                </span>
                <span v-if="item.alreadyOwned" class="badge owned">Déjà possédé</span>
              </div>
              <h3 class="summary-title">{{ localTitle || 'Ouvrage à préciser' }}</h3>
              <p class="summary-sub">
                {{ item.authors.join(', ') || 'Auteur inconnu' }}
                <template v-if="item.publisher"> • {{ item.publisher }}</template>
                <template v-if="item.publishDate"> ({{ item.publishDate }})</template>
                <template v-if="item.pageCount"> • {{ item.pageCount }} p.</template>
              </p>
              <code v-if="item.isbn13" class="isbn-chip">ISBN {{ item.isbn13 }}</code>
            </div>
          </div>

          <!-- Contrôle explicite Format & Tomes inclus (si Intégrale) & Sélection -->
          <div class="format-bar">
            <div class="format-segmented" role="group" aria-label="Format du livre">
              <button
                type="button"
                class="seg-btn"
                :class="{ active: !localIsIntegral }"
                @click="localIsIntegral = false; commitFieldChanges()"
              >
                Tome / Album standard
              </button>
              <button
                type="button"
                class="seg-btn"
                :class="{ active: localIsIntegral }"
                @click="localIsIntegral = true; commitFieldChanges()"
              >
                Intégrale / Coffret
              </button>
            </div>

            <div v-if="localIsIntegral" class="integral-volumes-box">
              <label class="integral-volumes-label" for="integral-vols-input">
                <strong>Tomes inclus dans cette intégrale :</strong>
              </label>
              <input
                id="integral-vols-input"
                v-model="localIncludedVolumesText"
                type="text"
                class="cand-input"
                placeholder="ex : 1 à 3  ou  4, 5, 6"
                @input="commitFieldChanges"
              />
              <div v-if="parsedIncludedVolumes.length > 0" class="included-vols-chips">
                <span v-for="v in parsedIncludedVolumes" :key="v" class="vol-chip">Tome {{ v }}</span>
              </div>
              <small v-else class="integral-vols-hint">
                Précisez les numéros de tomes (ex: « 1 à 3 » ou « 4, 5, 6 ») pour que votre série sache exactement quels tomes vous possédez.
              </small>
            </div>

            <label class="include-check-row">
              <input v-model="localSelected" type="checkbox" class="wireframe-checkbox" @change="commitFieldChanges" />
              <span>Sélectionner pour l'ajout dans ma Collection</span>
            </label>
          </div>

          <!-- Liste claire des éditions proposées -->
          <div v-if="(item.alternatives?.length || 0) > 0" class="alternatives-block">
            <h4>Éditions trouvées ({{ item.alternatives?.length }})</h4>
            <div class="alternatives-list">
              <label
                v-for="opt in item.alternatives"
                :key="opt.isbn13"
                class="alt-option-card"
                :class="{ chosen: (item.selectedAlternativeIsbn || item.isbn13) === opt.isbn13 && localSelected }"
              >
                <input
                  type="radio"
                  :name="`detail-alt-${item.id}`"
                  :checked="(item.selectedAlternativeIsbn || item.isbn13) === opt.isbn13 && localSelected"
                  @change="handleOptionTap(opt)"
                />
                <img
                  v-if="opt.coverUrl"
                  :src="imageUtil.resolveCoverUrl(opt.coverUrl)"
                  :alt="opt.title"
                  class="alt-cover"
                  @error="imageUtil.advanceCoverFallback(opt)"
                />
                <div v-else class="alt-cover alt-cover-empty">?</div>
                <div class="alt-meta">
                  <div class="alt-top-row">
                    <span v-if="opt.isIntegral" class="badge integral">Intégrale</span>
                    <span v-else-if="opt.series" class="badge series">
                      {{ opt.series }}<template v-if="opt.seriesNumber"> T.{{ opt.seriesNumber }}</template>
                    </span>
                    <strong>{{ opt.title }}</strong>
                  </div>
                  <small>
                    {{ opt.publisher || 'Éditeur non précisé' }}
                    <template v-if="opt.publishDate"> • {{ opt.publishDate }}</template>
                    <template v-if="opt.pageCount"> • {{ opt.pageCount }} p.</template>
                  </small>
                  <small class="alt-isbn">{{ opt.isbn13 }}</small>
                </div>
              </label>

              <label
                class="alt-option-card ignore-row"
                :class="{ chosen: item.selectedAlternativeIsbn === '__ignore__' || !localSelected }"
              >
                <input
                  type="radio"
                  :name="`detail-alt-${item.id}`"
                  :checked="item.selectedAlternativeIsbn === '__ignore__' || !localSelected"
                  @change="handleOptionTap(null)"
                />
                <span>Ignorer ce résultat (ne pas ajouter)</span>
              </label>
            </div>
          </div>

          <!-- Recherche / correction manuelle BnF -->
          <div class="manual-block">
            <button type="button" class="link-toggle-btn" @click="showManualForm = !showManualForm">
              {{ showManualForm ? '▾ Masquer la recherche manuelle BnF' : '▸ Corriger titre / série / ISBN et relancer la BnF' }}
            </button>

            <div v-if="showManualForm" class="manual-grid">
              <input v-model="localTitle" placeholder="Titre exact" class="cand-input" />
              <div class="manual-two-col">
                <input v-model="localSeries" placeholder="Série (si applicable)" class="cand-input" />
                <input v-model="localVolume" placeholder="N° Tome" class="cand-input" />
              </div>
              <div class="manual-two-col">
                <input v-model="localAuthor" placeholder="Auteur" class="cand-input" />
                <input v-model="localIsbn" placeholder="ISBN-13 (optionnel)" class="cand-input" />
              </div>
              <button
                type="button"
                class="wireframe-btn"
                :disabled="retrying"
                @click="handleSearchBnf"
              >
                {{ retrying ? 'Recherche BnF en cours...' : 'Relancer la recherche BnF' }}
              </button>
              <small v-if="item.failureReason" class="warn-hint">{{ item.failureReason }}</small>
            </div>
          </div>
        </div>

        <footer class="detail-footer">
          <button type="button" class="wireframe-btn primary confirm-btn" @click="handleConfirmClose">
            Valider et revenir à la liste
          </button>
        </footer>
      </div>
    </div>

    <!-- Lightbox zoom plein écran (photo d'origine ou couverture) -->
    <div v-if="zoomedImageUrl" class="zoom-lightbox" @click="zoomedImageUrl = null">
      <button type="button" class="zoom-close-btn" @click.stop="zoomedImageUrl = null">✕ Fermer</button>
      <img :src="zoomedImageUrl" :alt="zoomedImageAlt" class="zoom-lightbox-img" @click.stop />
    </div>
  </Teleport>
</template>

<style scoped>
.detail-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2200;
  background: rgba(15, 23, 42, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem;
}

.detail-sheet {
  width: 100%;
  max-width: 660px;
  max-height: 92dvh;
  background: var(--color-surface, #fff);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 55px rgba(15, 23, 42, 0.35);
}

@media (max-width: 640px) {
  .detail-backdrop {
    padding: 0;
  }
  .detail-sheet {
    max-width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    border-radius: 0;
  }
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
}

.back-pill-btn {
  display: inline-flex;
  align-items: center;
  min-height: 40px;
  padding: 0.45rem 0.85rem;
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  background: #fff;
  color: #0f172a;
  font-weight: 700;
  font-size: 0.9rem;
  cursor: pointer;
}

.pos-pill {
  font-size: 0.78rem;
  font-weight: 700;
  color: #475569;
  background: #e2e8f0;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
}

.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.shelf-locator-box {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 10px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.84rem;
  color: #1e3a8a;
}

.shelf-ocr-line {
  font-size: 0.8rem;
  color: #334155;
}

.shelf-photo-btn {
  position: relative;
  margin-top: 0.35rem;
  padding: 0;
  border: 1px solid #93c5fd;
  border-radius: 8px;
  overflow: hidden;
  background: #0f172a;
  cursor: zoom-in;
  display: block;
  width: 100%;
}

.shelf-photo-preview {
  display: block;
  width: 100%;
  max-height: 155px;
  object-fit: cover;
}

.zoom-hint-pill {
  position: absolute;
  right: 0.45rem;
  bottom: 0.45rem;
  background: rgba(15, 23, 42, 0.78);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
}

.current-summary-card {
  display: flex;
  gap: 0.95rem;
  padding: 0.85rem;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
  align-items: flex-start;
}

.summary-cover-wrap {
  flex-shrink: 0;
}

.cover-zoom-btn {
  position: relative;
  display: block;
  padding: 0;
  border: none;
  background: transparent;
  cursor: zoom-in;
}

.summary-cover {
  width: 132px;
  height: 192px;
  object-fit: cover;
  border-radius: 8px;
  background: #f1f5f9;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.14);
}

.cover-zoom-badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  background: rgba(15, 23, 42, 0.75);
  color: #fff;
  font-size: 0.75rem;
  padding: 0.12rem 0.35rem;
  border-radius: 999px;
}

.summary-cover-placeholder {
  width: 132px;
  height: 192px;
  border-radius: 8px;
  background: #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0.5rem;
  font-size: 0.78rem;
  color: #475569;
}

.integral-volumes-box {
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 10px;
  padding: 0.7rem 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.integral-volumes-label {
  font-size: 0.82rem;
  color: #92400e;
}

.included-vols-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.vol-chip {
  font-size: 0.74rem;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #f59e0b;
}

.integral-vols-hint {
  font-size: 0.76rem;
  color: #78350f;
}

.zoom-lightbox {
  position: fixed;
  inset: 0;
  z-index: 2500;
  background: rgba(2, 6, 23, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.zoom-close-btn {
  position: absolute;
  top: 1rem;
  right: 1rem;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  padding: 0.45rem 0.9rem;
  font-weight: 700;
  font-size: 0.88rem;
  cursor: pointer;
}

.zoom-lightbox-img {
  max-width: 96vw;
  max-height: 88dvh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
}

.summary-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.summary-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.badge {
  display: inline-block;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0.14rem 0.45rem;
  border-radius: 999px;
}

.badge.integral {
  background: #fef3c7;
  color: #92400e;
}

.badge.series {
  background: #dbeafe;
  color: #1e40af;
}

.badge.owned {
  background: #dcfce7;
  color: #166534;
}

.summary-title {
  margin: 0;
  font-size: 1rem;
  color: #0f172a;
}

.summary-sub {
  margin: 0;
  font-size: 0.82rem;
  color: #475569;
}

.isbn-chip {
  align-self: flex-start;
  font-size: 0.74rem;
  background: #f1f5f9;
  padding: 0.15rem 0.45rem;
  border-radius: 6px;
  color: #334155;
}

.format-bar {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.format-segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.4rem;
}

.seg-btn {
  min-height: 40px;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: #f8fafc;
  color: #334155;
  font-weight: 600;
  font-size: 0.82rem;
  cursor: pointer;
}

.seg-btn.active {
  background: #0f172a;
  color: #fff;
  border-color: #0f172a;
}

.include-check-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
}

.alternatives-block h4 {
  margin: 0 0 0.5rem 0;
  font-size: 0.92rem;
}

.alternatives-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.alt-option-card {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  cursor: pointer;
}

.alt-option-card.chosen {
  border-color: #2563eb;
  background: #eff6ff;
}

.alt-cover {
  width: 44px;
  height: 66px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
}

.alt-cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e2e8f0;
  color: #64748b;
  font-weight: 700;
}

.alt-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.alt-top-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.86rem;
}

.alt-meta small {
  color: #475569;
  font-size: 0.77rem;
}

.alt-isbn {
  font-family: monospace;
  font-size: 0.73rem !important;
}

.ignore-row {
  color: #64748b;
  font-size: 0.86rem;
}

.manual-block {
  border-top: 1px solid #e2e8f0;
  padding-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.link-toggle-btn {
  align-self: flex-start;
  border: none;
  background: none;
  color: #2563eb;
  font-weight: 700;
  font-size: 0.84rem;
  padding: 0;
  cursor: pointer;
}

.manual-grid {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.manual-two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.cand-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.65rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 0.88rem;
}

.warn-hint {
  color: #b45309;
  font-size: 0.8rem;
}

.detail-footer {
  padding: 0.75rem 1rem;
  border-top: 1px solid #e2e8f0;
  background: #f8fafc;
}

.confirm-btn {
  width: 100%;
  min-height: 44px;
}
</style>
