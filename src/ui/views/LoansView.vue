 <script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { databaseService } from '../../core/database/database.service';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import WireframeTable from '../components/WireframeTable.vue';
import WireframePagination from '../components/WireframePagination.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import { TEXTS } from '../locales/fr';
import type { LoanRecord, HumanizedBook } from '../../core/types';

interface HydratedLoan {
  loan: LoanRecord;
  book: HumanizedBook;
}

const hydratedLoans = ref<HydratedLoan[]>([]);
const selectedIds = ref<string[]>([]);
const isLoading = ref(true);

const currentMode = ref<'borrower' | 'chrono'>('borrower');
const expandedBorrowers = ref<Record<string, boolean>>({});

// Liste segmentée et filtrée en temps réel par le paginateur
const displayedLoans = ref<any[]>([]);

const isAllSelected = computed(() => {
  const targets = filteredLoansSource.value;
  return targets.length > 0 && selectedIds.value.length === targets.length;
});

onMounted(async () => {
  await fetchLoansRecords();
});

const fetchLoansRecords = async () => {
  isLoading.value = true;
  try {
    const localLoans = await databaseService.getAllLoans();
    const temp: HydratedLoan[] = [];

    for (const loan of localLoans) {
      const bookCached = await databaseService.getBookFromCache(loan.uri);
      if (bookCached) {
        temp.push({ loan, book: bookCached });
      }
    }
    hydratedLoans.value = temp;
    selectedIds.value = [];
    
    // Initialise l'ouverture automatique des volets d'emprunteurs au démarrage
    const initialExpanded: Record<string, boolean> = {};
    temp.forEach(item => {
      if (item.loan.friendName) {
        initialExpanded[item.loan.friendName] = true;
      }
    });
    expandedBorrowers.value = initialExpanded;
  } catch (e) {
    console.error("[LOANS VIEW ERROR] Échec de rafraîchissement :", e);
  } finally {
    isLoading.value = false;
  }
};

/**
 * SOURCE DES PRÊTS TRIÉE : Alimentation brute du paginateur selon le mode
 */
const filteredLoansSource = computed(() => {
  const list = [...hydratedLoans.value];
  if (currentMode.value === 'chrono') {
    return list.sort((a, b) => (b.loan.loanDate || 0) - (a.loan.loanDate || 0));
  }
  return list.sort((a, b) => (a.loan.friendName || '').localeCompare(b.loan.friendName || ''));
});

const enrichLoansForPagination = computed(() => {
  return filteredLoansSource.value.map(item => ({
    ...item,
    searchTitle: item.book.title || '',
    searchFriend: item.loan.friendName || '',
    searchSeries: item.book.series || '',
    searchAuthors: item.book.authors || []
  }));
});

const translateFriendName = (name?: string): string => {
  if (!name) return TEXTS.loansView?.unknownFriend || 'Inconnu';
  if (name === 'Inconnu') return TEXTS.loansView?.unknownFriend || 'Inconnu';
  if (name === 'Inconnu (Ajout web)') return TEXTS.loansView?.unknownFriendWeb || 'Inconnu (Ajout web)';
  if (name === 'Inconnu (Restauration)') return TEXTS.loansView?.unknownFriendRestored || 'Inconnu (Restauration)';
  return name;
};

/**
 * RE-GROUPEMENT POST-PAGINATION (Mode Emprunteur)
 * Reconstruit les fiches d'amis uniquement sur la tranche visible à l'écran
 */
const borrowerGroups = computed(() => {
  const groups: Record<string, any[]> = {};
  
  displayedLoans.value.forEach(item => {
    const name = translateFriendName(item.loan.friendName);
    if (!groups[name]) groups[name] = [];
    groups[name].push(item);
  });
  
  return Object.keys(groups).map(name => ({
    friendName: name,
    list: groups[name]
  })).sort((a, b) => a.friendName.localeCompare(b.friendName));
});

const handleToggleAll = (checked: boolean) => {
  if (!checked) {
    selectedIds.value = [];
  } else {
    selectedIds.value = filteredLoansSource.value.map(item => item.loan.uri);
  }
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN') => {
  if (selectedIds.value.length === 0) return;
  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction(action, uri);
    }
    await fetchLoansRecords();
  } catch (e) {
    console.error(e);
  }
};

const toggleBorrower = (name: string) => {
  expandedBorrowers.value[name] = !expandedBorrowers.value[name];
};

const formatDate = (timestamp?: number): string => {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
};

const resetSelection = () => {
  selectedIds.value = [];
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle :text="TEXTS.loansView?.title" level="h2" />

    <div class="collection-modes-tabs">
      <button :class="['tab-button', { active: currentMode === 'borrower' }]" @click="currentMode = 'borrower'; resetSelection()">
        {{ TEXTS.loansView?.modeBorrower }}
      </button>
      <button :class="['tab-button', { active: currentMode === 'chrono' }]" @click="currentMode = 'chrono'; resetSelection()">
        {{ TEXTS.loansView?.modeChronological }}
      </button>
    </div>

    <WireframePagination
      v-if="!isLoading"
      :items="enrichLoansForPagination"
      :searchKeys="['searchTitle', 'searchFriend', 'searchSeries', 'searchAuthors']"
      :hasSelectAll="true"
      :selectAllValue="isAllSelected"
      :selectedCount="selectedIds.length"
      @update:selectAllValue="handleToggleAll"
      @update:processedItems="(val) => displayedLoans = val"
    />

    <BatchActionBar 
      v-if="!isLoading"
      :selected-count="selectedIds.length"
      :is-mixed="false"
      context="lent"
      @execute="dispatchBatchAction"
    />

    <BaseLoading v-if="isLoading" />

    <div class="main-content-wrapper" v-else>
      <BaseBanner v-if="hydratedLoans.length === 0" type="error" :message="TEXTS.loansView?.emptyLoans" />

      <template v-else>
        <template v-if="currentMode === 'borrower'">
          <div v-for="group in borrowerGroups" :key="group.friendName" class="loan-borrower-card">
            <div class="loan-borrower-header" @click="toggleBorrower(group.friendName)">
              <span>👤 {{ group.friendName }}</span>
              <span>{{ group.list.length }} {{ TEXTS.loansView?.borrowedCount }} {{ expandedBorrowers[group.friendName] ? '[ - ]' : '[ + ]' }}</span>
            </div>
            
            <div v-if="expandedBorrowers[group.friendName]" class="loan-borrower-content" style="padding: 0;">
              <WireframeTable style="margin-bottom: 0; border: none !important;">
                <div v-for="item in group.list" :key="item.loan.uri" style="position: relative;">
                  <div class="loan-chrono-meta" style="padding: var(--spacing-sm) var(--spacing-md); margin: 0; border-bottom: var(--border-width) solid var(--color-border);">
                    {{ TEXTS.loansView?.sinceLabel }} {{ formatDate(item.loan.loanDate) }}
                  </div>
                  <BookMiniCard 
                    :book="item.book"
                    :model-value="selectedIds.includes(item.loan.uri)"
                    style="border: none !important;"
                    @update:model-value="(val) => {
                      if (val) {
                        if (!selectedIds.includes(item.loan.uri)) selectedIds.push(item.loan.uri);
                      } else {
                        const idx = selectedIds.indexOf(item.loan.uri);
                        if (idx > -1) selectedIds.splice(idx, 1);
                      }
                    }"
                  />
                </div>
              </WireframeTable>
            </div>
          </div>
        </template>

        <template v-else>
          <WireframeTable>
            <div v-for="item in displayedLoans" :key="item.loan.uri" style="position: relative;">
              <div class="loan-chrono-meta" style="padding: var(--spacing-sm) var(--spacing-md); margin: 0; border-bottom: var(--border-width) solid var(--color-border);">
                ⏱️ {{ TEXTS.loansView?.friendLabel }} <strong>{{ translateFriendName(item.loan.friendName) }}</strong> — {{ TEXTS.loansView?.sinceLabel }} {{ formatDate(item.loan.loanDate) }}
              </div>
              <BookMiniCard 
                :book="item.book"
                :model-value="selectedIds.includes(item.loan.uri)"
                style="border: none !important;"
                @update:model-value="(val) => {
                  if (val) {
                    if (!selectedIds.includes(item.loan.uri)) selectedIds.push(item.loan.uri);
                  } else {
                    const idx = selectedIds.indexOf(item.loan.uri);
                    if (idx > -1) selectedIds.splice(idx, 1);
                  }
                }"
              />
            </div>
          </WireframeTable>
        </template>
      </template>
    </div>
  </div>
</template>