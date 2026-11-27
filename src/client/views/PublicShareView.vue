<!-- src/client/views/PublicShareView.vue -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SharedLibraryBrowser from '../components/social/SharedLibraryBrowser.vue';
import { useAuthStore } from '../stores/auth.store';
import { useSocialStore, type SharedBookItem, type SharedLibraryData } from '../stores/social.store';
import { useUiStore } from '../stores/ui.store';
import { ApiClientError } from '../api/client';
import { t } from '../../shared/locales';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const socialStore = useSocialStore();
const uiStore = useUiStore();

const token = computed(() => String(route.params.token ?? ''));
const loading = ref(true);
const errorMsg = ref('');
const shared = ref<SharedLibraryData | null>(null);
const addingFriend = ref(false);

async function loadShared(): Promise<void> {
  if (!token.value) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    shared.value = await socialStore.fetchSharedLibrary(token.value);
  } catch (err) {
    shared.value = null;
    errorMsg.value = err instanceof ApiClientError ? err.message : t('social.sharedNotFound');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadShared();
});

watch(token, () => {
  void loadShared();
});

function handleUpdatedReservation(payload: { bookId: string; status: SharedBookItem['giftReservation'] }): void {
  if (!shared.value) return;
  const target = shared.value.books.find((b) => b.id === payload.bookId);
  if (target) {
    target.giftReservation = payload.status;
  }
}

async function handleFollowFriend(): Promise<void> {
  if (!token.value || !shared.value) return;
  addingFriend.value = true;
  try {
    await socialStore.addFriend(token.value);
    shared.value.alreadyFriend = true;
    uiStore.pushToast(t('social.friendAddedToast'), 'success');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    addingFriend.value = false;
  }
}

function goRegisterAndFollow(): void {
  void router.push({
    path: '/login',
    query: { friend: token.value, redirect: `/shared/${token.value}` }
  });
}
</script>

<template>
  <section class="ds-stack">
    <div v-if="loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</div>

    <div v-else-if="errorMsg || !shared" class="ds-card ds-stack">
      <div class="ds-banner ds-banner--danger" role="alert">
        {{ errorMsg || t('social.sharedNotFound') }}
      </div>
      <div class="ds-row">
        <router-link :to="authStore.isAuthenticated ? '/social' : '/login'" class="ds-btn ds-btn--primary">
          {{ authStore.isAuthenticated ? t('nav.social') : t('auth.loginTab') }}
        </router-link>
      </div>
    </div>

    <template v-else>
      <div class="ds-card ds-row ds-row--between share-header">
        <div class="ds-stack share-header__title">
          <div class="ds-row">
            <h1>{{ t('social.sharedByTitle', { name: shared.ownerUsername || shared.libraryName }) }}</h1>
            <span class="ds-badge ds-badge--accent">{{ t('social.readonlyBadge') }}</span>
          </div>
          <p class="ds-text-muted">{{ t('auth.iosInstallTip') }}</p>
        </div>

        <div class="ds-row">
          <template v-if="authStore.isAuthenticated">
            <span v-if="shared.alreadyFriend" class="ds-badge ds-badge--accent">
              {{ t('social.alreadyFriendBadge') }}
            </span>
            <button
              v-else-if="!shared.isOwnLibrary"
              type="button"
              class="ds-btn ds-btn--primary"
              :disabled="addingFriend"
              @click="handleFollowFriend"
            >
              {{ addingFriend ? t('app.loading') : t('social.addToMyFriendsBtn') }}
            </button>
          </template>

          <button v-else type="button" class="ds-btn ds-btn--primary" @click="goRegisterAndFollow">
            {{ t('social.createAccountAndFollowBtn') }}
          </button>
        </div>
      </div>

      <SharedLibraryBrowser
        :shared="shared"
        :token="token"
        @updated-reservation="handleUpdatedReservation"
      />
    </template>
  </section>
</template>

<style scoped>
.share-header {
  flex-wrap: wrap;
  gap: var(--space-3);
}

.share-header__title {
  gap: var(--space-1);
}
</style>
