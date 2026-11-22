<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import { databaseService } from '../../core/database/database.service';
import { fetchWithTimeout } from '../../state/connection';
import { sessionStore } from '../../state/session';
import { scannerState } from '../../state/scanner';
import { useModalScrollable } from '../composables/useModalScrollable';

function stripLeadingArticlesForSort(name: string): string {
  return name
    .trim()
    .replace(/^(?:les|la|le|un|une|des|du|de|the|an|a)\s+/i, '')
    .replace(/^l['’]\s*/i, '')
    .trim()
    .toLowerCase();
}

const props = defineProps<{
  show: boolean;
  bookUris: string[];
  currentSeriesId?: string;
  currentSeriesTitle?: string;
  initialVolumeLabel?: string;
  singleBook?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'merged', payload: { seriesId: string; seriesTitle: string }): void;
}>();

const existingSeries = ref<Array<{ id: string; name: string; count: number }>>([]);
const selectedSeriesId = ref<string>('');
const seriesSearchQuery = ref<string>('');
const customNewSeriesTitle = ref<string>('');

const filteredSeries = computed(() => {
  const q = seriesSearchQuery.value.trim().toLowerCase();
  if (!q) return existingSeries.value;
  return existingSeries.value.filter((s) => s.name.toLowerCase().includes(q));
});
const volumeType = ref<'standard' | 'hors_serie' | 'integrale' | 'unnumbered'>('standard');
const volumeLabelInput = ref<string>(props.initialVolumeLabel || '');
const sortOrderInput = ref<number>(100);
const mergeEntireSourceSeries = ref<boolean>(Boolean(props.currentSeriesId));
const isSaving = ref(false);
const errorMsg = ref('');
const modalCardRef = ref<HTMLElement | null>(null);
const { isScrollable } = useModalScrollable(modalCardRef, () => [props.show, selectedSeriesId.value, volumeType.value]);

onMounted(async () => {
  await loadLocalSeries();
});

watch(
  () => props.show,
  async (visible) => {
    if (visible) {
      errorMsg.value = '';
      volumeLabelInput.value = props.initialVolumeLabel || '';
      mergeEntireSourceSeries.value = Boolean(props.currentSeriesId) && props.singleBook !== true;
      await loadLocalSeries();
    }
  }
);

async function loadLocalSeries() {
  const allBooks = await databaseService.getAllCachedBooks();
  const map = new Map<string, { id: string; name: string; count: number }>();
  for (const b of allBooks) {
    if (b.seriesId && b.series) {
      const existing = map.get(b.seriesId);
      if (existing) {
        existing.count++;
      } else {
        map.set(b.seriesId, { id: b.seriesId, name: b.series, count: 1 });
      }
    }
  }
  existingSeries.value = Array.from(map.values()).sort((a, b) =>
    stripLeadingArticlesForSort(a.name).localeCompare(stripLeadingArticlesForSort(b.name), 'fr')
  );
}

async function handleConfirmMerge() {
  errorMsg.value = '';
  const targetId = selectedSeriesId.value === '__NEW__' ? '' : selectedSeriesId.value;
  const targetTitle =
    selectedSeriesId.value === '__NEW__'
      ? customNewSeriesTitle.value.trim()
      : existingSeries.value.find((s) => s.id === targetId)?.name || '';

  if (!targetId && !targetTitle) {
    errorMsg.value = 'Veuillez choisir une série existante ou saisir le nom de la série cible.';
    return;
  }

  isSaving.value = true;
  try {
    let finalVolLabel = volumeLabelInput.value.trim();
    if (volumeType.value === 'hors_serie' && !finalVolLabel) {
      finalVolLabel = 'HS';
    } else if (volumeType.value === 'integrale' && !finalVolLabel) {
      finalVolLabel = 'Intégrale';
    } else if (volumeType.value === 'unnumbered') {
      finalVolLabel = '';
    }

    const allowVolEdit = props.singleBook === true || props.bookUris.length === 1;
    const savedUserUri = sessionStore.getUserUri() || undefined;
    const res = await fetchWithTimeout('/api/gateway?action=series-merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userUri: savedUserUri,
        targetSeriesId: targetId || undefined,
        targetSeriesTitle: targetTitle || undefined,
        sourceSeriesId:
          mergeEntireSourceSeries.value && props.currentSeriesId
            ? props.currentSeriesId
            : undefined,
        bookUris: props.bookUris,
        volumeLabel: allowVolEdit ? finalVolLabel : undefined,
        sortOrder:
          allowVolEdit && (volumeType.value === 'hors_serie' || volumeType.value === 'unnumbered')
            ? sortOrderInput.value
            : undefined
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Erreur lors du regroupement sur le serveur.');
    }
    const finalSeriesId = data.seriesId || targetId || `inv:serie:${Date.now()}`;
    const finalSeriesName = data.seriesTitle || targetTitle;

    // Mise à jour immédiate du cache local Dexie pour réactivité instantanée
    const allCached = await databaseService.getAllCachedBooks();
    for (const b of allCached) {
      const isTargetBook =
        props.bookUris.includes(b.uri) ||
        (b.workUri && props.bookUris.includes(b.workUri)) ||
        (mergeEntireSourceSeries.value &&
          props.currentSeriesId &&
          b.seriesId === props.currentSeriesId);

      if (isTargetBook) {
        b.seriesId = finalSeriesId;
        b.series = finalSeriesName;
        if (props.bookUris.length === 1) {
          b.seriesNumber = finalVolLabel || undefined;
        }
        if (Array.isArray(b.hiddenSeriesIds)) {
          b.hiddenSeriesIds = b.hiddenSeriesIds.filter((sid) => sid !== finalSeriesId);
        }
        b.isLocallyEdited = true;
        await databaseService.saveBookToCache(JSON.parse(JSON.stringify(b)));
      }
    }

    scannerState.notifyCatalogChanged();
    emit('merged', { seriesId: finalSeriesId, seriesTitle: finalSeriesName });
    emit('close');
  } catch (err: unknown) {
    errorMsg.value = err instanceof Error ? err.message : 'Erreur lors du regroupement.';
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-backdrop" @click.self="emit('close')">
    <div ref="modalCardRef" class="modal-card" role="dialog" aria-modal="true" aria-label="Rattacher ou Fusionner dans une Série">
      <div class="modal-header">
        <h3>Rattacher ou Fusionner dans une Série</h3>
        <button type="button" class="close-btn" @click="emit('close')">✕</button>
      </div>

      <p class="modal-desc">
        Réunissez facilement des livres mal classés, des <strong>Hors-Séries (sans numéro)</strong> ou deux séries en doublon.
      </p>

      <div class="form-group">
        <label>1. Série de destination :</label>
        <input
          v-model="seriesSearchQuery"
          type="search"
          class="input-control"
          placeholder="Filtrer vos séries..."
        />
        <div class="series-picker-list" role="listbox" aria-label="Séries disponibles">
          <button
            v-for="s in filteredSeries"
            :key="s.id"
            type="button"
            role="option"
            :aria-selected="selectedSeriesId === s.id"
            :class="['series-picker-option', { selected: selectedSeriesId === s.id }]"
            @click="selectedSeriesId = s.id"
          >
            <span>{{ s.name }}</span>
            <span class="series-picker-count">{{ s.count }} tome(s)</span>
          </button>
          <button
            type="button"
            role="option"
            :aria-selected="selectedSeriesId === '__NEW__'"
            :class="['series-picker-option new-series-opt', { selected: selectedSeriesId === '__NEW__' }]"
            @click="selectedSeriesId = '__NEW__'"
          >
            + Créer / Saisir un nouveau nom de série...
          </button>
        </div>
      </div>

      <div v-if="selectedSeriesId === '__NEW__'" class="form-group">
        <label>Nom de la série :</label>
        <input
          v-model="customNewSeriesTitle"
          placeholder="Ex: Astérix, Blacksad, Dune..."
          class="input-control"
        />
      </div>

      <div v-if="currentSeriesId" class="checkbox-row">
        <input id="merge-all" type="checkbox" v-model="mergeEntireSourceSeries" />
        <label for="merge-all">
          Fusionner tous les tomes de "{{ currentSeriesTitle || 'cette série' }}" dans la série cible
        </label>
      </div>

      <div v-if="singleBook !== false && bookUris.length === 1" class="form-group">
        <label>2. Type de tome dans la série :</label>
        <select v-model="volumeType" class="input-control">
          <option value="standard">Tome numéroté classique (T.1, T.2...)</option>
          <option value="hors_serie">Hors-Série / Spin-off (HS, HS 1...)</option>
          <option value="integrale">Intégrale / Coffret</option>
          <option value="unnumbered">Sans numéro de tome</option>
        </select>

        <div v-if="volumeType !== 'unnumbered'" class="sub-fields">
          <input
            v-model="volumeLabelInput"
            placeholder="Numéro ou mention (ex: 4, HS 1, Intégrale 1-3)"
            class="input-control"
          />
        </div>

        <div v-if="volumeType === 'hors_serie' || volumeType === 'unnumbered'" class="sub-fields">
          <label class="small-label">
            Position de tri dans la série (ex: 0 pour un préquel, 2.5 après le tome 2, 999 à la fin) :
          </label>
          <input v-model.number="sortOrderInput" type="number" step="0.5" class="input-control" />
        </div>
      </div>

      <div v-if="errorMsg" class="err-box">{{ errorMsg }}</div>

      <div class="modal-actions">
        <button type="button" class="btn outline" @click="emit('close')">Annuler</button>
        <button
          type="button"
          class="btn primary"
          :disabled="isSaving"
          @click="handleConfirmMerge"
        >
          {{ isSaving ? 'Regroupement...' : 'Appliquer le rattachement' }}
        </button>
      </div>
      <div v-if="isScrollable" class="modal-bottom-close-bar">
        <button type="button" class="close-btn" aria-label="Fermer" @click="emit('close')">✕</button>
      </div>
    </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  width: 100%;
  min-block-size: 100dvh;
  background: rgba(15, 23, 42, 0.58);
  backdrop-filter: blur(4px);
  z-index: var(--z-modal, 2000);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  box-sizing: border-box;
}

.modal-card {
  inline-size: 100%;
  max-inline-size: 480px;
  max-block-size: 92dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-main, #0f172a);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-modal, 0 20px 25px -5px rgba(15, 23, 42, 0.16));
  padding: 1.35rem;
  font-family: var(--font-main);
  box-sizing: border-box;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.modal-header h3 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.25;
  text-wrap: balance;
}

.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 34px;
  min-block-size: 34px;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  background: var(--color-bg-alt, #f8fafc);
  color: var(--color-text-main, #0f172a);
  font-weight: 600;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.close-btn:hover {
  background: #e2e8f0;
}

.modal-desc {
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--color-text-muted, #64748b);
  margin: 0 0 0.9rem;
  text-wrap: pretty;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 0.85rem;
  font-size: 0.875rem;
  font-weight: 600;
}

.input-control {
  min-block-size: 40px;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.45rem 0.7rem;
  font-size: 0.875rem;
  font-family: inherit;
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-main, #0f172a);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.input-control:focus {
  outline: none;
  border-color: var(--color-primary, #4f46e5);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15);
}

.sub-fields {
  margin-top: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.small-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-text-muted, #64748b);
  line-height: 1.4;
}

.checkbox-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.84rem;
  line-height: 1.4;
  margin-bottom: 0.85rem;
}

.modal-actions {
  display: flex;
  flex-direction: row !important;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 0.95rem;
}

.btn {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  min-block-size: 40px;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.btn.primary {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #ffffff;
}

.btn.primary:hover:not(:disabled) {
  background: var(--color-primary-hover, #4338ca);
}

.btn.outline {
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-main, #0f172a);
}

.btn.outline:hover {
  background: var(--color-bg-alt, #f8fafc);
}

.err-box {
  background: #fef2f2;
  color: #b91c1c;
  border: 1px solid #fecaca;
  border-radius: var(--radius-sm, 8px);
  padding: 0.55rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
}

.series-picker-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-block-size: 210px;
  overflow-y: auto;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.3rem;
  background: var(--color-bg-alt, #f8fafc);
}

.series-picker-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  text-align: left;
  width: 100%;
  padding: 0.45rem 0.65rem;
  border: 1px solid transparent;
  border-radius: 6px;
  background: #ffffff;
  color: var(--color-text-main, #0f172a);
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
}

.series-picker-option:hover {
  background: #eef2ff;
}

.series-picker-option.selected {
  background: var(--color-primary, #4f46e5);
  color: #ffffff;
}

.series-picker-option.selected .series-picker-count {
  color: #e0e7ff;
}

.series-picker-count {
  font-size: 0.76rem;
  font-weight: 500;
  color: #64748b;
  white-space: nowrap;
}

.new-series-opt {
  color: var(--color-primary, #4f46e5);
  border-style: dashed;
  border-color: #c7d2fe;
}
</style>
