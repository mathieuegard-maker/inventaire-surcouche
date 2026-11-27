<!-- src/client/views/SocialView.vue -->
<!-- Partage Foyer & Amis (V2.6 mobile-first) : 2 lignes distinctes (Code + Copier, Lien + Copier le lien),
     infobulles ? dédiées et onglets tactiles homogènes. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Copy, ExternalLink, Link2, RefreshCw, Share2, Trash2, UserPlus, Users } from '@lucide/vue';
import BaseModal from '../components/base/BaseModal.vue';
import HelpTooltip from '../components/base/HelpTooltip.vue';
import QrCodeDisplay from '../components/base/QrCodeDisplay.vue';
import { useAuthStore } from '../stores/auth.store';
import { useSocialStore } from '../stores/social.store';
import { useUiStore } from '../stores/ui.store';
import { ApiClientError } from '../api/client';
import { t } from '../../shared/locales';

type SocialTab = 'family' | 'friends';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const socialStore = useSocialStore();
const uiStore = useUiStore();

function resolveTab(): SocialTab {
  return route.query.tab === 'friends' ? 'friends' : 'family';
}

const activeTab = ref<SocialTab>(resolveTab());

watch(
  () => route.query.tab,
  () => {
    activeTab.value = resolveTab();
  }
);

function selectTab(tab: SocialTab): void {
  activeTab.value = tab;
  void router.replace({ path: '/social', query: tab === 'family' ? {} : { tab } });
}

const origin = computed(() => (typeof window !== 'undefined' ? window.location.origin : ''));
const familyCode = computed(() => authStore.profile?.library.familyInviteCode ?? '');
const friendCode = computed(() => authStore.profile?.library.friendShareToken ?? '');
const familyUrl = computed(() =>
  familyCode.value ? `${origin.value}/login?invite=${encodeURIComponent(familyCode.value)}` : ''
);
const friendUrl = computed(() =>
  friendCode.value ? `${origin.value}/shared/${encodeURIComponent(friendCode.value)}` : ''
);

const joinCodeInput = ref('');
const joiningFamily = ref(false);
const addFriendInput = ref('');
const addingFriend = ref(false);

const regenTarget = ref<'family' | 'friend' | null>(null);
const regenBusy = ref(false);

onMounted(() => {
  void socialStore.fetchFriends();
});

async function copyText(
  text: string,
  toastKey: 'social.familyCodeCopied' | 'social.friendCodeCopied'
): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    uiStore.pushToast(t(toastKey), 'success');
  } catch {
    uiStore.pushToast(t('app.retry'), 'warning');
  }
}

async function nativeShare(
  url: string,
  label: string,
  toastKey: 'social.familyCodeCopied' | 'social.friendCodeCopied'
): Promise<void> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: label, url });
      return;
    } catch {
      // fallback clipboard
    }
  }
  await copyText(url, toastKey);
}

async function confirmRegenerate(): Promise<void> {
  if (!regenTarget.value) return;
  regenBusy.value = true;
  try {
    await socialStore.regenerateToken(regenTarget.value);
    regenTarget.value = null;
    uiStore.pushToast(t('social.regeneratedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    regenBusy.value = false;
  }
}

async function handleJoinFamily(): Promise<void> {
  const code = joinCodeInput.value.trim();
  if (!code) return;
  joiningFamily.value = true;
  try {
    const res = await socialStore.joinFamily(code);
    joinCodeInput.value = '';
    uiStore.pushToast(t('social.joinFamilySuccess', { name: res.targetLibraryName }), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    joiningFamily.value = false;
  }
}

async function handleAddFriend(): Promise<void> {
  const token = addFriendInput.value.trim();
  if (!token) return;
  addingFriend.value = true;
  try {
    await socialStore.addFriend(token);
    addFriendInput.value = '';
    uiStore.pushToast(t('social.friendAddedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    addingFriend.value = false;
  }
}

async function handleRemoveFriend(libraryId: string): Promise<void> {
  try {
    await socialStore.removeFriend(libraryId);
    uiStore.pushToast(t('social.friendRemovedToast'), 'info');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  }
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-page-head">
      <h1>{{ t('social.title') }}</h1>
    </div>

    <div class="ds-segmented" role="tablist">
      <button
        type="button"
        role="tab"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': activeTab === 'family' }"
        :aria-selected="activeTab === 'family'"
        @click="selectTab('family')"
      >
        {{ t('social.tabFamily') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-segmented__btn"
        :class="{ 'ds-segmented__btn--active': activeTab === 'friends' }"
        :aria-selected="activeTab === 'friends'"
        @click="selectTab('friends')"
      >
        {{ t('social.tabFriends') }}
      </button>
    </div>

    <!-- ==================== ONGLET FOYER & LIENS ==================== -->
    <div v-if="activeTab === 'family'" class="ds-stack">
      <div class="ds-grid-2">
        <!-- Carte Code Foyer -->
        <div class="ds-card ds-stack">
          <div class="ds-row ds-row--between">
            <h2>{{ t('social.familyCodeLabel') }}</h2>
            <HelpTooltip :title="t('social.familyCodeLabel')" :text="t('social.familyCodeHelp')" />
          </div>
          <p class="ds-text-muted">{{ t('social.familyCodeDesc') }}</p>

          <div class="social-qr-center">
            <QrCodeDisplay :value="familyUrl" :alt="t('social.familyCodeLabel')" />
          </div>

          <!-- Ligne 1 : Code + Copier -->
          <div class="social-copy-block">
            <span class="ds-label">{{ t('social.codeFieldLabel') }}</span>
            <div class="social-copy-row">
              <code class="social-copy-value">{{ familyCode }}</code>
              <button
                type="button"
                class="ds-btn ds-btn--sm"
                @click="copyText(familyCode, 'social.familyCodeCopied')"
              >
                <Copy :size="15" aria-hidden="true" />
                {{ t('social.copyCode') }}
              </button>
            </div>
          </div>

          <!-- Ligne 2 : Lien visible + Copier le lien -->
          <div class="social-copy-block">
            <span class="ds-label">{{ t('social.linkFieldLabel') }}</span>
            <div class="social-copy-row">
              <code class="social-copy-value social-copy-value--url" :title="familyUrl">{{ familyUrl }}</code>
              <button
                type="button"
                class="ds-btn ds-btn--sm"
                @click="copyText(familyUrl, 'social.familyCodeCopied')"
              >
                <Link2 :size="15" aria-hidden="true" />
                {{ t('social.copyLink') }}
              </button>
            </div>
          </div>

          <!-- Actions Partager (?) + Régénérer -->
          <div class="ds-row ds-row--between social-card-footer">
            <div class="ds-row">
              <button
                type="button"
                class="ds-btn ds-btn--primary ds-btn--sm"
                @click="nativeShare(familyUrl, t('social.familyCodeLabel'), 'social.familyCodeCopied')"
              >
                <Share2 :size="15" aria-hidden="true" />
                {{ t('social.shareBtn') }}
              </button>
              <HelpTooltip :title="t('social.shareBtn')" :text="t('social.shareHelp')" />
            </div>

            <button
              type="button"
              class="ds-btn ds-btn--danger-soft ds-btn--sm"
              @click="regenTarget = 'family'"
            >
              <RefreshCw :size="14" aria-hidden="true" />
              {{ t('social.regenerateCodeBtn') }}
            </button>
          </div>
        </div>

        <!-- Carte Code Amis -->
        <div class="ds-card ds-stack">
          <div class="ds-row ds-row--between">
            <h2>{{ t('social.friendCodeLabel') }}</h2>
            <HelpTooltip :title="t('social.friendCodeLabel')" :text="t('social.friendCodeHelp')" />
          </div>
          <p class="ds-text-muted">{{ t('social.friendCodeDesc') }}</p>

          <div class="social-qr-center">
            <QrCodeDisplay :value="friendUrl" :alt="t('social.friendCodeLabel')" />
          </div>

          <!-- Ligne 1 : Code + Copier -->
          <div class="social-copy-block">
            <span class="ds-label">{{ t('social.codeFieldLabel') }}</span>
            <div class="social-copy-row">
              <code class="social-copy-value">{{ friendCode }}</code>
              <button
                type="button"
                class="ds-btn ds-btn--sm"
                @click="copyText(friendCode, 'social.friendCodeCopied')"
              >
                <Copy :size="15" aria-hidden="true" />
                {{ t('social.copyCode') }}
              </button>
            </div>
          </div>

          <!-- Ligne 2 : Lien visible + Copier le lien -->
          <div class="social-copy-block">
            <span class="ds-label">{{ t('social.linkFieldLabel') }}</span>
            <div class="social-copy-row">
              <code class="social-copy-value social-copy-value--url" :title="friendUrl">{{ friendUrl }}</code>
              <button
                type="button"
                class="ds-btn ds-btn--sm"
                @click="copyText(friendUrl, 'social.friendCodeCopied')"
              >
                <Link2 :size="15" aria-hidden="true" />
                {{ t('social.copyLink') }}
              </button>
            </div>
          </div>

          <!-- Actions Partager (?) + Aperçu + Régénérer -->
          <div class="ds-row ds-row--between social-card-footer">
            <div class="ds-row">
              <button
                type="button"
                class="ds-btn ds-btn--primary ds-btn--sm"
                @click="nativeShare(friendUrl, t('social.friendCodeLabel'), 'social.friendCodeCopied')"
              >
                <Share2 :size="15" aria-hidden="true" />
                {{ t('social.shareBtn') }}
              </button>
              <HelpTooltip :title="t('social.shareBtn')" :text="t('social.shareHelp')" />
            </div>

            <div class="ds-row">
              <router-link :to="`/shared/${friendCode}`" class="ds-btn ds-btn--sm">
                <ExternalLink :size="14" aria-hidden="true" />
                {{ t('social.viewCollectionBtn') }}
              </router-link>
              <button
                type="button"
                class="ds-btn ds-btn--danger-soft ds-btn--sm"
                @click="regenTarget = 'friend'"
              >
                <RefreshCw :size="14" aria-hidden="true" />
                {{ t('social.regenerateCodeBtn') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Membres du foyer -->
      <div class="ds-card ds-stack">
        <div class="ds-row">
          <Users :size="18" aria-hidden="true" />
          <h2>{{ t('social.membersTitle', { count: authStore.profile?.library.members.length ?? 0 }) }}</h2>
        </div>
        <div class="ds-stack--sm">
          <div
            v-for="member in authStore.profile?.library.members ?? []"
            :key="member.userId"
            class="ds-panel ds-row ds-row--between"
          >
            <strong>{{ member.username }}</strong>
            <span class="ds-badge" :class="member.role === 'owner' ? 'ds-badge--accent' : ''">
              {{ member.role === 'owner' ? t('social.ownerBadge') : t('social.memberBadge') }}
            </span>
          </div>
        </div>
      </div>

      <!-- Rejoindre un foyer -->
      <details class="ds-accordion">
        <summary>{{ t('social.joinFamilyTitle') }}</summary>
        <form class="ds-row social-inline-form" @submit.prevent="handleJoinFamily">
          <input
            v-model="joinCodeInput"
            type="text"
            class="ds-input social-flex-input"
            :placeholder="t('social.joinFamilyPlaceholder')"
          />
          <button
            type="submit"
            class="ds-btn ds-btn--primary"
            :disabled="joiningFamily || !joinCodeInput.trim()"
          >
            {{ joiningFamily ? t('app.loading') : t('social.joinFamilyBtn') }}
          </button>
        </form>
      </details>
    </div>

    <!-- ==================== ONGLET MES AMIS ==================== -->
    <div v-else class="ds-stack">
      <div class="ds-card ds-stack">
        <h2>{{ t('social.followFriendTitle') }}</h2>
        <form class="ds-row" @submit.prevent="handleAddFriend">
          <input
            v-model="addFriendInput"
            type="text"
            class="ds-input social-flex-input"
            :placeholder="t('social.addFriendPlaceholder')"
          />
          <button
            type="submit"
            class="ds-btn ds-btn--primary"
            :disabled="addingFriend || !addFriendInput.trim()"
          >
            <UserPlus :size="16" aria-hidden="true" />
            {{ addingFriend ? t('app.loading') : t('social.addFriendBtn') }}
          </button>
        </form>
      </div>

      <p v-if="socialStore.loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>
      <p v-else-if="socialStore.friends.length === 0" class="ds-card ds-text-muted">
        {{ t('social.friendsEmpty') }}
      </p>

      <div v-else class="ds-grid-2">
        <article v-for="friend in socialStore.friends" :key="friend.libraryId" class="ds-card ds-stack">
          <div class="ds-row ds-row--between">
            <div>
              <h3>{{ friend.ownerUsername || friend.libraryName }}</h3>
              <p class="ds-text-muted">
                {{ t('social.booksSummary', { owned: friend.ownedCount, wish: friend.wishCount }) }}
              </p>
            </div>
            <span class="ds-badge">{{ t('social.readonlyBadge') }}</span>
          </div>

          <div class="ds-row ds-row--between">
            <router-link :to="`/shared/${friend.shareToken}`" class="ds-btn ds-btn--primary ds-btn--sm">
              <ExternalLink :size="14" aria-hidden="true" />
              {{ t('social.viewCollectionBtn') }}
            </router-link>
            <button
              type="button"
              class="ds-btn ds-btn--danger-soft ds-btn--sm"
              @click="handleRemoveFriend(friend.libraryId)"
            >
              <Trash2 :size="14" aria-hidden="true" />
              {{ t('social.removeFriendBtn') }}
            </button>
          </div>
        </article>
      </div>
    </div>

    <BaseModal
      :open="regenTarget !== null"
      :title="t('social.regenerateCodeTitle')"
      max-width="440px"
      @close="regenTarget = null"
    >
      <p>{{ t('social.regenerateCodeConfirm') }}</p>
      <template #footer>
        <button type="button" class="ds-btn" :disabled="regenBusy" @click="regenTarget = null">
          {{ t('app.cancel') }}
        </button>
        <button type="button" class="ds-btn ds-btn--danger" :disabled="regenBusy" @click="confirmRegenerate">
          {{ regenBusy ? t('app.loading') : t('app.confirm') }}
        </button>
      </template>
    </BaseModal>
  </section>
</template>

<style scoped>
.social-qr-center {
  display: flex;
  justify-content: center;
}

.social-copy-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.social-copy-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.social-copy-value {
  flex: 1;
  min-width: 0;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  font-weight: 700;
  font-size: 0.86rem;
  letter-spacing: 0.03em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.social-copy-value--url {
  font-weight: 500;
  letter-spacing: 0;
  color: var(--text-secondary);
}

.social-card-footer {
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

.social-inline-form {
  margin-top: var(--space-3);
}

.social-flex-input {
  flex: 1;
  min-width: 180px;
}
</style>
