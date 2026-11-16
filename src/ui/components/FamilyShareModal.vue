<template>
  <div v-if="show" class="modal-backdrop" @click.self="closeModal">
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="Partage Foyer et Amis">
      <div class="modal-header">
        <h3>Foyer &amp; Amis</h3>
        <button type="button" class="close-btn" @click="closeModal" aria-label="Fermer">✕</button>
      </div>

      <!-- Deux onglets distincts pour éviter toute confusion lors du scan du QR code -->
      <div class="tab-bar" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'family'"
          :class="['tab-btn', { active: activeTab === 'family', 'tab-family': activeTab === 'family' }]"
          @click="activeTab = 'family'"
        >
          Famille (Synchro)
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'friends'"
          :class="['tab-btn', { active: activeTab === 'friends', 'tab-friends': activeTab === 'friends' }]"
          @click="activeTab = 'friends'"
        >
          Vitrine Amis
        </button>
      </div>

      <!-- ONGLET 1 : SYNCHRONISATION FAMILLE -->
      <div v-if="activeTab === 'family'" class="modal-body">
        <section class="share-section family-card">
          <div class="section-badge family">ACCÈS FOYER COMPLET (LECTURE + ÉCRITURE)</div>
          <p class="section-desc">
            Faites scanner ce QR code à un membre de votre foyer : il télécharge l'application,
            crée son compte avec l'option <strong>« Synchroniser avec la famille »</strong> pré-cochée,
            et partage la même collection en temps réel.
          </p>

          <div v-if="familyInviteLink" class="qr-center">
            <QrCodeDisplay
              :value="familyInviteLink"
              label="Scanner pour rejoindre et synchroniser le foyer"
              :size="195"
              accent-color="#4f46e5"
            />
          </div>

          <div class="code-pill-row">
            <span class="code-label">Code foyer :</span>
            <code class="code-value">{{ inviteCode || 'Non disponible' }}</code>
            <button
              type="button"
              class="copy-btn"
              :disabled="!inviteCode"
              @click="copyText(inviteCode, 'family-code')"
            >
              {{ copiedKey === 'family-code' ? 'Copié ✓' : 'Copier' }}
            </button>
          </div>

          <div class="share-actions-row">
            <input type="text" readonly :value="familyInviteLink" class="link-input" aria-label="Lien d'invitation famille" />
            <button
              type="button"
              class="copy-btn primary"
              :disabled="!familyInviteLink"
              @click="copyText(familyInviteLink, 'family-link')"
            >
              {{ copiedKey === 'family-link' ? 'Lien copié ✓' : 'Copier lien' }}
            </button>
            <button
              v-if="canNativeShare"
              type="button"
              class="copy-btn"
              :disabled="!familyInviteLink"
              @click="nativeShare('Rejoindre notre bibliothèque familiale', familyInviteLink)"
            >
              Partager
            </button>
          </div>

          <div v-if="familyMembers.length > 0" class="members-box">
            <span class="members-title">Membres du foyer ({{ familyMembers.length }}) :</span>
            <div class="members-chips">
              <span v-for="m in familyMembers" :key="m.id" class="member-chip">
                {{ m.display_name }}
                <small v-if="m.role === 'owner'">(proprio)</small>
              </span>
            </div>
          </div>
        </section>

        <!-- Rejoindre un foyer existant -->
        <details class="join-details">
          <summary>🔑 Rejoindre le foyer d'un autre membre</summary>
          <div class="join-inner">
            <p class="section-desc">
              Entrez un code d'invitation <code>FAM-...</code> pour rattacher votre compte à une bibliothèque familiale existante.
            </p>
            <div class="share-actions-row">
              <input
                v-model="joinInput"
                type="text"
                placeholder="Ex: FAM-A1B2C3"
                class="link-input"
                @keyup.enter="handleJoin"
              />
              <button
                type="button"
                class="copy-btn primary"
                :disabled="joining || !joinInput.trim()"
                @click="handleJoin"
              >
                {{ joining ? 'Validation...' : 'Rejoindre' }}
              </button>
            </div>
            <p v-if="joinMessage" :class="['status-msg', joinSuccess ? 'ok' : 'err']">{{ joinMessage }}</p>
          </div>
        </details>
      </div>

      <!-- ONGLET 2 : VITRINE AMIS (LECTURE SEULE) -->
      <div v-else class="modal-body">
        <section class="share-section friends-card">
          <div class="section-badge friends">VITRINE AMIS — LECTURE SEULE</div>
          <p class="section-desc">
            Un ami qui scanne ce QR code consulte uniquement <strong>votre bibliothèque assignée</strong>
            (albums <strong>possédés</strong> + <strong>wishlist</strong>), sans pouvoir rien modifier.
            S'il installe l'app et crée son propre compte, il gardera sa collection personnelle séparée et vous retrouvera dans sa page <strong>Amis</strong>.
          </p>

          <div v-if="publicReadonlyLink" class="qr-center">
            <QrCodeDisplay
              :value="publicReadonlyLink"
              label="Scanner pour voir ma collection et ma wishlist"
              :size="195"
              accent-color="#059669"
            />
          </div>

          <div class="code-pill-row">
            <span class="code-label">Code ami :</span>
            <code class="code-value friends-code">{{ publicReadonlyToken || 'Non disponible' }}</code>
            <button
              type="button"
              class="copy-btn"
              :disabled="!publicReadonlyToken"
              @click="copyText(publicReadonlyToken, 'friends-code')"
            >
              {{ copiedKey === 'friends-code' ? 'Copié ✓' : 'Copier' }}
            </button>
          </div>

          <div class="share-actions-row">
            <input type="text" readonly :value="publicReadonlyLink" class="link-input" aria-label="Lien vitrine amis" />
            <button
              type="button"
              class="copy-btn success"
              :disabled="!publicReadonlyLink"
              @click="copyText(publicReadonlyLink, 'friends-link')"
            >
              {{ copiedKey === 'friends-link' ? 'Lien copié ✓' : 'Copier lien' }}
            </button>
            <button
              v-if="canNativeShare"
              type="button"
              class="copy-btn"
              :disabled="!publicReadonlyLink"
              @click="nativeShare('Découvrir ma bibliothèque BD/Livres', publicReadonlyLink)"
            >
              Partager
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { sessionStore } from '../../state/session';
import { userService } from '../../core/services/user.service';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';
import QrCodeDisplay from './QrCodeDisplay.vue';

const props = withDefaults(
  defineProps<{
    show: boolean;
    initialTab?: 'family' | 'friends';
  }>(),
  {
    initialTab: 'family'
  }
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'joined'): void;
}>();

const activeTab = ref<'family' | 'friends'>(props.initialTab);
const joinInput = ref('');
const joining = ref(false);
const joinMessage = ref('');
const joinSuccess = ref(false);
const copiedKey = ref('');

watch(
  () => [props.show, props.initialTab] as const,
  ([isOpen, tab]) => {
    if (isOpen) {
      activeTab.value = tab || 'family';
      joinMessage.value = '';
      copiedKey.value = '';
    }
  }
);

const user = computed(() => sessionStore.state.user);
const inviteCode = computed(() => user.value?.inviteCode || '');
const publicReadonlyToken = computed(() => user.value?.publicReadonlyToken || '');
const familyMembers = computed(() => user.value?.members || []);
const canNativeShare = computed(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function');

const originUrl = computed(() => (typeof window !== 'undefined' ? window.location.origin : ''));
const familyInviteLink = computed(() =>
  inviteCode.value ? `${originUrl.value}/login?invite=${encodeURIComponent(inviteCode.value)}` : ''
);
const publicReadonlyLink = computed(() =>
  publicReadonlyToken.value ? `${originUrl.value}/shared/${encodeURIComponent(publicReadonlyToken.value)}` : ''
);

const closeModal = () => {
  joinMessage.value = '';
  emit('close');
};

const copyText = async (value: string, key: string) => {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = '';
    }, 2200);
  } catch (e) {
    console.warn('Copie impossible:', e);
  }
};

const nativeShare = async (title: string, url: string) => {
  if (!canNativeShare.value || !url) return;
  try {
    await navigator.share({ title, url });
  } catch {
    // Annulation utilisateur
  }
};

const extractFamCode = (raw: string): string => {
  const trimmed = raw.trim();
  const match = trimmed.match(/(FAM-[A-Z0-9]+)/i);
  return match ? match[1].toUpperCase() : trimmed.toUpperCase();
};

const handleJoin = async () => {
  const code = extractFamCode(joinInput.value);
  if (!code) return;
  joining.value = true;
  joinMessage.value = '';
  joinSuccess.value = false;

  try {
    const res = await userService.joinFamilyLibrary(code);
    if (!res.ok) {
      joinMessage.value = res.error || 'Impossible de rejoindre ce foyer.';
      return;
    }
    await connectionService.initializeApp();
    joinSuccess.value = true;
    joinMessage.value = 'Foyer rejoint ! Votre collection est maintenant synchronisée.';
    joinInput.value = '';
    emit('joined');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erreur réseau lors de la jonction.';
    joinMessage.value = msg;
  } finally {
    joining.value = false;
  }
};
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem;
  z-index: 1000;
}

.modal-card {
  background: #ffffff;
  border: 2.5px solid #000;
  box-shadow: 6px 6px 0 #000;
  width: 100%;
  max-width: 520px;
  max-height: 92vh;
  overflow-y: auto;
  padding: 1rem;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.modal-header h3 {
  margin: 0;
  font-size: 1.12rem;
}

.close-btn {
  background: none;
  border: 2px solid #000;
  width: 32px;
  height: 32px;
  font-weight: 800;
  cursor: pointer;
}

.tab-bar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.45rem;
  margin-bottom: 0.85rem;
}

.tab-btn {
  padding: 0.6rem 0.5rem;
  border: 2px solid #111827;
  background: #f3f4f6;
  font-weight: 800;
  font-size: 0.86rem;
  cursor: pointer;
  color: #374151;
}

.tab-btn.active.tab-family {
  background: #4f46e5;
  color: #fff;
  box-shadow: 2px 2px 0 #000;
}

.tab-btn.active.tab-friends {
  background: #059669;
  color: #fff;
  box-shadow: 2px 2px 0 #000;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.share-section {
  border: 2px solid #111827;
  padding: 0.85rem;
  background: #fff;
}

.family-card {
  background: #f5f3ff;
  border-color: #4f46e5;
}

.friends-card {
  background: #ecfdf5;
  border-color: #059669;
}

.section-badge {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 900;
  letter-spacing: 0.04em;
  padding: 0.2rem 0.45rem;
  border-radius: 3px;
  margin-bottom: 0.45rem;
}

.section-badge.family {
  background: #4f46e5;
  color: #fff;
}

.section-badge.friends {
  background: #059669;
  color: #fff;
}

.section-desc {
  margin: 0 0 0.7rem 0;
  font-size: 0.82rem;
  color: #1f2937;
  line-height: 1.4;
}

.qr-center {
  display: flex;
  justify-content: center;
  margin: 0.4rem 0 0.8rem 0;
}

.code-pill-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 0.55rem;
  flex-wrap: wrap;
}

.code-label {
  font-size: 0.8rem;
  font-weight: 700;
  color: #374151;
}

.code-value {
  font-weight: 900;
  font-size: 0.92rem;
  background: #fff;
  border: 1.5px solid #4f46e5;
  padding: 0.2rem 0.5rem;
  color: #312e81;
}

.code-value.friends-code {
  border-color: #059669;
  color: #065f46;
}

.share-actions-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  flex-wrap: wrap;
}

.link-input {
  flex: 1;
  min-width: 150px;
  border: 2px solid #000;
  padding: 0.42rem 0.55rem;
  font-size: 0.8rem;
  background: #fff;
}

.copy-btn {
  border: 2px solid #000;
  background: #fff;
  padding: 0.42rem 0.65rem;
  font-weight: 800;
  font-size: 0.78rem;
  cursor: pointer;
  white-space: nowrap;
}

.copy-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.copy-btn.primary {
  background: #4f46e5;
  color: #fff;
}

.copy-btn.success {
  background: #059669;
  color: #fff;
}

.members-box {
  margin-top: 0.75rem;
  padding-top: 0.6rem;
  border-top: 1px dashed #c7d2fe;
}

.members-title {
  display: block;
  font-size: 0.76rem;
  font-weight: 800;
  color: #3730a3;
  margin-bottom: 0.35rem;
}

.members-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.member-chip {
  font-size: 0.76rem;
  font-weight: 700;
  background: #fff;
  border: 1.5px solid #818cf8;
  padding: 0.15rem 0.45rem;
}

.join-details {
  border: 2px solid #111827;
  padding: 0.6rem 0.75rem;
  background: #f9fafb;
}

.join-details summary {
  cursor: pointer;
  font-weight: 800;
  font-size: 0.84rem;
  color: #111827;
}

.join-inner {
  margin-top: 0.6rem;
}

.status-msg {
  margin: 0.45rem 0 0;
  padding: 0.45rem;
  font-size: 0.8rem;
  font-weight: 700;
}

.status-msg.ok {
  background: #dcfce7;
  color: #166534;
}

.status-msg.err {
  background: #fee2e2;
  color: #991b1b;
}
</style>
