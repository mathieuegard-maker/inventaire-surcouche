<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { databaseService } from '../../core/database/database.service';
import { fetchWithTimeout } from '../../state/connection';

const props = defineProps<{
  show: boolean;
  bookUris: string[];
  currentSeriesId?: string;
  currentSeriesTitle?: string;
  initialVolumeLabel?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'merged', payload: { seriesId: string; seriesTitle: string }): void;
}>();

const existingSeries = ref<Array<{ id: string; name: string; count: number }>>([]);
const selectedSeriesId = ref<string>('');
const customNewSeriesTitle = ref<string>('');
const volumeType = ref<'standard' | 'hors_serie' | 'integrale' | 'unnumbered'>('standard');
const volumeLabelInput = ref<string>(props.initialVolumeLabel || '');
const sortOrderInput = ref<number>(100);
const mergeEntireSourceSeries = ref<boolean>(Boolean(props.currentSeriesId));
const isSaving = ref(false);
const errorMsg = ref('');

onMounted(async () => {
  await loadLocalSeries();
});

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
    a.name.localeCompare(b.name, 'fr')
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

    const res = await fetchWithTimeout('/api/gateway?action=series-merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSeriesId: targetId || undefined,
        targetSeriesTitle: targetTitle || undefined,
        sourceSeriesId:
          mergeEntireSourceSeries.value && props.currentSeriesId
            ? props.currentSeriesId
            : undefined,
        bookUris: props.bookUris,
        volumeLabel: props.bookUris.length === 1 ? finalVolLabel : undefined,
        sortOrder:
          volumeType.value === 'hors_serie' || volumeType.value === 'unnumbered'
            ? sortOrderInput.value
            : undefined
      })
    });

    const data = await res.json();
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
        b.isLocallyEdited = true;
        await databaseService.saveBookToCache(b);
      }
    }

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
  <div v-if="show" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card">
      <div class="modal-header">
        <h3>🔗 Rattacher ou Fusionner dans une Série</h3>
        <button type="button" class="close-btn" @click="emit('close')">✕</button>
      </div>

      <p class="modal-desc">
        Réunissez facilement des livres mal classés, des <strong>Hors-Séries (sans numéro)</strong> ou deux séries en doublon.
      </p>

      <div class="form-group">
        <label>1. Série de destination :</label>
        <select v-model="selectedSeriesId" class="input-control">
          <option value="">-- Choisir une série de votre collection --</option>
          <option v-for="s in existingSeries" :key="s.id" :value="s.id">
            {{ s.name }} ({{ s.count }} tome(s))
          </option>
          <option value="__NEW__">+ Créer / Saisir un nouveau nom de série...</option>
        </select>
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

      <div v-if="bookUris.length === 1" class="form-group">
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
          {{ isSaving ? 'Regroupement...' : '✅ Appliquer le rattachement' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.75);
  z-index: 9500;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 1rem;
}

.modal-card {
  width: 100%;
  max-width: 480px;
  background: #fff;
  border: 2px solid #000;
  box-shadow: 6px 6px 0 #000;
  padding: 1.1rem;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.modal-header h3 {
  margin: 0;
  font-size: 1rem;
}

.close-btn {
  border: 2px solid #000;
  background: #f1f5f9;
  font-weight: 700;
  cursor: pointer;
  padding: 0.2rem 0.5rem;
}

.modal-desc {
  font-size: 0.82rem;
  color: #475569;
  margin-top: 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
  font-size: 0.85rem;
  font-weight: 700;
}

.input-control {
  border: 2px solid #000;
  padding: 0.45rem;
  font-size: 0.85rem;
}

.sub-fields {
  margin-top: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.small-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: #475569;
}

.checkbox-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.82rem;
  margin-bottom: 0.75rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.85rem;
}

.btn {
  border: 2px solid #000;
  padding: 0.5rem 0.85rem;
  font-weight: 700;
  cursor: pointer;
}

.btn.primary {
  background: #4f46e5;
  color: #fff;
}

.btn.outline {
  background: #fff;
}

.err-box {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #b91c1c;
  padding: 0.45rem;
  font-size: 0.8rem;
  font-weight: 700;
}
</style>
