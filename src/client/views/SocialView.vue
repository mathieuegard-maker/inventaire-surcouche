<!-- src/client/views/SocialView.vue -->
<!-- Partage Foyer & Amis (V2.6 mobile-first) : 2 lignes distinctes (Code + Copier, Lien + Copier le lien),
     infobulles ? dédiées et onglets tactiles homogènes. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronDown,
  Copy,
  ExternalLink,
  Home,
  Link2,
  LogOut,
  RefreshCw,
  RotateCcw,
  Share2,
  Trash2,
  UserMinus,
  UserPlus,
  Users
} from '@lucide/vue';
import BaseModal from '../components/base/BaseModal.vue';
import HelpTooltip from '../components/base/HelpTooltip.vue';
import QrCodeDisplay from '../components/base/QrCodeDisplay.vue';
import { useAuthStore } from '../stores/auth.store';
import { useSocialStore, type FriendItem } from '../stores/social.store';
import { useUiStore } from '../stores/ui.store';
import { ApiClientError } from '../api/client';
import type { FamilyDetachPolicy } from '../../shared/types/domain.types';
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
const savingPolicy = ref(false);
const addFriendModalOpen = ref(false);
const addFriendInput = ref('');
const addingFriend = ref(false);
const removeConfirmFriend = ref<FriendItem | null>(null);
const removingFriend = ref(false);
const restoringLibraryId = ref<string | null>(null);

const isFamilyOwner = computed(() => authStore.profile?.library.role === 'owner');
const familyMembers = computed(() => authStore.profile?.library.members ?? []);
const currentDetachPolicy = computed<FamilyDetachPolicy>(
  () => authStore.profile?.library.detachPolicy ?? 'member_choice'
);

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

async function handleDetachPolicyChange(nextPolicy: FamilyDetachPolicy): Promise<void> {
  if (savingPolicy.value || nextPolicy === currentDetachPolicy.value) return;
  savingPolicy.value = true;
  try {
    await socialStore.updateFamilyPolicy(nextPolicy);
    uiStore.pushToast(t('social.detachPolicyUpdatedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    savingPolicy.value = false;
  }
}

function openDetachWizard(targetUserId: string): void {
  void router.push(`/social/detach/${encodeURIComponent(targetUserId)}`);
}

async function handleAddFriend(): Promise<void> {
  const token = addFriendInput.value.trim();
  if (!token) return;
  addingFriend.value = true;
  try {
    await socialStore.addFriend(token);
    addFriendInput.value = '';
    addFriendModalOpen.value = false;
    uiStore.pushToast(t('social.friendAddedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    addingFriend.value = false;
  }
}

async function confirmRemoveFriend(): Promise<void> {
  if (!removeConfirmFriend.value) return;
  removingFriend.value = true;
  try {
    await socialStore.removeFriend(removeConfirmFriend.value.libraryId);
    removeConfirmFriend.value = null;
    uiStore.pushToast(t('social.friendRemovedToast'), 'info');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    removingFriend.value = false;
  }
}

async function handleRestoreFriend(libraryId: string): Promise<void> {
  restoringLibraryId.value = libraryId;
  try {
    await socialStore.restoreFriend(libraryId);
    uiStore.pushToast(t('social.friendRestoredToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    restoringLibraryId.value = null;
  }
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-page-head social-page-head">
      <h1>{{ t('social.title') }}</h1>
      <button
        v-if="activeTab === 'friends'"
        type="button"
        class="ds-btn ds-btn--primary ds-btn--sm"
        @click="addFriendModalOpen = true"
      >
        <UserPlus :size="15" aria-hidden="true" />
        {{ t('social.addFriendOpenBtn') }}
      </button>
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
      <!-- Bloc 1 (replié sur 1 ligne claire) : Inviter un membre dans mon foyer -->
      <details class="ds-card social-expand-card">
        <summary class="social-expand-card__summary">
          <span class="social-expand-card__icon" aria-hidden="true">
            <Users :size="20" />
          </span>
          <span class="social-expand-card__head">
            <strong>{{ t('social.familyCodeLabel') }}</strong>
            <span class="ds-text-muted">{{ t('social.familyCodeShortHint') }}</span>
          </span>
          <ChevronDown :size="18" class="social-expand-card__chev" aria-hidden="true" />
        </summary>

        <div class="social-expand-card__body ds-stack">
          <div class="ds-row ds-row--between">
            <p class="ds-text-muted social-no-margin">{{ t('social.familyCodeDesc') }}</p>
            <HelpTooltip :title="t('social.familyCodeLabel')" :text="t('social.familyCodeHelp')" />
          </div>

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
      </details>

      <!-- Bloc 2 (replié sur 1 ligne claire) : Partager ma collection avec un ami -->
      <details class="ds-card social-expand-card">
        <summary class="social-expand-card__summary">
          <span class="social-expand-card__icon" aria-hidden="true">
            <Share2 :size="20" />
          </span>
          <span class="social-expand-card__head">
            <strong>{{ t('social.friendCodeLabel') }}</strong>
            <span class="ds-text-muted">{{ t('social.friendCodeShortHint') }}</span>
          </span>
          <ChevronDown :size="18" class="social-expand-card__chev" aria-hidden="true" />
        </summary>

        <div class="social-expand-card__body ds-stack">
          <div class="ds-row ds-row--between">
            <p class="ds-text-muted social-no-margin">{{ t('social.friendCodeDesc') }}</p>
            <HelpTooltip :title="t('social.friendCodeLabel')" :text="t('social.friendCodeHelp')" />
          </div>

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
      </details>

      <!-- Bloc 3 (mis en valeur, toujours visible) : Rejoindre le foyer d'un autre membre -->
      <div class="ds-card ds-stack social-join-card">
        <div class="ds-row ds-row--between">
          <div class="ds-row">
            <span class="social-expand-card__icon social-expand-card__icon--accent" aria-hidden="true">
              <Home :size="19" />
            </span>
            <h2 class="social-no-margin">{{ t('social.joinFamilyTitle') }}</h2>
          </div>
          <HelpTooltip :title="t('social.joinFamilyTitle')" :text="t('social.joinFamilyHelp')" />
        </div>
        <p class="ds-text-muted social-no-margin">{{ t('social.joinFamilyCardDesc') }}</p>
        <form class="ds-row" @submit.prevent="handleJoinFamily">
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
      </div>

      <!-- Bloc 4 : Membres du foyer, politique de départ & détachement -->
      <div class="ds-card ds-stack">
        <div class="ds-row ds-row--between">
          <div class="ds-row">
            <Users :size="18" aria-hidden="true" />
            <h2 class="social-no-margin">{{ t('social.membersTitle', { count: familyMembers.length }) }}</h2>
          </div>
          <button
            v-if="familyMembers.length >= 2"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm"
            @click="openDetachWizard('me')"
          >
            <LogOut :size="14" aria-hidden="true" />
            {{ t('social.leaveFamilyBtn') }}
          </button>
        </div>

        <div class="ds-stack--sm">
          <div
            v-for="member in familyMembers"
            :key="member.userId"
            class="ds-panel ds-row ds-row--between"
          >
            <div class="ds-row">
              <strong>{{ member.username }}</strong>
              <span class="ds-badge" :class="member.role === 'owner' ? 'ds-badge--accent' : ''">
                {{ member.role === 'owner' ? t('social.ownerBadge') : t('social.memberBadge') }}
              </span>
            </div>

            <button
              v-if="isFamilyOwner && familyMembers.length >= 2 && member.userId !== authStore.profile?.user.id"
              type="button"
              class="ds-btn ds-btn--sm"
              @click="openDetachWizard(member.userId)"
            >
              <UserMinus :size="14" aria-hidden="true" />
              {{ t('social.detachMemberBtn') }}
            </button>
          </div>
        </div>

        <!-- Réglage chef de foyer : qui choisit les livres lors d'un départ -->
        <div v-if="isFamilyOwner && familyMembers.length >= 2" class="ds-panel ds-stack--sm social-policy-box">
          <div class="ds-row ds-row--between">
            <strong class="social-policy-title">{{ t('social.detachPolicyLabel') }}</strong>
            <HelpTooltip :title="t('social.detachPolicyLabel')" :text="t('social.detachPolicyHelp')" />
          </div>
          <label class="ds-radio-option">
            <input
              type="radio"
              name="family-detach-policy"
              value="member_choice"
              :checked="currentDetachPolicy === 'member_choice'"
              :disabled="savingPolicy"
              @change="handleDetachPolicyChange('member_choice')"
            />
            <span class="ds-radio-option__body">
              <span>{{ t('social.detachPolicyMemberChoice') }}</span>
            </span>
          </label>
          <label class="ds-radio-option">
            <input
              type="radio"
              name="family-detach-policy"
              value="owner_only"
              :checked="currentDetachPolicy === 'owner_only'"
              :disabled="savingPolicy"
              @change="handleDetachPolicyChange('owner_only')"
            />
            <span class="ds-radio-option__body">
              <span>{{ t('social.detachPolicyOwnerOnly') }}</span>
            </span>
          </label>
        </div>
      </div>
    </div>

    <!-- ==================== ONGLET MES AMIS ==================== -->
    <div v-else class="ds-stack">
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
              @click="removeConfirmFriend = friend"
            >
              <Trash2 :size="14" aria-hidden="true" />
              {{ t('social.removeFriendBtn') }}
            </button>
          </div>
        </article>
      </div>

      <!-- Amis retirés (repliés par défaut, restauration en 1 clic) -->
      <details v-if="socialStore.removedFriends.length > 0" class="ds-card ds-accordion social-removed-accordion">
        <summary>
          {{ t('social.removedFriendsTitle', { count: socialStore.removedFriends.length }) }}
        </summary>
        <div class="ds-stack--sm social-removed-list">
          <div
            v-for="removed in socialStore.removedFriends"
            :key="removed.libraryId"
            class="ds-panel ds-row ds-row--between"
          >
            <div>
              <strong>{{ removed.ownerUsername || removed.libraryName }}</strong>
              <p class="ds-text-muted social-removed-meta">
                {{ t('social.booksSummary', { owned: removed.ownedCount, wish: removed.wishCount }) }}
              </p>
            </div>
            <button
              type="button"
              class="ds-btn ds-btn--sm"
              :disabled="restoringLibraryId === removed.libraryId"
              @click="handleRestoreFriend(removed.libraryId)"
            >
              <RotateCcw :size="14" aria-hidden="true" />
              {{ restoringLibraryId === removed.libraryId ? t('app.loading') : t('social.restoreFriendBtn') }}
            </button>
          </div>
        </div>
      </details>
    </div>

    <!-- Modale Ajouter un ami -->
    <BaseModal
      :open="addFriendModalOpen"
      :title="t('social.addFriendModalTitle')"
      max-width="440px"
      @close="addFriendModalOpen = false"
    >
      <form id="add-friend-modal-form" class="ds-stack" @submit.prevent="handleAddFriend">
        <p class="ds-text-muted">{{ t('social.addFriendModalDesc') }}</p>
        <input
          v-model="addFriendInput"
          type="text"
          class="ds-input"
          :placeholder="t('social.addFriendPlaceholder')"
          required
        />
      </form>
      <template #footer>
        <button type="button" class="ds-btn" :disabled="addingFriend" @click="addFriendModalOpen = false">
          {{ t('app.cancel') }}
        </button>
        <button
          type="submit"
          form="add-friend-modal-form"
          class="ds-btn ds-btn--primary"
          :disabled="addingFriend || !addFriendInput.trim()"
        >
          <UserPlus :size="15" aria-hidden="true" />
          {{ addingFriend ? t('app.loading') : t('social.addFriendBtn') }}
        </button>
      </template>
    </BaseModal>

    <!-- Modale Confirmation Retirer un ami -->
    <BaseModal
      :open="removeConfirmFriend !== null"
      :title="t('social.removeFriendConfirmTitle', { name: removeConfirmFriend?.ownerUsername || removeConfirmFriend?.libraryName || '' })"
      max-width="440px"
      @close="removeConfirmFriend = null"
    >
      <p>{{ t('social.removeFriendConfirmDesc') }}</p>
      <template #footer>
        <button type="button" class="ds-btn" :disabled="removingFriend" @click="removeConfirmFriend = null">
          {{ t('app.cancel') }}
        </button>
        <button type="button" class="ds-btn ds-btn--danger" :disabled="removingFriend" @click="confirmRemoveFriend">
          {{ removingFriend ? t('app.loading') : t('social.removeFriendBtn') }}
        </button>
      </template>
    </BaseModal>

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
.social-no-margin {
  margin: 0;
}

.social-expand-card {
  padding: var(--space-3) var(--space-4);
}

.social-expand-card__summary {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
  list-style: none;
}

.social-expand-card__summary::-webkit-details-marker {
  display: none;
}

.social-expand-card__icon {
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.social-expand-card__icon--accent {
  background: var(--accent);
  color: var(--accent-contrast);
}

.social-expand-card__head {
  flex: 1;
  min-inline-size: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.social-expand-card__head .ds-text-muted {
  font-size: 0.82rem;
}

.social-expand-card__chev {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.18s ease;
}

.social-expand-card[open] .social-expand-card__chev {
  transform: rotate(180deg);
}

.social-expand-card__body {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.social-join-card {
  border-color: var(--accent-border);
}

.social-policy-box {
  margin-top: var(--space-1);
}

.social-policy-title {
  font-size: 0.9rem;
}

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

.social-page-head {
  flex-wrap: nowrap;
  align-items: center;
}

.social-removed-accordion {
  padding: var(--space-3) var(--space-4);
}

.social-removed-list {
  margin-top: var(--space-3);
}

.social-removed-meta {
  margin: 2px 0 0;
  font-size: 0.82rem;
}
</style>
