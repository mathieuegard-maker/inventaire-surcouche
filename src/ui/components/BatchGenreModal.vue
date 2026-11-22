<script setup lang="ts">
import { ref, watch } from 'vue';
import { databaseService } from '../../core/database/database.service';
import { userService } from '../../core/services/user.service';
import { SUGGESTED_GENRE_CHIPS } from '../../core/utils/category-classifier.util';
import { scannerState } from '../../state/scanner';

const props = defineProps<{
  show: boolean;
  bookUris: string[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'applied', payload: { genres: string[]; count: number }): void;
}>();

const availableGenres = ref<string[]>([...SUGGESTED_GENRE_CHIPS]);
const selectedGenres = ref<string[]>([]);
const customGenre = ref('');
const saving = ref(false);
const errorMsg = ref('');

watch(
  () => props.show,
  async (visible) => {
    if (!visible) return;
    selectedGenres.value = [];
    customGenre.value = '';
    errorMsg.value = '';
    const res = await userService.fetchDefaultGenres().catch(() => null);
    if (res?.genres?.length) {
      availableGenres.value = res.genres;
    }
  }
);

const toggleGenre = (g: string) => {
  const idx = selectedGenres.value.findIndex((x) => x.toLowerCase() === g.toLowerCase());
  if (idx >= 0) {
    selectedGenres.value = selectedGenres.value.filter((_, i) => i !== idx);
  } else {
    selectedGenres.value = [...selectedGenres.value, g];
  }
};

const isSelected = (g: string) =>
  selectedGenres.value.some((x) => x.toLowerCase() === g.toLowerCase());

const addCustom = (alsoDefault: boolean) => {
  const clean = customGenre.value.trim();
  if (!clean) return;
  if (!isSelected(clean)) {
    selectedGenres.value = [...selectedGenres.value, clean];
  }
  if (alsoDefault) {
    void userService.updateDefaultGenres('add', clean).then((res) => {
      if (res.genres.length > 0) availableGenres.value = res.genres;
    }).catch(() => {});
  }
  customGenre.value = '';
};

const handleApply = async () => {
  if (selectedGenres.value.length === 0 || props.bookUris.length === 0 || saving.value) return;
  saving.value = true;
  errorMsg.value = '';
  try {
    // 1. Mise à jour serveur Option B (cumulatif, isolé au foyer)
    await userService.addGenresToBooksBatch(props.bookUris, selectedGenres.value).catch(() => {});

    // 2. Mise à jour locale IndexedDB (cumulatif, sans écraser les genres existants)
    for (const uri of props.bookUris) {
      const book = await databaseService.getBookFromCache(uri).catch(() => null);
      if (!book) continue;
      const merged = [...(book.genres || [])];
      for (const g of selectedGenres.value) {
        if (!merged.some((e) => e.trim().toLowerCase() === g.toLowerCase())) {
          merged.push(g);
        }
      }
      book.genres = merged;
      book.isLocallyEdited = true;
      await databaseService.saveBookToCache(JSON.parse(JSON.stringify(book)));
    }

    scannerState.notifyCatalogChanged();
    emit('applied', { genres: [...selectedGenres.value], count: props.bookUris.length });
    emit('close');
  } catch (e: unknown) {
    errorMsg.value = e instanceof Error ? e.message : "Impossible d'appliquer les genres.";
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="emit('close')">
      <div class="modal-box batch-genre-modal" role="dialog" aria-modal="true" aria-label="Ajouter un genre en lot">
        <h2>Ajouter un genre ({{ bookUris.length }} livre(s))</h2>
        <p class="modal-text">
          Les genres choisis seront <strong>ajoutés en complément</strong> sans écraser les genres déjà présents, uniquement pour votre foyer.
        </p>

        <div class="batch-genre-grid">
          <button
            v-for="chip in availableGenres"
            :key="chip"
            type="button"
            class="batch-genre-chip"
            :class="{ active: isSelected(chip) }"
            @click="toggleGenre(chip)"
          >
            {{ isSelected(chip) ? '✓ ' : '+ ' }}{{ chip }}
          </button>
        </div>

        <div class="batch-genre-custom-row">
          <input
            v-model="customGenre"
            type="text"
            class="ds-input"
            placeholder="Autre genre personnalisé..."
            @keydown.enter.prevent="addCustom(false)"
          />
          <button
            type="button"
            class="wireframe-btn batch-genre-mini-btn"
            :disabled="!customGenre.trim()"
            @click="addCustom(false)"
          >
            + Lot
          </button>
          <button
            type="button"
            class="wireframe-btn batch-genre-mini-btn default-btn"
            :disabled="!customGenre.trim()"
            @click="addCustom(true)"
          >
            + Par défaut
          </button>
        </div>

        <p v-if="errorMsg" class="batch-genre-err">{{ errorMsg }}</p>

        <div class="modal-actions">
          <button
            type="button"
            class="btn-action"
            :disabled="saving || selectedGenres.length === 0"
            @click="handleApply"
          >
            {{ saving ? 'Application...' : `Appliquer (${selectedGenres.length})` }}
          </button>
          <button type="button" class="btn-close" :disabled="saving" @click="emit('close')">
            Annuler
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.batch-genre-modal {
  max-width: 520px;
}

.batch-genre-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.5rem;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 10px;
  background: var(--color-bg-alt, #f8fafc);
}

.batch-genre-chip {
  background: #fff;
  color: var(--color-text-main, #0f172a);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 999px;
  padding: 0.25rem 0.6rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.batch-genre-chip.active {
  background: #dcfce7;
  color: #166534;
  border-color: #86efac;
}

.batch-genre-custom-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}

.batch-genre-custom-row .ds-input {
  flex: 1 1 180px;
}

.batch-genre-mini-btn {
  width: auto !important;
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
  white-space: nowrap;
}

.batch-genre-mini-btn.default-btn {
  background: #eef2ff;
  border-color: #c7d2fe;
  color: #3730a3;
}

.batch-genre-err {
  margin: 0;
  color: #b91c1c;
  font-size: 0.84rem;
  font-weight: 600;
}
</style>
