<!-- src/client/views/SocialView.vue -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseModal from '../components/base/BaseModal.vue';
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
const familyUrl = computed(() => (familyCode.value ? `${origin.value}/login?invite=${encodeURIComponent(familyCode.value)}` : ''));
const friendUrl = computed(() => (friendCode.value ? `${origin.value}/shared/${encodeURIComponent(friendCode.value)}` : ''));

const joinCodeInput = ref('');
const joiningFamily = ref(false);
const addFriendInput = ref('');
const addingFriend = ref(false);

const regenTarget = ref<'family' | 'friend' | null>(null);
const regenBusy = ref(false);

onMounted(() => {
  void socialStore.fetchFriends();
});

async function copyText(text: string, toastKey: 'social.familyCodeCopied' | 'social.friendCodeCopied'): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    uiStore.pushToast(t(toastKey), 'success');
  } catch {
    uiStore.pushToast(t('app.retry'), 'warning');
  }
}

async function nativeShare(url: string, label: string, toastKey: 'social.familyCodeCopied' | 'social.friendCodeCopied'): Promise<void> {
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
    <h1>{{ t('social.title') }}</h1>

    <div class="ds-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'family' }"
        :aria-selected="activeTab === 'family'"
        @click="selectTab('family')"
      >
        {{ t('social.tabFamily') }}
      </button>
      <button
        type="button"
        role="tab"
        class="ds-tab"
        :class="{ 'ds-tab--active': activeTab === 'friends' }"
        :aria-selected="activeTab === 'friends'"
        @click="selectTab('friends')"
      >
        {{ t('social.tabFriends') }}
      </button>
    </div>

    <!-- Onglet Foyer & Liens -->
    <div v-if="activeTab === 'family'" class="ds-stack">
      <div class="ds-grid-2">
        <!-- Carte Foyer -->
        <div class="ds-card ds-stack">
          <h2>{{ t('social.familyCodeLabel') }}</h2>
          <p class="ds-text-muted">{{ t('social.familyCodeDesc') }}</p>

          <div class="social-qr-row">
            <QrCodeDisplay :value="familyUrl" :alt="t('social.familyCodeLabel')" />
            <div class="ds-stack social-code-col">
              <code class="social-code-pill">{{ familyCode }}</code>
              <div class="ds-row social-btn-wrap">
                <button
                  type="button"
                  class="ds-btn ds-btn--sm"
                  @click="copyText(familyCode, 'social.familyCodeCopied')"
                >
                  {{ t('social.copyCode') }}
                </button>
                <button
                  type="button"
                  class="ds-btn ds-btn--sm"
                  @click="copyText(familyUrl, 'social.familyCodeCopied')"
                >
                  {{ t('social.copyLink') }}
                </button>
                <button
                  type="button"
                  class="ds-btn ds-btn--sm ds-btn--primary"
                  @click="nativeShare(familyUrl, t('social.familyCodeLabel'), 'social.familyCodeCopied')"
                >
                  {{ t('social.shareBtn') }}
                </button>
              </div>
              <button
                type="button"
                class="ds-btn ds-btn--sm ds-btn--danger"
                @click="regenTarget = 'family'"
              >
                {{ t('social.regenerateCodeBtn') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Carte Vitrine Amis -->
        <div class="ds-card ds-stack">
          <h2>{{ t('social.friendCodeLabel') }}</h2>
          <p class="ds-text-muted">{{ t('social.friendCodeDesc') }}</p>

          <div class="social-qr-row">
            <QrCodeDisplay :value="friendUrl" :alt="t('social.friendCodeLabel')" />
            <div class="ds-stack social-code-col">
              <code class="social-code-pill">{{ friendCode }}</code>
              <div class="ds-row social-btn-wrap">
                <button
                  type="button"
                  class="ds-btn ds-btn--sm"
                  @click="copyText(friendCode, 'social.friendCodeCopied')"
                >
                  {{ t('social.copyCode') }}
                </button>
                <button
                  type="button"
                  class="ds-btn ds-btn--sm"
                  @click="copyText(friendUrl, 'social.friendCodeCopied')"
                >
                  {{ t('social.copyLink') }}
                </button>
                <button
                  type="button"
                  class="ds-btn ds-btn--sm ds-btn--primary"
                  @click="nativeShare(friendUrl, t('social.friendCodeLabel'), 'social.friendCodeCopied')"
                >
                  {{ t('social.shareBtn') }}
                </button>
              </div>
              <div class="ds-row social-btn-wrap">
                <router-link :to="`/shared/${friendCode}`" class="ds-btn ds-btn--sm">
                  {{ t('social.viewCollectionBtn') }}
                </router-link>
                <button
                  type="button"
                  class="ds-btn ds-btn--sm ds-btn--danger"
                  @click="regenTarget = 'friend'"
                >
                  {{ t('social.regenerateCodeBtn') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Membres du foyer -->
      <div class="ds-card ds-stack">
        <h2>{{ t('social.membersTitle', { count: authStore.profile?.library.members.length ?? 0 }) }}</h2>
        <div class="ds-stack">
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
      <details class="ds-card">
        <summary class="social-summary">{{ t('social.joinFamilyTitle') }}</summary>
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

    <!-- Onglet Mes Amis -->
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
              {{ t('social.viewCollectionBtn') }}
            </router-link>
            <button
              type="button"
              class="ds-btn ds-btn--sm ds-btn--danger"
              @click="handleRemoveFriend(friend.libraryId)"
            >
              {{ t('social.removeFriendBtn') }}
            </button>
          </div>
        </article>
      </div>
    </div>

    <BaseModal
      :open="regenTarget !== null"
      :title="t('social.regenerateCodeTitle')"
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
.social-qr-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  align-items: center;
}

.social-code-col {
  flex: 1;
  min-width: 180px;
}

.social-code-pill {
  display: inline-block;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.social-btn-wrap {
  flex-wrap: wrap;
}

.social-summary {
  font-weight: 600;
  cursor: pointer;
}

.social-inline-form {
  margin-top: var(--space-3);
}

.social-flex-input {
  flex: 1;
  min-width: 200px;
}
</style>
