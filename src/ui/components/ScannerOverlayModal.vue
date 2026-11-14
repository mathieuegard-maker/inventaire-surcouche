<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { scannerState } from '../../state/scanner';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import {
  byokVisionService,
  type ByokProvider,
  type RecognizedBookCandidate
} from '../../core/services/byok-vision.service';

const router = useRouter();

const checkRes = computed(() => scannerState.lastCheckResult.value);
const activeMode = computed(() => scannerState.activeMode.value);
const burstTarget = computed({
  get: () => scannerState.burstTarget.value,
  set: (v) => {
    scannerState.burstTarget.value = v;
  }
});

// Calcul des tomes manquants dans la série lors du Mode Vérif Magasin
const missingTomesInSeries = computed(() => {
  const s = checkRes.value?.series;
  if (!s || !Array.isArray(s.tomes)) return [];
  return s.tomes
    .filter((t) => t.ownershipStatus !== 'owned')
    .map((t) => (t.seriesNumber ? `T.${t.seriesNumber}` : t.title))
    .slice(0, 8);
});

const checkStatusBanner = computed(() => {
  const r = checkRes.value;
  if (!r) return null;
  if (r.isUnknown) {
    return {
      color: 'neutral',
      badge: 'NOUVEAU LIVRE (ISBN INCONNU)',
      headline: `Vous ne l'avez pas dans votre collection`,
      sub: `ISBN ${r.isbn} — Cliquez ci-dessous pour l'enrichir et l'ajouter automatiquement.`
    };
  }
  if (r.ownership?.isEditionOwned) {
    return {
      color: 'owned',
      badge: '✅ VOUS AVEZ DÉJÀ CE LIVRE !',
      headline: r.mainBook?.title || 'Déjà possédé',
      sub: r.loan?.isLent
        ? `Actuellement prêté à ${r.loan.details?.friendName}`
        : 'Cet ISBN exact est déjà présent dans votre collection.'
    };
  }
  if (r.ownership?.isWorkOwned) {
    return {
      color: 'owned-other',
      badge: '✅ DÉJÀ POSSÉDÉ (AUTRE ÉDITION)',
      headline: r.mainBook?.title || 'Déjà possédé',
      sub: `Vous possédez déjà cette œuvre (${r.ownership.duplicateEdition?.publisher || 'autre édition'}).`
    };
  }
  if (r.ownership?.isWished) {
    return {
      color: 'wish',
      badge: '💙 DANS VOTRE WISHLIST !',
      headline: r.mainBook?.title || 'Dans vos envies',
      sub: 'Ce livre figure dans votre liste d’envies.'
    };
  }
  if (r.series && r.series.ownedCount > 0) {
    return {
      color: 'series-gap',
      badge: '🟠 VOUS NE L’AVEZ PAS (SÉRIE SUIVIE)',
      headline: r.mainBook?.title || 'Tome manquant',
      sub: `Vous avez ${r.series.ownedCount}/${r.series.tomes.length} tomes de "${r.series.name || r.mainBook?.series}".`
    };
  }
  return {
    color: 'not-owned',
    badge: '➕ ABSENT DE VOTRE BIBLIOTHÈQUE',
    headline: r.mainBook?.title || 'Non possédé',
    sub: 'Vous ne possédez pas encore cet ouvrage.'
  };
});

const quickActionFeedback = ref('');

async function quickAddFromCheck(target: 'owned' | 'wish') {
  const r = checkRes.value;
  if (!r) return;

  if (r.isUnknown && r.isbn) {
    await scannerState.stopScan();
    router.push({ name: 'BookCreateUnknown', query: { isbn: r.isbn } });
    return;
  }

  const uri = r.mainBook?.uri;
  if (!uri) return;

  if (target === 'owned') {
    await queueService.enqueueAction('ADD_INVENTORY', uri);
    if (r.ownership) {
      r.ownership.isEditionOwned = true;
      r.ownership.isWorkOwned = true;
    }
    quickActionFeedback.value = 'Ajouté à votre collection ✓';
  } else {
    await queueService.enqueueAction('ADD_WISHLIST', uri);
    if (r.ownership) {
      r.ownership.isWished = true;
    }
    quickActionFeedback.value = 'Ajouté à votre Wishlist ✓';
  }
  setTimeout(() => {
    quickActionFeedback.value = '';
  }, 2500);
}

async function openFullBookFromCheck() {
  const r = checkRes.value;
  if (!r) return;
  await scannerState.stopScan();
  if (r.isUnknown && r.isbn) {
    router.push({ name: 'BookCreateUnknown', query: { isbn: r.isbn } });
  } else if (r.mainBook?.uri) {
    router.push(`/book/${encodeURIComponent(r.mainBook.uri)}`);
  }
}

async function openSeriesFromCheck() {
  const seriesId = checkRes.value?.series?.id || checkRes.value?.mainBook?.seriesId;
  if (!seriesId) return;
  await scannerState.stopScan();
  router.push(`/series/${encodeURIComponent(seriesId)}`);
}

// ============================================================================
// MODE 3 : PHOTO COUVERTURE / ÉTAGÈRE (BYOK + VALIDATION LIVRE PAR LIVRE)
// ============================================================================
const existingByok = byokVisionService.getSettings();
const byokProvider = ref<ByokProvider>(existingByok?.provider || 'gemini');
const byokKey = ref<string>(existingByok?.apiKey || '');
const showByokSetup = ref<boolean>(!existingByok?.apiKey);
const byokTestStatus = ref<{ ok?: boolean; message: string } | null>(null);
const isTestingKey = ref(false);

const isAnalyzingPhoto = ref(false);
const photoError = ref('');
const recognizedCandidates = ref<RecognizedBookCandidate[]>([]);
const photoTargetStatus = ref<'owned' | 'wish'>('owned');
const photoSavingFeedback = ref('');

async function handleSaveAndTestByok() {
  isTestingKey.value = true;
  byokTestStatus.value = null;
  const res = await byokVisionService.testKey({
    provider: byokProvider.value,
    apiKey: byokKey.value
  });
  isTestingKey.value = false;
  byokTestStatus.value = res;
  if (res.ok) {
    byokVisionService.saveSettings({
      provider: byokProvider.value,
      apiKey: byokKey.value
    });
    setTimeout(() => {
      showByokSetup.value = false;
    }, 900);
  }
}

async function handlePhotoSelected(event: Event, mode: 'cover' | 'shelf') {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  photoError.value = '';
  recognizedCandidates.value = [];
  isAnalyzingPhoto.value = true;

  try {
    const candidates = await byokVisionService.analyzePhoto(file, mode);
    if (!candidates.length) {
      photoError.value = "Aucun titre lisible n'a été détecté sur la photo. Réessayez avec plus de lumière.";
    } else {
      recognizedCandidates.value = candidates;
    }
  } catch (err: unknown) {
    photoError.value = err instanceof Error ? err.message : 'Erreur lors de la lecture de la photo.';
  } finally {
    isAnalyzingPhoto.value = false;
    input.value = '';
  }
}

const selectedCandidatesCount = computed(
  () => recognizedCandidates.value.filter((c) => c.selected).length
);

async function confirmAndSaveCandidates() {
  const toSave = recognizedCandidates.value.filter((c) => c.selected && c.title.trim());
  if (!toSave.length) return;

  for (const cand of toSave) {
    const syntheticIsbn = cand.isbn || `PHOTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    await backgroundCreationOrchestrator.enqueueBookCreation({
      tempBook: {
        uri: `local:photo:${syntheticIsbn}`,
        type: 'edition',
        isbn13: cand.isbn,
        title: cand.title.trim(),
        authors: cand.author?.trim() ? [cand.author.trim()] : ['Auteur non précisé'],
        illustrators: [],
        scriptwriters: [],
        publisher: cand.publisher?.trim() || '',
        series: cand.series?.trim() || undefined,
        seriesNumber: cand.volumeNumber?.trim() || undefined,
        genres: [],
        ownershipStatus: photoTargetStatus.value
      },
      expandSeries: false
    });
  }

  photoSavingFeedback.value = `${toSave.length} livre(s) ajouté(s) en tâche de fond ✓`;
  recognizedCandidates.value = [];
  setTimeout(() => {
    photoSavingFeedback.value = '';
  }, 3000);
}
</script>

<template>
  <div v-show="scannerState.isScanningActive.value" class="scanner-modal-backdrop">
    <div class="scanner-modal-card">
      <!-- En-tête + Sélecteur des 3 Modes -->
      <div class="scanner-header">
        <div class="mode-tabs">
          <button
            type="button"
            class="mode-tab"
            :class="{ active: activeMode === 'check' }"
            @click="scannerState.switchMode('check')"
          >
            🏪 Vérif Magasin
          </button>
          <button
            type="button"
            class="mode-tab"
            :class="{ active: activeMode === 'burst' }"
            @click="scannerState.switchMode('burst')"
          >
            ⚡ Mode Rafale
          </button>
          <button
            type="button"
            class="mode-tab"
            :class="{ active: activeMode === 'photo' }"
            @click="scannerState.switchMode('photo')"
          >
            📸 Photo Couv / Étagère
          </button>
        </div>
        <button type="button" class="close-scan-btn" @click="scannerState.stopScan()">
          ✕ Fermer
        </button>
      </div>

      <!-- ================================================================ -->
      <!-- FLUX CAMÉRA CODE-BARRES (Partagé entre Vérif Magasin et Rafale) -->
      <!-- ================================================================ -->
      <div v-show="activeMode !== 'photo' && !checkRes" class="camera-section">
        <div v-if="activeMode === 'burst'" class="burst-toolbar">
          <span class="burst-label">Enregistrer à la volée dans :</span>
          <div class="burst-target-switch">
            <button
              type="button"
              :class="{ active: burstTarget === 'owned' }"
              @click="burstTarget = 'owned'"
            >
              📥 Ma Collection
            </button>
            <button
              type="button"
              :class="{ active: burstTarget === 'wishlist' }"
              @click="burstTarget = 'wishlist'"
            >
              💙 Ma Wishlist
            </button>
          </div>
        </div>

        <div class="scanner-viewport-container">
          <div id="global-barcode-scanner-viewport" class="scanner-viewport"></div>
          <div v-if="!scannerState.isSearching.value" class="scanner-placeholder">
            Ouverture de la caméra...
          </div>
        </div>

        <!-- Toast instantané en Mode Rafale -->
        <div
          v-if="activeMode === 'burst' && scannerState.latestBurstToast.value"
          class="burst-live-toast"
          :class="scannerState.latestBurstToast.value.status"
        >
          <div class="toast-main">
            <strong v-if="scannerState.latestBurstToast.value.status === 'already_owned'">
              ⚠️ Déjà possédé : {{ scannerState.latestBurstToast.value.title }}
            </strong>
            <strong v-else>
              ✓ Enregistré : {{ scannerState.latestBurstToast.value.title }}
              <span v-if="scannerState.latestBurstToast.value.seriesNumber">
                (T.{{ scannerState.latestBurstToast.value.seriesNumber }})
              </span>
            </strong>
            <small>Scannez directement le code-barres suivant sans toucher l'écran</small>
          </div>
          <button
            v-if="scannerState.latestBurstToast.value.status !== 'already_owned'"
            type="button"
            class="undo-btn"
            @click="scannerState.undoBurstEntry(scannerState.latestBurstToast.value!)"
          >
            Annuler
          </button>
        </div>

        <!-- Historique de la session Rafale -->
        <div v-if="activeMode === 'burst' && scannerState.burstHistory.value.length > 0" class="burst-history-box">
          <div class="burst-history-header">
            <strong>Session rafale : {{ scannerState.burstHistory.value.length }} livre(s) scanné(s)</strong>
            <button type="button" class="clear-btn" @click="scannerState.burstHistory.value = []">
              Vider la liste
            </button>
          </div>
          <ul class="burst-list">
            <li v-for="item in scannerState.burstHistory.value.slice(0, 6)" :key="item.timestamp">
              <span>
                {{ item.status === 'already_owned' ? '⚠️' : '✅' }}
                <strong>{{ item.title }}</strong>
                <em v-if="item.series"> — {{ item.series }}</em>
              </span>
              <button
                v-if="item.status !== 'already_owned'"
                type="button"
                class="mini-undo"
                @click="scannerState.undoBurstEntry(item)"
              >
                Retirer
              </button>
            </li>
          </ul>
        </div>
      </div>

      <!-- ================================================================ -->
      <!-- RÉSULTAT INSTANTANÉ MODE VÉRIF MAGASIN (< 1 s)                   -->
      <!-- ================================================================ -->
      <div v-if="activeMode === 'check' && checkRes && checkStatusBanner" class="check-result-box">
        <div class="verdict-banner" :class="checkStatusBanner.color">
          <div class="verdict-badge">{{ checkStatusBanner.badge }}</div>
          <h3 class="verdict-title">{{ checkStatusBanner.headline }}</h3>
          <p class="verdict-sub">{{ checkStatusBanner.sub }}</p>

          <div v-if="missingTomesInSeries.length > 0" class="missing-tomes-pill">
            <strong>Tomes manquants dans cette série :</strong>
            {{ missingTomesInSeries.join(', ') }}
          </div>
        </div>

        <div v-if="quickActionFeedback" class="quick-feedback">
          {{ quickActionFeedback }}
        </div>

        <div class="check-actions-grid">
          <button
            v-if="!checkRes.ownership?.isEditionOwned"
            type="button"
            class="action-btn primary"
            @click="quickAddFromCheck('owned')"
          >
            📥 Ajouter à ma Collection
          </button>
          <button
            v-if="!checkRes.ownership?.isWorkOwned && !checkRes.ownership?.isWished"
            type="button"
            class="action-btn secondary"
            @click="quickAddFromCheck('wish')"
          >
            💙 Ajouter à ma Wishlist
          </button>
          <button
            v-if="checkRes.series?.id || checkRes.mainBook?.seriesId"
            type="button"
            class="action-btn series"
            @click="openSeriesFromCheck"
          >
            📚 Voir / Sélectionner toute la série ({{ checkRes.series?.tomes?.length || '?' }} tomes)
          </button>
          <button type="button" class="action-btn outline" @click="openFullBookFromCheck">
            📄 Ouvrir la fiche complète
          </button>
          <button
            type="button"
            class="action-btn rescan"
            @click="scannerState.resumeCameraInCheckMode()"
          >
            🔄 Scanner un autre code-barres
          </button>
        </div>
      </div>

      <!-- ================================================================ -->
      <!-- MODE 3 : PHOTO COUVERTURE / ÉTAGÈRE (IA BYOK + VALIDATION)      -->
      <!-- ================================================================ -->
      <div v-if="activeMode === 'photo'" class="photo-mode-box">
        <div class="byok-header-bar">
          <span>
            🔑 Reconnaissance IA (0 € serveur) :
            <strong>{{ byokVisionService.getSettings() ? 'Clé active ✓' : 'À configurer' }}</strong>
          </span>
          <button type="button" class="link-btn" @click="showByokSetup = !showByokSetup">
            {{ showByokSetup ? 'Masquer l’assistant clé' : 'Configurer ma clé gratuite' }}
          </button>
        </div>

        <!-- Assistant ultra-simple pour non-technophiles -->
        <div v-if="showByokSetup" class="byok-wizard">
          <h4>Assistant en 3 clics (100 % gratuit, sans carte bancaire)</h4>
          <ol class="wizard-steps">
            <li>
              Cliquez ici pour ouvrir la page officielle :
              <a
                v-if="byokProvider === 'gemini'"
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener"
              >
                Obtenir une clé gratuite Google Gemini (AI Studio) ↗
              </a>
              <a v-else href="https://console.groq.com/keys" target="_blank" rel="noopener">
                Obtenir une clé gratuite Groq ↗
              </a>
            </li>
            <li>Cliquez sur <strong>"Create API Key"</strong> et copiez la clé générée.</li>
            <li>Collez-la ci-dessous (elle reste uniquement sur votre téléphone) :</li>
          </ol>

          <div class="wizard-controls">
            <select v-model="byokProvider" class="provider-select">
              <option value="gemini">Google Gemini Flash (Recommandé)</option>
              <option value="groq">Groq Llama Vision</option>
            </select>
            <input
              v-model="byokKey"
              type="password"
              placeholder="Collez votre clé API ici (ex: AIzaSy...)"
              class="key-input"
            />
            <button
              type="button"
              class="action-btn primary"
              :disabled="isTestingKey || !byokKey.trim()"
              @click="handleSaveAndTestByok"
            >
              {{ isTestingKey ? 'Vérification...' : 'Tester & Enregistrer ma clé' }}
            </button>
          </div>

          <div
            v-if="byokTestStatus"
            class="key-status"
            :class="byokTestStatus.ok ? 'ok' : 'err'"
          >
            {{ byokTestStatus.message }}
          </div>
        </div>

        <!-- Boutons de capture photo -->
        <div class="photo-triggers-grid">
          <label class="photo-trigger-card">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              @change="(e) => handlePhotoSelected(e, 'cover')"
            />
            <span class="trigger-icon">📕</span>
            <strong>Photographier une Couverture</strong>
            <small>Identifie un livre sans code-barres (titre, série, auteur)</small>
          </label>

          <label class="photo-trigger-card">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              @change="(e) => handlePhotoSelected(e, 'shelf')"
            />
            <span class="trigger-icon">📚</span>
            <strong>Photographier une Étagère / Pile</strong>
            <small>Détecte plusieurs BD/livres d'un coup avec validation un par un</small>
          </label>
        </div>

        <div v-if="isAnalyzingPhoto" class="photo-loading">
          ⏳ Compression WebP et analyse visuelle des livres en cours...
        </div>

        <div v-if="photoError" class="error-banner">{{ photoError }}</div>
        <div v-if="photoSavingFeedback" class="quick-feedback">{{ photoSavingFeedback }}</div>

        <!-- Validation livre par livre -->
        <div v-if="recognizedCandidates.length > 0" class="candidates-validation-box">
          <div class="validation-header">
            <h4>Validation livre par livre ({{ selectedCandidatesCount }}/{{ recognizedCandidates.length }} cochés)</h4>
            <select v-model="photoTargetStatus" class="provider-select">
              <option value="owned">Ajouter à ma Collection</option>
              <option value="wish">Ajouter à ma Wishlist</option>
            </select>
          </div>

          <div class="candidates-list">
            <div
              v-for="(cand, idx) in recognizedCandidates"
              :key="idx"
              class="candidate-row"
            >
              <input type="checkbox" v-model="cand.selected" class="cand-check" />
              <div class="cand-fields">
                <input v-model="cand.title" placeholder="Titre du livre" class="cand-input bold" />
                <div class="cand-sub-row">
                  <input v-model="cand.series" placeholder="Série (si BD/saga)" class="cand-input" />
                  <input v-model="cand.volumeNumber" placeholder="Tome" class="cand-input small" />
                  <input v-model="cand.author" placeholder="Auteur" class="cand-input" />
                </div>
              </div>
            </div>
          </div>

          <button
            type="button"
            class="action-btn primary full-width"
            :disabled="selectedCandidatesCount === 0"
            @click="confirmAndSaveCandidates"
          >
            ✅ Valider et enregistrer les {{ selectedCandidatesCount }} livre(s) coché(s)
          </button>
        </div>
      </div>

      <div v-if="scannerState.errorMessage.value" class="error-banner">
        {{ scannerState.errorMessage.value }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.scanner-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.85);
  z-index: 9999;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 0.75rem;
  overflow-y: auto;
}

.scanner-modal-card {
  width: 100%;
  max-width: 540px;
  background: #fff;
  border: 2px solid #000;
  box-shadow: 6px 6px 0 #000;
  padding: 0.85rem;
  margin-top: 0.5rem;
}

.scanner-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.mode-tabs {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.mode-tab {
  border: 2px solid #000;
  background: #f1f5f9;
  padding: 0.4rem 0.65rem;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

.mode-tab.active {
  background: #4f46e5;
  color: #fff;
}

.close-scan-btn {
  border: 2px solid #000;
  background: #fee2e2;
  color: #991b1b;
  font-weight: 700;
  padding: 0.4rem 0.65rem;
  font-size: 0.8rem;
  cursor: pointer;
}

.burst-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  padding: 0.45rem 0.65rem;
  margin-bottom: 0.5rem;
  font-size: 0.82rem;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.burst-target-switch {
  display: flex;
  gap: 0.35rem;
}

.burst-target-switch button {
  border: 1px solid #000;
  background: #fff;
  padding: 0.25rem 0.55rem;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
}

.burst-target-switch button.active {
  background: #0f172a;
  color: #fff;
}

.scanner-viewport-container {
  position: relative;
  min-height: 220px;
  background: #000;
  border: 2px solid #000;
  overflow: hidden;
}

.scanner-viewport {
  width: 100%;
}

.scanner-placeholder {
  color: #fff;
  text-align: center;
  padding: 2rem 1rem;
  font-size: 0.9rem;
}

.burst-live-toast {
  margin-top: 0.6rem;
  padding: 0.65rem 0.8rem;
  border: 2px solid #000;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  background: #dcfce7;
  color: #14532d;
}

.burst-live-toast.already_owned {
  background: #fef3c7;
  color: #78350f;
}

.toast-main {
  display: flex;
  flex-direction: column;
  font-size: 0.85rem;
}

.undo-btn,
.mini-undo {
  border: 1px solid #000;
  background: #fff;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.burst-history-box {
  margin-top: 0.65rem;
  border: 1px solid #cbd5e1;
  padding: 0.5rem;
  background: #f8fafc;
  font-size: 0.8rem;
}

.burst-history-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.4rem;
}

.clear-btn {
  background: none;
  border: none;
  text-decoration: underline;
  cursor: pointer;
  font-size: 0.75rem;
}

.burst-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.burst-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  padding: 0.3rem 0.5rem;
  border: 1px solid #e2e8f0;
}

.verdict-banner {
  border: 2px solid #000;
  padding: 1rem;
  margin-bottom: 0.75rem;
}

.verdict-banner.owned {
  background: #dcfce7;
  color: #14532d;
}

.verdict-banner.owned-other {
  background: #d1fae5;
  color: #065f46;
}

.verdict-banner.wish {
  background: #dbeafe;
  color: #1e3a8a;
}

.verdict-banner.series-gap {
  background: #ffedd5;
  color: #7c2d12;
}

.verdict-banner.not-owned,
.verdict-banner.neutral {
  background: #f1f5f9;
  color: #0f172a;
}

.verdict-badge {
  font-weight: 900;
  font-size: 0.85rem;
  letter-spacing: 0.03em;
  margin-bottom: 0.3rem;
}

.verdict-title {
  margin: 0 0 0.25rem;
  font-size: 1.15rem;
}

.verdict-sub {
  margin: 0;
  font-size: 0.88rem;
}

.missing-tomes-pill {
  margin-top: 0.6rem;
  padding: 0.4rem 0.6rem;
  background: rgba(255, 255, 255, 0.75);
  border: 1px solid #000;
  font-size: 0.8rem;
}

.check-actions-grid {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.action-btn {
  border: 2px solid #000;
  padding: 0.65rem 0.85rem;
  font-weight: 700;
  font-size: 0.9rem;
  cursor: pointer;
  text-align: center;
}

.action-btn.primary {
  background: #4f46e5;
  color: #fff;
}

.action-btn.secondary {
  background: #0284c7;
  color: #fff;
}

.action-btn.series {
  background: #f59e0b;
  color: #000;
}

.action-btn.outline {
  background: #fff;
  color: #000;
}

.action-btn.rescan {
  background: #0f172a;
  color: #fff;
}

.quick-feedback {
  background: #dcfce7;
  border: 2px solid #166534;
  color: #14532d;
  padding: 0.5rem;
  font-weight: 700;
  text-align: center;
  margin-bottom: 0.6rem;
}

.byok-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  padding: 0.5rem 0.75rem;
  font-size: 0.82rem;
  margin-bottom: 0.65rem;
}

.byok-wizard {
  border: 2px dashed #4f46e5;
  background: #eef2ff;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
  font-size: 0.83rem;
}

.byok-wizard h4 {
  margin: 0 0 0.4rem;
}

.wizard-steps {
  margin: 0 0 0.6rem;
  padding-left: 1.2rem;
}

.wizard-controls {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.provider-select,
.key-input {
  border: 2px solid #000;
  padding: 0.45rem;
  font-size: 0.85rem;
}

.key-status {
  margin-top: 0.45rem;
  padding: 0.4rem;
  font-weight: 700;
}

.key-status.ok {
  background: #dcfce7;
  color: #166534;
}

.key-status.err {
  background: #fee2e2;
  color: #991b1b;
}

.photo-triggers-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
  margin-bottom: 0.75rem;
}

.photo-trigger-card {
  border: 2px solid #000;
  background: #f8fafc;
  padding: 0.85rem 0.6rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.3rem;
  cursor: pointer;
}

.photo-trigger-card:hover {
  background: #e0e7ff;
}

.trigger-icon {
  font-size: 1.6rem;
}

.photo-loading {
  padding: 1rem;
  text-align: center;
  font-weight: 700;
  background: #eef2ff;
  border: 1px solid #4f46e5;
}

.candidates-validation-box {
  border: 2px solid #000;
  padding: 0.65rem;
  background: #f8fafc;
}

.validation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.validation-header h4 {
  margin: 0;
  font-size: 0.9rem;
}

.candidates-list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  max-height: 260px;
  overflow-y: auto;
  margin-bottom: 0.65rem;
}

.candidate-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  background: #fff;
  border: 1px solid #cbd5e1;
  padding: 0.45rem;
}

.cand-fields {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.cand-sub-row {
  display: flex;
  gap: 0.3rem;
}

.cand-input {
  width: 100%;
  border: 1px solid #94a3b8;
  padding: 0.28rem 0.4rem;
  font-size: 0.8rem;
}

.cand-input.bold {
  font-weight: 700;
}

.cand-input.small {
  max-width: 70px;
}

.full-width {
  width: 100%;
}

.link-btn {
  background: none;
  border: none;
  color: #4f46e5;
  text-decoration: underline;
  font-weight: 700;
  cursor: pointer;
  font-size: 0.8rem;
}

.error-banner {
  margin-top: 0.5rem;
  padding: 0.6rem;
  border: 2px solid #b91c1c;
  background: #fef2f2;
  color: #991b1b;
  font-weight: 700;
  font-size: 0.85rem;
}
</style>
