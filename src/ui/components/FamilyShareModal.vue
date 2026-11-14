<script setup lang="ts">
import { ref, computed } from 'vue';
import { sessionStore } from '../../state/session';
import { userService } from '../../core/services/user.service';
import { connectionService } from '../../core/orchestrators/connection.orchestrator';

defineProps<{
  show: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const user = computed(() => sessionStore.state.user);
const copiedField = ref('');
const joinCodeInput = ref('');
const joinStatus = ref<{ ok?: boolean; message: string } | null>(null);
const isJoining = ref(false);

const familyInviteLink = computed(() => {
  const code = user.value?.inviteCode || '';
  if (!code || typeof window === 'undefined') return '';
  return `${window.location.origin}/login?invite=${encodeURIComponent(code)}`;
});

const publicReadonlyLink = computed(() => {
  const token = user.value?.publicReadonlyToken || '';
  if (!token || typeof window === 'undefined') return '';
  return `${window.location.origin}/shared/${encodeURIComponent(token)}`;
});

async function copyText(text: string, label: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copiedField.value = label;
    setTimeout(() => {
      copiedField.value = '';
    }, 2500);
  } catch {
    // Fallback
  }
}

async function handleJoinFamily() {
  if (!joinCodeInput.value.trim()) return;
  isJoining.value = true;
  joinStatus.value = null;
  try {
    const res = await userService.joinFamilyLibrary(joinCodeInput.value);
    if (res.ok) {
      joinStatus.value = {
        ok: true,
        message: 'Bibliothèque familiale rejointe ! Synchronisation en cours...'
      };
      await connectionService.initializeApp();
    } else {
      joinStatus.value = { ok: false, message: res.error || 'Code introuvable.' };
    }
  } catch {
    joinStatus.value = { ok: false, message: 'Erreur réseau lors de la jonction.' };
  } finally {
    isJoining.value = false;
  }
}
</script>

<template>
  <div v-if="show" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card">
      <div class="modal-header">
        <h3>👨‍👩‍👧‍👦 Partage Familial & Liens Amis</h3>
        <button type="button" class="close-btn" @click="emit('close')">✕</button>
      </div>

      <!-- 1. Inviter conjoint(e) / enfants avec synchro complète -->
      <div class="share-section">
        <h4>1. Synchroniser avec la famille (Conjoint, Enfants)</h4>
        <p class="section-desc">
          Envoyez ce lien : la personne installe l'application et synchronise automatiquement la même collection.
        </p>

        <div class="code-box">
          <span>Code Foyer : <strong>{{ user?.inviteCode || 'Chargement...' }}</strong></span>
          <button
            type="button"
            class="copy-btn"
            @click="copyText(user?.inviteCode || '', 'code')"
          >
            {{ copiedField === 'code' ? 'Copié ✓' : 'Copier le code' }}
          </button>
        </div>

        <div v-if="familyInviteLink" class="link-row">
          <input :value="familyInviteLink" readonly class="readonly-input" />
          <button
            type="button"
            class="copy-btn primary"
            @click="copyText(familyInviteLink, 'inviteLink')"
          >
            {{ copiedField === 'inviteLink' ? 'Lien copié ✓' : 'Copier le lien d’installation' }}
          </button>
        </div>
      </div>

      <!-- 2. Lien Amis en lecture seule -->
      <div class="share-section">
        <h4>2. Vitrine Amis en lecture seule (Sans compte)</h4>
        <p class="section-desc">
          Permet à vos proches de voir quels livres vous possédez et s'ils sont disponibles à l'emprunt, sans pouvoir rien modifier.
        </p>

        <div v-if="publicReadonlyLink" class="link-row">
          <input :value="publicReadonlyLink" readonly class="readonly-input" />
          <button
            type="button"
            class="copy-btn"
            @click="copyText(publicReadonlyLink, 'publicLink')"
          >
            {{ copiedField === 'publicLink' ? 'Lien copié ✓' : 'Copier le lien Amis' }}
          </button>
        </div>
      </div>

      <!-- 3. Rejoindre le foyer d'un autre membre -->
      <div class="share-section">
        <h4>3. Rejoindre une bibliothèque existante</h4>
        <div class="link-row">
          <input
            v-model="joinCodeInput"
            placeholder="Code reçu (ex: FAM-XXXXXX)"
            class="readonly-input"
          />
          <button
            type="button"
            class="copy-btn primary"
            :disabled="isJoining || !joinCodeInput.trim()"
            @click="handleJoinFamily"
          >
            {{ isJoining ? '...' : 'Rejoindre' }}
          </button>
        </div>
        <div v-if="joinStatus" class="status-msg" :class="joinStatus.ok ? 'ok' : 'err'">
          {{ joinStatus.message }}
        </div>
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
  max-width: 500px;
  background: #fff;
  border: 2px solid #000;
  box-shadow: 6px 6px 0 #000;
  padding: 1.1rem;
  max-height: 90vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.modal-header h3 {
  margin: 0;
  font-size: 1.05rem;
}

.close-btn {
  border: 2px solid #000;
  background: #f1f5f9;
  font-weight: 700;
  cursor: pointer;
  padding: 0.25rem 0.55rem;
}

.share-section {
  border-top: 1px solid #cbd5e1;
  padding-top: 0.75rem;
  margin-top: 0.75rem;
}

.share-section h4 {
  margin: 0 0 0.25rem;
  font-size: 0.92rem;
}

.section-desc {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  color: #475569;
}

.code-box {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #eef2ff;
  border: 1px dashed #4f46e5;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.5rem;
  font-size: 0.88rem;
}

.link-row {
  display: flex;
  gap: 0.4rem;
}

.readonly-input {
  flex: 1;
  border: 2px solid #000;
  padding: 0.4rem 0.55rem;
  font-size: 0.8rem;
  background: #f8fafc;
}

.copy-btn {
  border: 2px solid #000;
  background: #fff;
  padding: 0.4rem 0.65rem;
  font-weight: 700;
  font-size: 0.78rem;
  cursor: pointer;
  white-space: nowrap;
}

.copy-btn.primary {
  background: #4f46e5;
  color: #fff;
}

.status-msg {
  margin-top: 0.4rem;
  padding: 0.4rem;
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
