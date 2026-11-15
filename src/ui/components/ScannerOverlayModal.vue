<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { scannerState } from '../../state/scanner';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import { backgroundCreationOrchestrator } from '../../core/orchestrators/background-creation.orchestrator';
import {
  byokVisionService,
  type ByokProvider
} from '../../core/services/byok-vision.service';
import {
  photoBookResolutionService,
  type ResolvedPhotoItem
} from '../../core/services/photo-book-resolution.service';
import { normalizeTextKey } from '../../core/resolvers/bnf.resolver';

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
    scannerState.notifyCatalogChanged();
    quickActionFeedback.value = 'Ajouté à votre collection ✓';
  } else {
    await queueService.enqueueAction('ADD_WISHLIST', uri);
    if (r.ownership) {
      r.ownership.isWished = true;
    }
    scannerState.notifyCatalogChanged();
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
const photoLoadingStatus = ref('Compression WebP et analyse visuelle des livres en cours...');
const photoError = ref('');
const resolvedDetectedItems = ref<ResolvedPhotoItem[]>([]);
const unresolvedItems = ref<ResolvedPhotoItem[]>([]);
const seriesExtraItems = ref<ResolvedPhotoItem[]>([]);
const detectedSeriesNames = ref<string[]>([]);
const retryingItemId = ref<string | null>(null);
const photoTargetStatus = ref<'owned' | 'wish'>('owned');
const seriesExtraTarget = ref<'none' | 'wish' | 'owned'>('none');
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
  resolvedDetectedItems.value = [];
  unresolvedItems.value = [];
  seriesExtraItems.value = [];
  detectedSeriesNames.value = [];
  isAnalyzingPhoto.value = true;
  photoLoadingStatus.value = 'Compression WebP et analyse visuelle des livres en cours...';

  try {
    const rawCandidates = await byokVisionService.analyzePhoto(file, mode, (msg) => {
      photoLoadingStatus.value = msg;
    });
    if (!rawCandidates.length) {
      photoError.value = "Aucun titre lisible n'a été détecté sur la photo. Réessayez avec plus de lumière.";
    } else {
      const batch = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries(
        rawCandidates,
        (msg) => {
          photoLoadingStatus.value = msg;
        }
      );
      resolvedDetectedItems.value = batch.detectedItems.filter((i) => i.status === 'resolved');
      unresolvedItems.value = batch.detectedItems.filter((i) => i.status === 'unresolved');
      seriesExtraItems.value = batch.seriesExtraItems;
      detectedSeriesNames.value = batch.detectedSeriesNames;
    }
  } catch (err: unknown) {
    photoError.value = err instanceof Error ? err.message : 'Erreur lors de la lecture de la photo.';
  } finally {
    isAnalyzingPhoto.value = false;
    input.value = '';
  }
}

async function retryUnresolvedItem(item: ResolvedPhotoItem) {
  if (!item.rawCandidate.title.trim() && !item.rawCandidate.isbn?.trim()) return;
  retryingItemId.value = item.id;
  try {
    const resolved = await photoBookResolutionService.resolveSingleCandidate(item.rawCandidate, 'retry');
    if (resolved.status !== 'resolved') {
      item.failureReason = resolved.failureReason || 'Toujours introuvable sur la BnF / Google Books.';
      return;
    }

    unresolvedItems.value = unresolvedItems.value.filter((u) => u.id !== item.id);
    const alreadyExists = resolved.isbn13 && resolvedDetectedItems.value.some((d) => d.isbn13 === resolved.isbn13);
    if (!alreadyExists) {
      resolvedDetectedItems.value.push(resolved);
    }

    // Si une nouvelle série est découverte, proposer aussi ses autres tomes dans la liste finale
    if (resolved.series?.trim()) {
      const sKey = normalizeTextKey(resolved.series);
      const alreadyHasSeries = detectedSeriesNames.value.some((s) => normalizeTextKey(s) === sKey);
      if (!alreadyHasSeries) {
        const batch = await photoBookResolutionService.resolveCandidatesAndDiscoverSeries([
          resolved.rawCandidate
        ]);
        const existingIsbns = new Set([
          ...resolvedDetectedItems.value.map((d) => d.isbn13).filter(Boolean),
          ...seriesExtraItems.value.map((e) => e.isbn13).filter(Boolean)
        ]);
        for (const extra of batch.seriesExtraItems) {
          if (extra.isbn13 && !existingIsbns.has(extra.isbn13)) {
            seriesExtraItems.value.push(extra);
            existingIsbns.add(extra.isbn13);
          }
        }
        detectedSeriesNames.value.push(...batch.detectedSeriesNames);
      }
    }
  } finally {
    retryingItemId.value = null;
  }
}

function toggleAllSeriesExtras(selectAll: boolean) {
  for (const item of seriesExtraItems.value) {
    if (!item.alreadyOwned) {
      item.selected = selectAll;
    }
  }
}

const selectedDetectedCount = computed(
  () => resolvedDetectedItems.value.filter((c) => c.selected).length
);

const selectedSeriesCount = computed(
  () => seriesExtraItems.value.filter((c) => c.selected).length
);

const totalSelectedToSave = computed(
  () => selectedDetectedCount.value + selectedSeriesCount.value
);

async function enqueueResolvedItem(item: ResolvedPhotoItem, target: 'owned' | 'wish' | 'none') {
  if (!item.isbn13) return;

  if (item.existingUri && (target === 'owned' || target === 'wish')) {
    await queueService.enqueueAction(target === 'owned' ? 'ADD_INVENTORY' : 'ADD_WISHLIST', item.existingUri);
    return;
  }

  await backgroundCreationOrchestrator.enqueueBookCreation({
    tempBook: {
      uri: item.existingUri || `isbn:${item.isbn13}`,
      workUri: item.existingWorkUri,
      type: 'edition',
      isbn13: item.isbn13,
      title: item.title,
      authors: item.authors.length ? item.authors : ['Auteur inconnu'],
      illustrators: [],
      scriptwriters: [],
      publisher: item.publisher || '',
      publishDate: item.publishDate,
      pageCount: item.pageCount,
      coverUrl: item.coverUrl,
      series: item.series,
      seriesNumber: item.seriesNumber,
      genres: [],
      ownershipStatus: target
    },
    ownershipTarget: target,
    // Les tomes de la série sont déjà extraits et validés explicitement ci-dessous
    expandSeries: false
  });
}

async function confirmAndSaveCandidates() {
  const detectedToSave = resolvedDetectedItems.value.filter((c) => c.selected && c.isbn13);
  const extrasToSave = seriesExtraItems.value.filter((c) => c.selected && c.isbn13);
  if (!detectedToSave.length && !extrasToSave.length) return;

  const processedIsbns = new Set<string>();
  for (const item of detectedToSave) {
    if (!item.isbn13 || processedIsbns.has(item.isbn13)) continue;
    processedIsbns.add(item.isbn13);
    await enqueueResolvedItem(item, photoTargetStatus.value);
  }

  for (const extra of extrasToSave) {
    if (!extra.isbn13 || processedIsbns.has(extra.isbn13)) continue;
    processedIsbns.add(extra.isbn13);
    await enqueueResolvedItem(extra, seriesExtraTarget.value);
  }

  scannerState.notifyCatalogChanged();
  photoSavingFeedback.value = `${detectedToSave.length} livre(s) + ${extrasToSave.length} tome(s) de série validé(s) et envoyé(s) dans le flux catalogue ✓`;
  resolvedDetectedItems.value = [];
  unresolvedItems.value = [];
  seriesExtraItems.value = [];
  detectedSeriesNames.value = [];
  setTimeout(() => {
    photoSavingFeedback.value = '';
  }, 4000);
}
</script>

<template>
  <div v-show="scannerState.isScanningActive.value" class="scanner-modal-backdrop">
    <div class="scanner-modal-card">
      <!-- En-tête + Sélecteur des 4 Modes -->
      <div class="scanner-header">
        <div class="mode-tabs">
          <button
            type="button"
            class="mode-tab"
            :class="{ active: activeMode === 'simple' }"
            @click="scannerState.switchMode('simple')"
          >
            📖 Mode Simple
          </button>
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
            📸 Photo Étagère / Couv
          </button>
        </div>
        <button type="button" class="close-scan-btn" @click="scannerState.stopScan()">
          ✕ Fermer
        </button>
      </div>

      <!-- ================================================================ -->
      <!-- FLUX CAMÉRA CODE-BARRES (Partagé entre Simple, Vérif et Rafale) -->
      <!-- ================================================================ -->
      <div v-show="activeMode !== 'photo' && !checkRes" class="camera-section">
        <div v-if="activeMode === 'simple'" class="burst-toolbar">
          <span class="burst-label">
            📖 <strong>Mode Simple :</strong> Scannez un livre pour ouvrir directement sa fiche complète et sélectionner toute sa série à la main.
          </span>
        </div>

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

        <!-- Historique de la session Rafale + Bouton de validation finale -->
        <div v-if="activeMode === 'burst' && scannerState.burstHistory.value.length > 0" class="burst-history-box">
          <div class="burst-history-header">
            <strong>Session rafale : {{ scannerState.burstHistory.value.length }} livre(s) scanné(s)</strong>
            <button type="button" class="clear-btn" @click="scannerState.burstHistory.value = []">
              Vider la liste
            </button>
          </div>
          <ul class="burst-list">
            <li v-for="item in scannerState.burstHistory.value.slice(0, 10)" :key="item.timestamp">
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
          <button
            type="button"
            class="action-btn primary full-width"
            style="margin-top: 0.65rem;"
            @click="scannerState.finishAndOpenBurstTarget(router)"
          >
            ✅ Valider et voir mes {{ scannerState.burstHistory.value.length }} livre(s) dans {{ burstTarget === 'owned' ? 'Ma Collection' : 'Ma Wishlist' }}
          </button>
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
          ⏳ {{ photoLoadingStatus }}
        </div>

        <div v-if="photoError" class="error-banner">{{ photoError }}</div>
        <div v-if="photoSavingFeedback" class="quick-feedback">{{ photoSavingFeedback }}</div>

        <!-- Validation après résolution BnF / ISBN / Couvertures + Découverte séries -->
        <div
          v-if="resolvedDetectedItems.length > 0 || unresolvedItems.length > 0 || seriesExtraItems.length > 0"
          class="candidates-validation-box"
        >
          <!-- SECTION 1 : LIVRES IDENTIFIÉS (BNF + COUVERTURE) -->
          <div v-if="resolvedDetectedItems.length > 0" class="validation-section">
            <div class="validation-header">
              <h4>✅ Identifiés via BnF/ISBN ({{ selectedDetectedCount }}/{{ resolvedDetectedItems.length }})</h4>
              <select v-model="photoTargetStatus" class="provider-select">
                <option value="owned">Ajouter à ma Collection</option>
                <option value="wish">Ajouter à ma Wishlist</option>
              </select>
            </div>

            <div class="candidates-list">
              <div
                v-for="item in resolvedDetectedItems"
                :key="item.id"
                class="candidate-row resolved-row"
              >
                <input type="checkbox" v-model="item.selected" class="cand-check" />
                <img
                  v-if="item.coverUrl"
                  :src="item.coverUrl"
                  :alt="item.title"
                  class="cand-cover-thumb"
                />
                <div v-else class="cand-cover-fallback">📖</div>
                <div class="cand-meta">
                  <div class="cand-title-line">
                    <span v-if="item.series" class="cand-series-pill">
                      {{ item.series }}<template v-if="item.seriesNumber"> T.{{ item.seriesNumber }}</template>
                    </span>
                    <strong>{{ item.title }}</strong>
                  </div>
                  <div class="cand-sub-meta">
                    <span v-if="item.authors.length">{{ item.authors.join(', ') }}</span>
                    <span v-if="item.publisher"> • {{ item.publisher }}</span>
                    <span v-if="item.publishDate"> ({{ item.publishDate }})</span>
                  </div>
                  <div class="cand-badges">
                    <code class="isbn-tag">{{ item.isbn13 }}</code>
                    <span v-if="item.alreadyOwned" class="mini-badge owned">✓ Déjà possédé</span>
                    <span v-else-if="item.alreadyWished" class="mini-badge wish">🎁 En wishlist</span>
                    <span v-if="!item.coverUrl" class="mini-badge warn">Sans couverture trouvée</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- SECTION 2 : AUTRES TOMES DES SÉRIES DÉTECTÉES -->
          <div v-if="seriesExtraItems.length > 0" class="validation-section series-extras-section">
            <div class="validation-header">
              <h4>📚 Autres tomes trouvés ({{ selectedSeriesCount }}/{{ seriesExtraItems.length }})</h4>
              <div class="series-controls-inline">
                <select v-model="seriesExtraTarget" class="provider-select">
                  <option value="none">Fiches série (catalogue seul)</option>
                  <option value="wish">Ajouter en Wishlist</option>
                  <option value="owned">Ajouter en Collection</option>
                </select>
                <button type="button" class="link-btn" @click="toggleAllSeriesExtras(true)">Tout</button>
                <button type="button" class="link-btn" @click="toggleAllSeriesExtras(false)">Aucun</button>
              </div>
            </div>

            <div class="candidates-list">
              <div
                v-for="extra in seriesExtraItems"
                :key="extra.id"
                class="candidate-row resolved-row"
              >
                <input type="checkbox" v-model="extra.selected" class="cand-check" />
                <img
                  v-if="extra.coverUrl"
                  :src="extra.coverUrl"
                  :alt="extra.title"
                  class="cand-cover-thumb"
                />
                <div v-else class="cand-cover-fallback">📖</div>
                <div class="cand-meta">
                  <div class="cand-title-line">
                    <span v-if="extra.series" class="cand-series-pill">
                      {{ extra.series }}<template v-if="extra.seriesNumber"> T.{{ extra.seriesNumber }}</template>
                    </span>
                    <strong>{{ extra.title }}</strong>
                  </div>
                  <div class="cand-sub-meta">
                    <span v-if="extra.authors.length">{{ extra.authors.join(', ') }}</span>
                    <span v-if="extra.publisher"> • {{ extra.publisher }}</span>
                    <span v-if="extra.publishDate"> ({{ extra.publishDate }})</span>
                  </div>
                  <div class="cand-badges">
                    <code class="isbn-tag">{{ extra.isbn13 }}</code>
                    <span v-if="extra.alreadyOwned" class="mini-badge owned">✓ Déjà possédé</span>
                    <span v-else-if="extra.alreadyWished" class="mini-badge wish">🎁 En wishlist</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- SECTION 3 : NON IDENTIFIÉS SUR BNF / GOOGLE BOOKS (NON VALIDABLES TEL QUEL) -->
          <div v-if="unresolvedItems.length > 0" class="validation-section unresolved-section">
            <div class="validation-header">
              <h4>⚠️ Non identifiés sur BnF ({{ unresolvedItems.length }}) — Non validables sans notice</h4>
            </div>
            <div class="candidates-list unresolved-list">
              <div
                v-for="u in unresolvedItems"
                :key="u.id"
                class="candidate-row unresolved-row"
              >
                <div class="cand-fields">
                  <input v-model="u.rawCandidate.title" placeholder="Titre du livre" class="cand-input bold" />
                  <div class="cand-sub-row">
                    <input v-model="u.rawCandidate.series" placeholder="Série" class="cand-input" />
                    <input v-model="u.rawCandidate.volumeNumber" placeholder="Tome" class="cand-input small" />
                    <input v-model="u.rawCandidate.author" placeholder="Auteur" class="cand-input" />
                  </div>
                  <div class="cand-sub-row">
                    <input v-model="u.rawCandidate.publisher" placeholder="Éditeur" class="cand-input" />
                    <input v-model="u.rawCandidate.isbn" placeholder="ISBN (optionnel)" class="cand-input" />
                    <button
                      type="button"
                      class="action-btn retry-bnf-btn"
                      :disabled="retryingItemId === u.id"
                      @click="retryUnresolvedItem(u)"
                    >
                      {{ retryingItemId === u.id ? 'Recherche...' : '🔍 BnF' }}
                    </button>
                  </div>
                  <small v-if="u.failureReason" class="unresolved-msg">{{ u.failureReason }}</small>
                </div>
              </div>
            </div>
          </div>

          <button
            v-if="resolvedDetectedItems.length > 0 || seriesExtraItems.length > 0"
            type="button"
            class="action-btn primary full-width"
            :disabled="totalSelectedToSave === 0"
            @click="confirmAndSaveCandidates"
          >
            ✅ Valider {{ selectedDetectedCount }} livre(s) + {{ selectedSeriesCount }} tome(s) de série
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

.validation-section {
  margin-bottom: 0.75rem;
}

.series-extras-section {
  border-top: 2px dashed #cbd5e1;
  padding-top: 0.65rem;
}

.series-controls-inline {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.unresolved-section {
  border-top: 2px dashed #f59e0b;
  padding-top: 0.65rem;
}

.resolved-row {
  align-items: center;
}

.cand-cover-thumb {
  width: 42px;
  height: 58px;
  object-fit: cover;
  border: 1px solid #0f172a;
  flex-shrink: 0;
  background: #f1f5f9;
}

.cand-cover-fallback {
  width: 42px;
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #cbd5e1;
  background: #f1f5f9;
  font-size: 1.25rem;
  flex-shrink: 0;
}

.cand-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.cand-title-line {
  font-size: 0.84rem;
  line-height: 1.25;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.cand-series-pill {
  background: #eef2ff;
  color: #3730a3;
  border: 1px solid #c7d2fe;
  font-size: 0.72rem;
  font-weight: 800;
  padding: 0.08rem 0.35rem;
}

.cand-sub-meta {
  font-size: 0.75rem;
  color: #475569;
}

.cand-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}

.isbn-tag {
  font-size: 0.7rem;
  background: #f1f5f9;
  padding: 0.05rem 0.3rem;
  border: 1px solid #cbd5e1;
}

.mini-badge {
  font-size: 0.68rem;
  font-weight: 800;
  padding: 0.08rem 0.32rem;
}

.mini-badge.owned {
  background: #dcfce7;
  color: #166534;
}

.mini-badge.wish {
  background: #fce7f3;
  color: #9d174d;
}

.mini-badge.warn {
  background: #fef3c7;
  color: #92400e;
}

.unresolved-row {
  background: #fffbeb;
  border-color: #fbbf24;
}

.retry-bnf-btn {
  padding: 0.28rem 0.55rem;
  font-size: 0.76rem;
  white-space: nowrap;
}

.unresolved-msg {
  color: #92400e;
  font-size: 0.72rem;
  font-weight: 600;
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
