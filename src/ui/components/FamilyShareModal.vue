<template>
  <Teleport to="body">
    <div v-if="show" class="modal-backdrop" @click.self="closeModal">
      <div ref="modalCardRef" class="modal-card" role="dialog" aria-modal="true" aria-label="Partage Foyer et Amis">
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

      <div v-if="isScrollable" class="modal-bottom-close-bar">
        <button type="button" class="close-btn" @click="closeModal" aria-label="Fermer">✕</button>
      </div>
    </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { sessionStore } from '../../state/session';
import { userService } from '../../core/services/user.service';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';
import QrCodeDisplay from './QrCodeDisplay.vue';
import { useModalScrollable } from '../composables/useModalScrollable';

const modalCardRef = ref<HTMLElement | null>(null);

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
const { isScrollable } = useModalScrollable(modalCardRef, () => [props.show, activeTab.value, joinMessage.value]);

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
  width: 100%;
  min-block-size: 100dvh;
  background: rgba(15, 23, 42, 0.58);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: var(--z-modal, 2000);
  overflow-y: auto;
  overscroll-behavior: contain;
  box-sizing: border-box;
}

.modal-card {
  background: var(--color-bg-main, #ffffff);
  color: var(--color-text-main, #0f172a);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-lg, 16px);
  box-shadow: var(--shadow-modal, 0 20px 25px -5px rgba(15, 23, 42, 0.16));
  inline-size: 100%;
  max-inline-size: 520px;
  max-block-size: 92dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1.35rem;
  font-family: var(--font-main);
  box-sizing: border-box;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.85rem;
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
  background: var(--color-bg-alt, #f8fafc);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  min-inline-size: 34px;
  min-block-size: 34px;
  font-weight: 600;
  cursor: pointer;
  color: var(--color-text-main, #0f172a);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.close-btn:hover {
  background: #e2e8f0;
}

.tab-bar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  margin-bottom: 0.9rem;
}

.tab-btn {
  min-block-size: 40px;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  background: var(--color-bg-alt, #f8fafc);
  font-weight: 600;
  font-size: 0.875rem;
  line-height: 1.25;
  cursor: pointer;
  color: var(--color-text-muted, #475569);
  transition: all 0.15s ease;
}

.tab-btn.active.tab-family {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #fff;
  box-shadow: var(--shadow-sm);
}

.tab-btn.active.tab-friends {
  background: #059669;
  border-color: #059669;
  color: #fff;
  box-shadow: var(--shadow-sm);
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.share-section {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  padding: 1rem;
  background: var(--color-bg-main, #ffffff);
}

.family-card {
  background: #f5f3ff;
  border-color: #c7d2fe;
}

.friends-card {
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.section-badge {
  display: inline-block;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 0.25rem 0.55rem;
  border-radius: 9999px;
  margin-bottom: 0.5rem;
}

.section-badge.family {
  background: var(--color-primary, #4f46e5);
  color: #fff;
}

.section-badge.friends {
  background: #059669;
  color: #fff;
}

.section-desc {
  margin: 0 0 0.75rem 0;
  font-size: 0.84rem;
  color: #334155;
  line-height: 1.5;
  text-wrap: pretty;
}

.qr-center {
  display: flex;
  justify-content: center;
  margin: 0.45rem 0 0.85rem 0;
}

.code-pill-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 0.6rem;
  flex-wrap: wrap;
}

.code-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #334155;
}

.code-value {
  font-weight: 700;
  font-size: 0.9rem;
  background: #fff;
  border: 1px solid #c7d2fe;
  border-radius: var(--radius-sm, 8px);
  padding: 0.25rem 0.6rem;
  color: #312e81;
}

.code-value.friends-code {
  border-color: #a7f3d0;
  color: #065f46;
}

.share-actions-row {
  display: flex;
  gap: 0.45rem;
  align-items: center;
  flex-wrap: wrap;
}

.link-input {
  flex: 1;
  min-inline-size: 150px;
  min-block-size: 38px;
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  padding: 0.42rem 0.6rem;
  font-size: 0.8125rem;
  background: #fff;
  color: var(--color-text-main, #0f172a);
}

.link-input:focus {
  outline: none;
  border-color: var(--color-primary, #4f46e5);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15);
}

.copy-btn {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-sm, 8px);
  background: #fff;
  color: var(--color-text-main, #0f172a);
  min-block-size: 38px;
  padding: 0.42rem 0.75rem;
  font-weight: 600;
  font-size: 0.8125rem;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.copy-btn:hover:not(:disabled) {
  background: var(--color-bg-alt, #f8fafc);
}

.copy-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.copy-btn.primary {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #fff;
}

.copy-btn.success {
  background: #059669;
  border-color: #059669;
  color: #fff;
}

.members-box {
  margin-top: 0.8rem;
  padding-top: 0.65rem;
  border-top: 1px dashed #c7d2fe;
}

.members-title {
  display: block;
  font-size: 0.78rem;
  font-weight: 700;
  color: #3730a3;
  margin-bottom: 0.4rem;
}

.members-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.member-chip {
  font-size: 0.78rem;
  font-weight: 600;
  background: #fff;
  border: 1px solid #c7d2fe;
  border-radius: 9999px;
  padding: 0.2rem 0.55rem;
  color: #312e81;
}

.join-details {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  padding: 0.7rem 0.85rem;
  background: var(--color-bg-alt, #f8fafc);
}

.join-details summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--color-text-main, #0f172a);
}

.join-inner {
  margin-top: 0.65rem;
}

.status-msg {
  margin: 0.5rem 0 0;
  padding: 0.5rem 0.65rem;
  border-radius: var(--radius-sm, 8px);
  font-size: 0.8125rem;
  font-weight: 600;
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
