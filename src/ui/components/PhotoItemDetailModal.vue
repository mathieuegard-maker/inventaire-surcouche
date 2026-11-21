<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RecognizedBookCandidate } from '../../core/services/byok-vision.service';
import type { PhotoResolutionOption, ResolvedPhotoItem } from '../../core/services/photo-book-resolution.service';
import { imageUtil } from '../../core/utils/image.util';
import { scannerState } from '../../state/scanner';

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
const localPublisher = ref('');
const localIsbn = ref('');
const localIsIntegral = ref(false);
const localIncludedVolumesText = ref('');
const localSelected = ref(true);
const showManualForm = ref(false);
const zoomedImageUrl = ref<string | null>(null);
const zoomedImageAlt = ref('');
const zoomScale = ref(1);
const panX = ref(0);
const panY = ref(0);
const isDraggingZoom = ref(false);
let dragStartX = 0;
let dragStartY = 0;
let dragOriginX = 0;
let dragOriginY = 0;
let pinchStartDist = 0;
let pinchStartScale = 1;
const exhaustedOptionCovers = ref<Record<string, boolean>>({});

function resetZoomTransform() {
  zoomScale.value = 1;
  panX.value = 0;
  panY.value = 0;
  isDraggingZoom.value = false;
}

function clampZoom(next: number): number {
  return Math.max(1, Math.min(4.5, Math.round(next * 100) / 100));
}

function adjustZoom(delta: number) {
  const next = clampZoom(zoomScale.value + delta);
  zoomScale.value = next;
  if (next <= 1) {
    panX.value = 0;
    panY.value = 0;
  }
}

function toggleDoubleTapZoom() {
  if (zoomScale.value > 1.2) {
    resetZoomTransform();
  } else {
    zoomScale.value = 2.5;
  }
}

function onZoomWheel(e: WheelEvent) {
  const step = e.deltaY < 0 ? 0.35 : -0.35;
  adjustZoom(step);
}

function onZoomPointerDown(e: PointerEvent) {
  if (zoomScale.value <= 1) return;
  isDraggingZoom.value = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragOriginX = panX.value;
  dragOriginY = panY.value;
  (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
}

function onZoomPointerMove(e: PointerEvent) {
  if (!isDraggingZoom.value || zoomScale.value <= 1) return;
  panX.value = dragOriginX + (e.clientX - dragStartX);
  panY.value = dragOriginY + (e.clientY - dragStartY);
}

function onZoomPointerUp() {
  isDraggingZoom.value = false;
}

function getTouchDistance(t1: Touch, t2: Touch): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.hypot(dx, dy);
}

function onZoomTouchStart(e: TouchEvent) {
  if (e.touches.length === 2) {
    isDraggingZoom.value = false;
    pinchStartDist = getTouchDistance(e.touches[0], e.touches[1]);
    pinchStartScale = zoomScale.value;
  }
}

function onZoomTouchMove(e: TouchEvent) {
  if (e.touches.length === 2 && pinchStartDist > 0) {
    e.preventDefault();
    const dist = getTouchDistance(e.touches[0], e.touches[1]);
    const ratio = dist / pinchStartDist;
    const next = clampZoom(pinchStartScale * ratio);
    zoomScale.value = next;
    if (next <= 1) {
      panX.value = 0;
      panY.value = 0;
    }
  }
}

function onZoomTouchEnd(e: TouchEvent) {
  if (e.touches.length < 2) {
    pinchStartDist = 0;
  }
}

function resolveOptionCoverSrc(opt: PhotoResolutionOption): string {
  if (exhaustedOptionCovers.value[opt.isbn13]) return '';
  if (opt.coverUrl) {
    return imageUtil.resolveExternalUrl(opt.coverUrl, opt.isbn13);
  }
  const candidates = imageUtil.buildCoverCandidates(opt.isbn13, opt.coverFallbackUrls || []);
  if (candidates.length > 0) {
    opt.coverUrl = candidates[0];
    opt.coverFallbackUrls = candidates;
    return imageUtil.resolveExternalUrl(candidates[0], opt.isbn13);
  }
  return opt.isbn13 ? `/api/gateway?action=image-proxy&isbn=${encodeURIComponent(opt.isbn13)}` : '';
}

function onOptionCoverError(opt: PhotoResolutionOption) {
  if (!opt.coverFallbackUrls || opt.coverFallbackUrls.length === 0) {
    opt.coverFallbackUrls = imageUtil.buildCoverCandidates(opt.isbn13, [opt.coverUrl]);
  }
  imageUtil.advanceCoverFallback(opt);
  if (!opt.coverUrl) {
    exhaustedOptionCovers.value = { ...exhaustedOptionCovers.value, [opt.isbn13]: true };
  }
}

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

const skipNextEmptyIsbnClick = ref(false);
const openedScannerFromIsbnClick = ref(false);

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
    localPublisher.value = props.item.publisher || props.item.rawCandidate.publisher || '';
    localIsbn.value = props.item.isbn13 || props.item.rawCandidate.isbn || '';
    localIsIntegral.value = Boolean(props.item.isIntegral);
    localIncludedVolumesText.value = props.item.includedVolumeNumbers?.length
      ? props.item.includedVolumeNumbers.join(', ')
      : '';
    localSelected.value = Boolean(props.item.selected);
    showManualForm.value = props.item.status === 'unresolved' || (props.item.alternatives?.length || 0) === 0;
    zoomedImageUrl.value = null;
    resetZoomTransform();
    exhaustedOptionCovers.value = {};
    skipNextEmptyIsbnClick.value = false;
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
  resetZoomTransform();
  zoomedImageUrl.value = url;
  zoomedImageAlt.value = alt;
};

const closeZoom = () => {
  zoomedImageUrl.value = null;
  resetZoomTransform();
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

watch(
  () => scannerState.isScanning.value,
  (scanning, wasScanning) => {
    if (wasScanning && !scanning && openedScannerFromIsbnClick.value) {
      openedScannerFromIsbnClick.value = false;
      if (!localIsbn.value.trim()) {
        // L'utilisateur a refermé la caméra sans scanner : éviter de rouvrir en boucle s'il veut saisir au clavier
        skipNextEmptyIsbnClick.value = true;
      }
    }
  }
);

const clearAllManualFields = () => {
  localTitle.value = '';
  localSeries.value = '';
  localVolume.value = '';
  localAuthor.value = '';
  localPublisher.value = '';
  localIsbn.value = '';
  skipNextEmptyIsbnClick.value = false;
};

const clearIsbnField = () => {
  localIsbn.value = '';
  skipNextEmptyIsbnClick.value = false;
};

const openManualIsbnScanner = () => {
  openedScannerFromIsbnClick.value = true;
  skipNextEmptyIsbnClick.value = false;
  scannerState.openIsbnPickerModal((isbn: string) => {
    openedScannerFromIsbnClick.value = false;
    localIsbn.value = isbn;
    handleSearchBnf();
  });
};

const handleIsbnInputClick = () => {
  if (!localIsbn.value.trim() && !skipNextEmptyIsbnClick.value) {
    openManualIsbnScanner();
  }
};

const handleOptionTap = (opt: PhotoResolutionOption | null) => {
  emit('select-option', opt);
  if (opt) {
    localTitle.value = opt.title || localTitle.value;
    localSeries.value = opt.series || localSeries.value;
    localVolume.value = opt.seriesNumber || '';
    if (opt.publisher) localPublisher.value = opt.publisher;
    localIsIntegral.value = Boolean(opt.isIntegral);
    if ((opt as any).includedVolumeNumbers?.length) {
      localIncludedVolumesText.value = (opt as any).includedVolumeNumbers.join(', ');
    }
    localSelected.value = true;
  } else {
    localSelected.value = false;
  }
  commitFieldChanges();
};

const handleSearchBnf = () => {
  if (!props.item) return;
  emit('retry-bnf', {
    ...props.item.rawCandidate,
    title: localTitle.value.trim(),
    series: localSeries.value.trim() || undefined,
    volumeNumber: localVolume.value.trim() || undefined,
    author: localAuthor.value.trim() || undefined,
    publisher: localPublisher.value.trim() || undefined,
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
                  :src="imageUtil.resolveExternalUrl(item.coverUrl, item.isbn13)"
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
                  v-if="resolveOptionCoverSrc(opt)"
                  :src="resolveOptionCoverSrc(opt)"
                  :alt="opt.title"
                  class="alt-cover"
                  @error="onOptionCoverError(opt)"
                />
                <div v-else class="alt-cover alt-cover-empty" :title="opt.title">
                  <span>{{ (opt.title || 'BD').slice(0, 10) }}</span>
                </div>
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
            <div class="manual-header-row">
              <button type="button" class="link-toggle-btn" @click="showManualForm = !showManualForm">
                {{ showManualForm ? '▾ Masquer la recherche manuelle BnF' : '▸ Corriger titre / série / ISBN et relancer la BnF' }}
              </button>
              <button
                v-if="showManualForm"
                type="button"
                class="manual-clear-all-btn"
                title="Effacer tous les champs de recherche"
                @click="clearAllManualFields"
              >
                Tout effacer
              </button>
            </div>

            <div v-if="showManualForm" class="manual-grid">
              <div class="manual-field">
                <label class="manual-field-label" for="manual-title-input">Titre du livre</label>
                <div class="input-with-actions">
                  <input
                    id="manual-title-input"
                    v-model="localTitle"
                    placeholder="Ex : Le Lotus bleu"
                    class="cand-input cand-input--has-clear"
                  />
                  <button
                    v-if="localTitle"
                    type="button"
                    class="field-icon-btn"
                    title="Effacer le titre"
                    aria-label="Effacer le titre"
                    @click="localTitle = ''"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div class="manual-two-col">
                <div class="manual-field">
                  <label class="manual-field-label" for="manual-series-input">Nom de la série</label>
                  <div class="input-with-actions">
                    <input
                      id="manual-series-input"
                      v-model="localSeries"
                      placeholder="Ex : Les Aventures de Tintin"
                      class="cand-input cand-input--has-clear"
                    />
                    <button
                      v-if="localSeries"
                      type="button"
                      class="field-icon-btn"
                      title="Effacer la série"
                      aria-label="Effacer la série"
                      @click="localSeries = ''"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div class="manual-field">
                  <label class="manual-field-label" for="manual-volume-input">N° de tome</label>
                  <div class="input-with-actions">
                    <input
                      id="manual-volume-input"
                      v-model="localVolume"
                      placeholder="Ex : 5"
                      class="cand-input cand-input--has-clear"
                    />
                    <button
                      v-if="localVolume"
                      type="button"
                      class="field-icon-btn"
                      title="Effacer le n° de tome"
                      aria-label="Effacer le n° de tome"
                      @click="localVolume = ''"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
              <div class="manual-two-col">
                <div class="manual-field">
                  <label class="manual-field-label" for="manual-author-input">Auteur</label>
                  <div class="input-with-actions">
                    <input
                      id="manual-author-input"
                      v-model="localAuthor"
                      placeholder="Ex : Hergé"
                      class="cand-input cand-input--has-clear"
                    />
                    <button
                      v-if="localAuthor"
                      type="button"
                      class="field-icon-btn"
                      title="Effacer l'auteur"
                      aria-label="Effacer l'auteur"
                      @click="localAuthor = ''"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div class="manual-field">
                  <label class="manual-field-label" for="manual-publisher-input">Éditeur (optionnel)</label>
                  <div class="input-with-actions">
                    <input
                      id="manual-publisher-input"
                      v-model="localPublisher"
                      placeholder="Ex : Dargaud, Dupuis, Folio..."
                      class="cand-input cand-input--has-clear"
                    />
                    <button
                      v-if="localPublisher"
                      type="button"
                      class="field-icon-btn"
                      title="Effacer l'éditeur"
                      aria-label="Effacer l'éditeur"
                      @click="localPublisher = ''"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
              <div class="manual-field">
                <label class="manual-field-label" for="manual-isbn-input">ISBN-13 (optionnel)</label>
                <div class="input-with-actions">
                  <input
                    id="manual-isbn-input"
                    v-model="localIsbn"
                    :placeholder="!localIsbn && !skipNextEmptyIsbnClick ? 'Cliquer pour scanner...' : '9782...'"
                    class="cand-input cand-input--isbn"
                    @click="handleIsbnInputClick"
                  />
                  <button
                    v-if="localIsbn"
                    type="button"
                    class="field-icon-btn"
                    title="Effacer l'ISBN"
                    aria-label="Effacer l'ISBN"
                    @click="clearIsbnField"
                  >
                    ✕
                  </button>
                  <button
                    type="button"
                    class="field-icon-btn field-icon-btn--scan"
                    title="Scanner le code-barres ISBN"
                    aria-label="Scanner le code-barres ISBN"
                    @click="openManualIsbnScanner"
                  >
                    📷
                  </button>
                </div>
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

    <!-- Lightbox zoom plein écran interactif (pinch, molette, boutons +/-, glisser-déplacer) -->
    <div
      v-if="zoomedImageUrl"
      class="zoom-lightbox"
      @click.self="closeZoom"
      @wheel.prevent="onZoomWheel"
      @touchstart="onZoomTouchStart"
      @touchmove="onZoomTouchMove"
      @touchend="onZoomTouchEnd"
    >
      <div class="zoom-toolbar" @click.stop>
        <div class="zoom-controls-group">
          <button type="button" class="zoom-tool-btn" aria-label="Dézoomer" :disabled="zoomScale <= 1" @click="adjustZoom(-0.5)">−</button>
          <button type="button" class="zoom-tool-btn zoom-pct-btn" title="Réinitialiser le zoom" @click="resetZoomTransform">
            {{ Math.round(zoomScale * 100) }}%
          </button>
          <button type="button" class="zoom-tool-btn" aria-label="Zoomer" :disabled="zoomScale >= 4.5" @click="adjustZoom(0.5)">+</button>
        </div>
        <button type="button" class="zoom-close-btn" @click="closeZoom">✕ Fermer</button>
      </div>
      <div
        class="zoom-stage"
        :class="{ 'is-zoomed': zoomScale > 1, 'is-dragging': isDraggingZoom }"
        @pointerdown="onZoomPointerDown"
        @pointermove="onZoomPointerMove"
        @pointerup="onZoomPointerUp"
        @pointercancel="onZoomPointerUp"
        @dblclick.stop="toggleDoubleTapZoom"
      >
        <img
          :src="zoomedImageUrl"
          :alt="zoomedImageAlt"
          class="zoom-lightbox-img"
          draggable="false"
          :style="{
            transform: `translate3d(${panX}px, ${panY}px, 0) scale(${zoomScale})`
          }"
          @click.stop
        />
      </div>
      <div class="zoom-help-hint">
        Pincez à 2 doigts, utilisez la molette ou + / − pour zoomer • Double-clic pour agrandir
      </div>
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
  background: rgba(2, 6, 23, 0.94);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  touch-action: none;
  user-select: none;
}

.zoom-toolbar {
  width: 100%;
  max-width: 960px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  z-index: 2;
}

.zoom-controls-group {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: rgba(255, 255, 255, 0.12);
  padding: 0.25rem;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.22);
}

.zoom-tool-btn {
  min-width: 36px;
  height: 36px;
  padding: 0 0.6rem;
  border-radius: 999px;
  border: none;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-weight: 700;
  font-size: 1rem;
  cursor: pointer;
}

.zoom-tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.zoom-pct-btn {
  font-size: 0.82rem;
  min-width: 56px;
  background: transparent;
}

.zoom-close-btn {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  padding: 0.45rem 0.9rem;
  font-weight: 700;
  font-size: 0.88rem;
  cursor: pointer;
}

.zoom-stage {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: zoom-in;
}

.zoom-stage.is-zoomed {
  cursor: grab;
}

.zoom-stage.is-dragging {
  cursor: grabbing;
}

.zoom-lightbox-img {
  max-width: 96vw;
  max-height: 78dvh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
  transform-origin: center center;
  transition: transform 0.08s ease-out;
  will-change: transform;
}

.zoom-stage.is-dragging .zoom-lightbox-img {
  transition: none;
}

.zoom-help-hint {
  color: rgba(226, 232, 240, 0.85);
  font-size: 0.76rem;
  text-align: center;
  padding-top: 0.35rem;
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
  text-align: center;
  padding: 0.2rem;
  background: linear-gradient(135deg, #e2e8f0, #cbd5e1);
  color: #334155;
  font-weight: 700;
  font-size: 0.62rem;
  line-height: 1.15;
  overflow: hidden;
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

.manual-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.manual-clear-all-btn {
  border: 1px solid #cbd5e1;
  background: #f8fafc;
  color: #475569;
  font-size: 0.74rem;
  font-weight: 700;
  padding: 0.22rem 0.55rem;
  border-radius: 6px;
  cursor: pointer;
}

.manual-clear-all-btn:hover {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #b91c1c;
}

.manual-grid {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.manual-field {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
}

.manual-field-label {
  font-size: 0.76rem;
  font-weight: 700;
  color: #334155;
}

.manual-two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.input-with-actions {
  position: relative;
  display: flex;
  align-items: center;
}

.cand-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.65rem;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  font-size: 0.88rem;
}

.cand-input--has-clear {
  padding-right: 1.95rem;
}

.cand-input--isbn {
  padding-right: 3.45rem;
}

.field-icon-btn {
  position: absolute;
  right: 0.35rem;
  width: 24px;
  height: 24px;
  border: none;
  background: #e2e8f0;
  color: #475569;
  border-radius: 50%;
  font-size: 0.72rem;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  line-height: 1;
}

.field-icon-btn:hover {
  background: #cbd5e1;
  color: #0f172a;
}

.field-icon-btn--scan {
  background: #dbeafe;
  color: #1d4ed8;
  border-radius: 6px;
  font-size: 0.82rem;
}

.input-with-actions .field-icon-btn + .field-icon-btn--scan {
  right: 0.35rem;
}

.input-with-actions:has(.field-icon-btn--scan) .field-icon-btn:not(.field-icon-btn--scan) {
  right: 2.05rem;
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
