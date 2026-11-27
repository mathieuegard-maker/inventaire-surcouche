<!-- src/client/views/FamilyDetachView.vue -->
<!-- Assistant mobile-first en 3 étapes pour détacher un membre (ou quitter le foyer) avec transfert sélectif de collection. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Layers,
  Search,
  Star,
  UserMinus
} from '@lucide/vue';
import {
  useSocialStore,
  type FamilyDetachBookItem,
  type FamilyDetachPreview
} from '../stores/social.store';
import { useUiStore } from '../stores/ui.store';
import { ApiClientError } from '../api/client';
import { normalizeTextKey } from '../../shared/bibliographic/text-normalize.util';
import { t } from '../../shared/locales';

const route = useRoute();
const router = useRouter();
const socialStore = useSocialStore();
const uiStore = useUiStore();

const loading = ref(true);
const loadError = ref('');
const submitting = ref(false);
const preview = ref<FamilyDetachPreview | null>(null);

const step = ref<1 | 2 | 3>(1);
const pickTab = ref<'series' | 'books' | 'wishlist'>('series');
const searchQuery = ref('');
const expandedSeriesKeys = ref<Set<string>>(new Set());

const selectedBookIds = ref<Set<string>>(new Set());
const transferMode = ref<'move' | 'copy'>('move');
const newLibraryName = ref('');
const keepAsFriends = ref(true);
const loanDecisions = ref<Record<string, 'transfer' | 'return' | 'skip'>>({});

const targetParam = computed(() =>
  typeof route.params.targetUserId === 'string' ? route.params.targetUserId : 'me'
);

async function loadPreview(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const data = await socialStore.fetchDetachPreview(targetParam.value);
    preview.value = data;
    selectedBookIds.value = new Set(data.preselectedBookIds);
    newLibraryName.value = data.defaultNewLibraryName;
    transferMode.value = 'move';
    keepAsFriends.value = true;
    loanDecisions.value = {};
    step.value = 1;
    pickTab.value = data.canTransferOwned ? 'series' : 'wishlist';
  } catch (err) {
    preview.value = null;
    loadError.value = err instanceof ApiClientError ? err.message : t('app.retry');
  } finally {
    loading.value = false;
  }
}

watch(targetParam, () => {
  void loadPreview();
}, { immediate: true });

const pageTitle = computed(() => {
  if (!preview.value) return t('social.title');
  return preview.value.isSelfDetach
    ? t('social.detachSelfPageTitle', { library: preview.value.libraryName })
    : t('social.detachPageTitle', { name: preview.value.targetMember.username });
});

const needle = computed(() => normalizeTextKey(searchQuery.value));

function matchesSearch(b: FamilyDetachBookItem): boolean {
  if (!needle.value) return true;
  const hay = normalizeTextKey(`${b.title} ${b.seriesName ?? ''} ${b.authors.join(' ')}`);
  return hay.includes(needle.value);
}

const ownedBooks = computed(() =>
  (preview.value?.books ?? []).filter((b) => b.ownershipStatus === 'owned')
);
const wishBooks = computed(() =>
  (preview.value?.books ?? []).filter((b) => b.ownershipStatus === 'wish')
);

const filteredOwnedBooks = computed(() =>
  ownedBooks.value
    .filter(matchesSearch)
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'))
);

const filteredWishBooks = computed(() =>
  wishBooks.value
    .filter(matchesSearch)
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'))
);

interface SeriesDetachGroup {
  key: string;
  seriesName: string;
  books: FamilyDetachBookItem[];
  selectedCount: number;
}

const ownedSeriesGroups = computed<SeriesDetachGroup[]>(() => {
  const map = new Map<string, { seriesName: string; books: FamilyDetachBookItem[] }>();
  for (const b of ownedBooks.value) {
    if (!b.seriesId && !b.seriesName) continue;
    const key = b.seriesId ?? normalizeTextKey(b.seriesName ?? '');
    const name = b.seriesName ?? '';
    let grp = map.get(key);
    if (!grp) {
      grp = { seriesName: name, books: [] };
      map.set(key, grp);
    }
    grp.books.push(b);
  }
  const out: SeriesDetachGroup[] = [];
  for (const [key, grp] of map.entries()) {
    const matchesGroup =
      !needle.value ||
      normalizeTextKey(grp.seriesName).includes(needle.value) ||
      grp.books.some(matchesSearch);
    if (!matchesGroup) continue;
    const sorted = [...grp.books].sort(
      (a, b) => (a.volumeNumber ?? 9999) - (b.volumeNumber ?? 9999) || a.title.localeCompare(b.title, 'fr')
    );
    const selectedCount = sorted.filter((b) => selectedBookIds.value.has(b.id)).length;
    out.push({ key, seriesName: grp.seriesName, books: sorted, selectedCount });
  }
  return out.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'fr'));
});

const targetMemberWishBooks = computed(() => {
  const uid = preview.value?.targetMember.userId;
  if (!uid) return [];
  return wishBooks.value.filter((b) => b.wishedByUserId === uid);
});

const selectedOwnedBooks = computed(() =>
  ownedBooks.value.filter((b) => selectedBookIds.value.has(b.id))
);
const selectedWishBooks = computed(() =>
  wishBooks.value.filter((b) => selectedBookIds.value.has(b.id))
);
const selectedLentBooks = computed(() =>
  selectedOwnedBooks.value.filter((b) => Boolean(b.activeLoan))
);

const effectiveTransferredOwnedCount = computed(() => {
  if (transferMode.value === 'copy') return selectedOwnedBooks.value.length;
  return selectedOwnedBooks.value.filter((b) => {
    if (!b.activeLoan) return true;
    return (loanDecisions.value[b.id] ?? 'transfer') !== 'skip';
  }).length;
});

const remainingOwnedInOldLib = computed(() => {
  if (transferMode.value === 'copy') return ownedBooks.value.length;
  return Math.max(0, ownedBooks.value.length - effectiveTransferredOwnedCount.value);
});

function toggleBook(bookId: string): void {
  const next = new Set(selectedBookIds.value);
  if (next.has(bookId)) next.delete(bookId);
  else next.add(bookId);
  selectedBookIds.value = next;
}

function toggleSeriesGroup(grp: SeriesDetachGroup): void {
  const next = new Set(selectedBookIds.value);
  const allSelected = grp.selectedCount === grp.books.length;
  if (allSelected) {
    for (const b of grp.books) next.delete(b.id);
  } else {
    for (const b of grp.books) next.add(b.id);
  }
  selectedBookIds.value = next;
}

function toggleSeriesExpand(key: string): void {
  const next = new Set(expandedSeriesKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedSeriesKeys.value = next;
}

function selectAllMemberWishes(): void {
  const next = new Set(selectedBookIds.value);
  for (const b of targetMemberWishBooks.value) {
    next.add(b.id);
  }
  selectedBookIds.value = next;
}

function getLoanDecision(bookId: string): 'transfer' | 'return' | 'skip' {
  return loanDecisions.value[bookId] ?? 'transfer';
}

function setLoanDecision(bookId: string, decision: 'transfer' | 'return' | 'skip'): void {
  loanDecisions.value = { ...loanDecisions.value, [bookId]: decision };
}

async function confirmDetach(): Promise<void> {
  if (!preview.value || submitting.value) return;
  submitting.value = true;
  try {
    const res = await socialStore.detachFamilyMember({
      targetUserId: preview.value.targetMember.userId,
      mode: transferMode.value,
      bookIds: Array.from(selectedBookIds.value),
      loanDecisions: loanDecisions.value,
      keepAsFriends: keepAsFriends.value,
      newLibraryName: newLibraryName.value.trim() || preview.value.defaultNewLibraryName
    });
    uiStore.pushToast(
      res.selfDetached
        ? t('social.detachSelfSuccessToast', { library: res.newLibraryName })
        : t('social.detachSuccessToast', {
            name: res.targetUsername,
            owned: res.transferredOwnedCount,
            wish: res.transferredWishCount
          }),
      'success',
      4500
    );
    await router.replace(res.selfDetached ? '/dashboard' : '/social');
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="ds-stack">
    <div class="ds-page-head">
      <h1>{{ pageTitle }}</h1>
      <router-link to="/social" class="ds-btn ds-btn--ghost ds-btn--sm">
        <ArrowLeft :size="15" aria-hidden="true" />
        {{ t('app.cancel') }}
      </router-link>
    </div>

    <p v-if="loading" class="ds-card ds-text-muted">{{ t('app.loading') }}</p>

    <div v-else-if="loadError || !preview" class="ds-card ds-stack">
      <div class="ds-banner ds-banner--danger" role="alert">{{ loadError || t('app.retry') }}</div>
      <div>
        <router-link to="/social" class="ds-btn">{{ t('app.back') }}</router-link>
      </div>
    </div>

    <template v-else>
      <!-- Fil d'étapes 1 / 2 / 3 -->
      <div class="detach-stepper" role="navigation" aria-label="Étapes">
        <button
          type="button"
          class="detach-step"
          :class="{ 'detach-step--active': step === 1, 'detach-step--done': step > 1 }"
          @click="step = 1"
        >
          {{ t('social.detachStep1Title') }}
        </button>
        <button
          type="button"
          class="detach-step"
          :class="{ 'detach-step--active': step === 2, 'detach-step--done': step > 2 }"
          @click="step = 2"
        >
          {{ t('social.detachStep2Title') }}
        </button>
        <button
          type="button"
          class="detach-step"
          :class="{ 'detach-step--active': step === 3 }"
          @click="step = 3"
        >
          {{ t('social.detachStep3Title') }}
        </button>
      </div>

      <!-- ==================== ÉTAPE 1 : SÉLECTION DES OUVRAGES ==================== -->
      <div v-if="step === 1" class="ds-stack">
        <div v-if="!preview.canTransferOwned" class="ds-banner ds-banner--warning" role="status">
          {{ t('social.detachOwnerOnlyBanner') }}
        </div>

        <div class="ds-card ds-stack--sm">
          <div class="detach-search-wrap">
            <Search :size="16" class="detach-search-icon" aria-hidden="true" />
            <input
              v-model="searchQuery"
              type="search"
              class="ds-input detach-search-input"
              :placeholder="t('social.detachSearchPlaceholder')"
            />
          </div>

          <div v-if="preview.canTransferOwned" class="ds-segmented" role="tablist">
            <button
              type="button"
              role="tab"
              class="ds-segmented__btn"
              :class="{ 'ds-segmented__btn--active': pickTab === 'series' }"
              @click="pickTab = 'series'"
            >
              {{ t('social.detachTabSeries', { count: ownedSeriesGroups.length }) }}
            </button>
            <button
              type="button"
              role="tab"
              class="ds-segmented__btn"
              :class="{ 'ds-segmented__btn--active': pickTab === 'books' }"
              @click="pickTab = 'books'"
            >
              {{ t('social.detachTabBooks', { count: filteredOwnedBooks.length }) }}
            </button>
            <button
              type="button"
              role="tab"
              class="ds-segmented__btn"
              :class="{ 'ds-segmented__btn--active': pickTab === 'wishlist' }"
              @click="pickTab = 'wishlist'"
            >
              {{ t('social.detachTabWishlist', { count: filteredWishBooks.length }) }}
            </button>
          </div>
        </div>

        <!-- Onglet Séries (1 clic = toute la série + possibilité d'affiner tome par tome) -->
        <div v-if="preview.canTransferOwned && pickTab === 'series'" class="ds-stack--sm">
          <p v-if="ownedSeriesGroups.length === 0" class="ds-card ds-text-muted">
            {{ t('social.detachNoBooksInTab') }}
          </p>

          <article v-for="grp in ownedSeriesGroups" :key="grp.key" class="ds-card ds-stack--sm detach-series-card">
            <div class="ds-row ds-row--between">
              <label class="ds-checkbox detach-series-check">
                <input
                  type="checkbox"
                  :checked="grp.selectedCount === grp.books.length && grp.books.length > 0"
                  :indeterminate="grp.selectedCount > 0 && grp.selectedCount < grp.books.length"
                  @change="toggleSeriesGroup(grp)"
                />
                <Layers :size="16" aria-hidden="true" />
                <strong>{{ grp.seriesName }}</strong>
              </label>

              <button
                type="button"
                class="ds-btn ds-btn--ghost ds-btn--sm"
                @click="toggleSeriesExpand(grp.key)"
              >
                <span>{{ t('social.detachSeriesVolumesToggle', { selected: grp.selectedCount, total: grp.books.length }) }}</span>
                <ChevronUp v-if="expandedSeriesKeys.has(grp.key)" :size="15" aria-hidden="true" />
                <ChevronDown v-else :size="15" aria-hidden="true" />
              </button>
            </div>

            <div v-if="expandedSeriesKeys.has(grp.key)" class="ds-stack--sm detach-series-vols">
              <label
                v-for="b in grp.books"
                :key="b.id"
                class="ds-panel detach-book-row"
              >
                <input
                  type="checkbox"
                  :checked="selectedBookIds.has(b.id)"
                  @change="toggleBook(b.id)"
                />
                <span class="detach-book-row__cover">
                  <img v-if="b.coverUrl" :src="b.coverUrl" :alt="b.title" loading="lazy" />
                  <span v-else>{{ b.title.slice(0, 2).toUpperCase() }}</span>
                </span>
                <span class="detach-book-row__info">
                  <strong>
                    <template v-if="b.volumeLabel">T.{{ b.volumeLabel }} · </template>
                    {{ b.title }}
                  </strong>
                  <span class="ds-text-muted">
                    {{ b.authors.join(', ') || t('app.unknownAuthor') }}
                    <template v-if="b.activeLoan"> · {{ t('loans.lentTo', { name: b.activeLoan.borrowerName }) }}</template>
                  </span>
                </span>
              </label>
            </div>
          </article>
        </div>

        <!-- Onglet Livres & One-shots -->
        <div v-else-if="preview.canTransferOwned && pickTab === 'books'" class="ds-stack--sm">
          <p v-if="filteredOwnedBooks.length === 0" class="ds-card ds-text-muted">
            {{ t('social.detachNoBooksInTab') }}
          </p>
          <label
            v-for="b in filteredOwnedBooks"
            :key="b.id"
            class="ds-card detach-book-row"
          >
            <input
              type="checkbox"
              :checked="selectedBookIds.has(b.id)"
              @change="toggleBook(b.id)"
            />
            <span class="detach-book-row__cover">
              <img v-if="b.coverUrl" :src="b.coverUrl" :alt="b.title" loading="lazy" />
              <span v-else>{{ b.title.slice(0, 2).toUpperCase() }}</span>
            </span>
            <span class="detach-book-row__info">
              <strong>{{ b.title }}</strong>
              <span class="ds-text-muted">
                <template v-if="b.seriesName">{{ b.seriesName }}<template v-if="b.volumeLabel"> T.{{ b.volumeLabel }}</template> · </template>
                {{ b.authors.join(', ') || t('app.unknownAuthor') }}
              </span>
              <span v-if="b.activeLoan" class="ds-badge ds-badge--accent">
                {{ t('loans.lentTo', { name: b.activeLoan.borrowerName }) }}
              </span>
            </span>
          </label>
        </div>

        <!-- Onglet Wishlist -->
        <div v-else class="ds-stack--sm">
          <div v-if="targetMemberWishBooks.length > 0" class="ds-row">
            <button type="button" class="ds-btn ds-btn--soft ds-btn--sm" @click="selectAllMemberWishes">
              <Star :size="14" aria-hidden="true" />
              {{
                t('social.detachSelectAllMemberWishesBtn', {
                  count: targetMemberWishBooks.length,
                  name: preview.targetMember.username
                })
              }}
            </button>
          </div>

          <p v-if="filteredWishBooks.length === 0" class="ds-card ds-text-muted">
            {{ t('social.detachNoBooksInTab') }}
          </p>
          <label
            v-for="b in filteredWishBooks"
            :key="b.id"
            class="ds-card detach-book-row"
          >
            <input
              type="checkbox"
              :checked="selectedBookIds.has(b.id)"
              @change="toggleBook(b.id)"
            />
            <span class="detach-book-row__cover">
              <img v-if="b.coverUrl" :src="b.coverUrl" :alt="b.title" loading="lazy" />
              <span v-else>{{ b.title.slice(0, 2).toUpperCase() }}</span>
            </span>
            <span class="detach-book-row__info">
              <strong>{{ b.title }}</strong>
              <span class="ds-text-muted">
                {{ b.authors.join(', ') || t('app.unknownAuthor') }}
                <template v-if="b.wishedByName"> · {{ t('wishlist.wishedBy', { name: b.wishedByName }) }}</template>
              </span>
            </span>
          </label>
        </div>

        <!-- Barre récapitulative étape 1 -->
        <div class="ds-card ds-row ds-row--between detach-footer-bar">
          <strong>
            {{
              t('social.detachSelectedSummary', {
                owned: selectedOwnedBooks.length,
                wish: selectedWishBooks.length
              })
            }}
          </strong>
          <button type="button" class="ds-btn ds-btn--primary" @click="step = 2">
            <span>{{ t('social.detachStepNextBtn') }}</span>
            <ArrowRight :size="16" aria-hidden="true" />
          </button>
        </div>
      </div>

      <!-- ==================== ÉTAPE 2 : RÈGLES DU DÉPART ==================== -->
      <div v-else-if="step === 2" class="ds-stack">
        <div v-if="preview.willTransferOwnershipTo" class="ds-banner ds-banner--warning" role="status">
          {{
            t('social.detachOwnershipSuccessionNotice', {
              nextOwner: preview.willTransferOwnershipTo.username
            })
          }}
        </div>

        <div class="ds-card ds-stack">
          <div class="ds-field">
            <label class="ds-label" for="detach-new-lib-name">
              {{ t('social.detachNewLibraryNameLabel', { name: preview.targetMember.username }) }}
            </label>
            <input
              id="detach-new-lib-name"
              v-model="newLibraryName"
              type="text"
              class="ds-input"
              maxlength="80"
            />
          </div>

          <div v-if="selectedBookIds.size > 0" class="ds-stack--sm">
            <strong class="ds-label">{{ t('social.detachModeLabel') }}</strong>
            <label class="ds-radio-option">
              <input v-model="transferMode" type="radio" value="move" />
              <span class="ds-radio-option__body">
                <span>{{ t('social.detachModeMove') }}</span>
              </span>
            </label>
            <label class="ds-radio-option">
              <input v-model="transferMode" type="radio" value="copy" />
              <span class="ds-radio-option__body">
                <span>{{ t('social.detachModeCopy') }}</span>
              </span>
            </label>
          </div>

          <label class="ds-checkbox">
            <input v-model="keepAsFriends" type="checkbox" />
            <span>{{ t('social.detachKeepFriendsLabel') }}</span>
          </label>
        </div>

        <!-- Gestion des prêts en cours sur les livres déplacés -->
        <div v-if="transferMode === 'move' && selectedLentBooks.length > 0" class="ds-card ds-stack">
          <div class="ds-row">
            <AlertTriangle :size="18" aria-hidden="true" />
            <h2>{{ t('social.detachLoansWarningTitle', { count: selectedLentBooks.length }) }}</h2>
          </div>
          <p class="ds-text-muted">{{ t('social.detachLoansWarningDesc') }}</p>

          <div class="ds-stack--sm">
            <div v-for="lentBook in selectedLentBooks" :key="lentBook.id" class="ds-panel ds-stack--sm">
              <div>
                <strong>{{ lentBook.title }}</strong>
                <p class="ds-text-muted">
                  {{ t('loans.lentTo', { name: lentBook.activeLoan?.borrowerName ?? '' }) }}
                </p>
              </div>
              <select
                class="ds-input"
                :value="getLoanDecision(lentBook.id)"
                @change="setLoanDecision(lentBook.id, ($event.target as HTMLSelectElement).value as 'transfer' | 'return' | 'skip')"
              >
                <option value="transfer">{{ t('social.detachLoanTransfer') }}</option>
                <option value="return">{{ t('social.detachLoanReturn') }}</option>
                <option value="skip">{{ t('social.detachLoanSkip') }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="ds-card ds-row ds-row--between detach-footer-bar">
          <button type="button" class="ds-btn" @click="step = 1">
            <ArrowLeft :size="15" aria-hidden="true" />
            {{ t('social.detachStepPrevBtn') }}
          </button>
          <button type="button" class="ds-btn ds-btn--primary" @click="step = 3">
            <span>{{ t('social.detachStepNextBtn') }}</span>
            <ArrowRight :size="16" aria-hidden="true" />
          </button>
        </div>
      </div>

      <!-- ==================== ÉTAPE 3 : RÉCAPITULATIF & CONFIRMATION ==================== -->
      <div v-else class="ds-stack">
        <div class="ds-card ds-stack">
          <h2>{{ t('social.detachStep3Title') }}</h2>

          <p v-if="selectedBookIds.size === 0" class="ds-banner ds-banner--warning">
            {{ t('social.detachEmptySelectionHint') }}
          </p>

          <dl class="detach-summary-list">
            <div class="detach-summary-row">
              <dt>{{ t('social.detachReviewWho') }}</dt>
              <dd><strong>{{ preview.targetMember.username }}</strong></dd>
            </div>
            <div class="detach-summary-row">
              <dt>{{ t('social.detachReviewNewLibrary') }}</dt>
              <dd><strong>{{ newLibraryName.trim() || preview.defaultNewLibraryName }}</strong></dd>
            </div>
            <div class="detach-summary-row">
              <dt>{{ t('social.detachReviewMode') }}</dt>
              <dd>
                {{
                  transferMode === 'move'
                    ? t('social.detachReviewModeMoveShort')
                    : t('social.detachReviewModeCopyShort')
                }}
              </dd>
            </div>
            <div class="detach-summary-row">
              <dt>{{ t('social.detachReviewCounts') }}</dt>
              <dd>
                <strong>
                  {{
                    t('social.detachSelectedSummary', {
                      owned: effectiveTransferredOwnedCount,
                      wish: selectedWishBooks.length
                    })
                  }}
                </strong>
              </dd>
            </div>
            <div class="detach-summary-row">
              <dt>{{ t('social.detachReviewRemaining') }}</dt>
              <dd>{{ t('collection.booksCount', { count: remainingOwnedInOldLib }) }}</dd>
            </div>
            <div class="detach-summary-row">
              <dt>{{ t('social.detachReviewFriends') }}</dt>
              <dd>{{ keepAsFriends ? t('app.yes') : t('app.no') }}</dd>
            </div>
          </dl>
        </div>

        <div class="ds-card ds-row ds-row--between detach-footer-bar">
          <button type="button" class="ds-btn" :disabled="submitting" @click="step = 2">
            <ArrowLeft :size="15" aria-hidden="true" />
            {{ t('social.detachStepPrevBtn') }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--primary"
            :disabled="submitting"
            @click="confirmDetach"
          >
            <Check v-if="!submitting" :size="16" aria-hidden="true" />
            <UserMinus v-else :size="16" aria-hidden="true" />
            {{ submitting ? t('app.loading') : t('social.detachConfirmBtn') }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.detach-stepper {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-2);
}

@media (min-width: 640px) {
  .detach-stepper {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.detach-step {
  padding: 0.55rem 0.75rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 0.84rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.detach-step--done {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.detach-step--active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.detach-search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.detach-search-icon {
  position: absolute;
  left: 12px;
  color: var(--text-muted);
  pointer-events: none;
}

.detach-search-input {
  padding-left: 36px;
}

.detach-series-card {
  padding: var(--space-3) var(--space-4);
}

.detach-series-check {
  flex: 1;
  min-inline-size: 0;
}

.detach-series-vols {
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

.detach-book-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
}

.detach-book-row input[type='checkbox'] {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  accent-color: var(--accent);
}

.detach-book-row__cover {
  width: 40px;
  min-width: 40px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-muted);
}

.detach-book-row__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.detach-book-row__info {
  flex: 1;
  min-inline-size: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.detach-footer-bar {
  flex-wrap: wrap;
  gap: var(--space-3);
}

.detach-summary-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.detach-summary-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

.detach-summary-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.detach-summary-row dt {
  color: var(--text-muted);
  font-size: 0.88rem;
}

.detach-summary-row dd {
  margin: 0;
  font-size: 0.92rem;
  text-align: right;
}
</style>
