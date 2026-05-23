<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { databaseService } from '../../core/database/database.service';
import { queueService } from '../../core/orchestrators/queue.orchestrator';
import BookMiniCard from '../components/BookMiniCard.vue';
import BaseHeader from '../components/BaseHeader.vue';
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

const isAllSelected = computed(() => {
  const targets = hydratedLoans.value;
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
        bookCached.loan = loan;
        temp.push({
          loan,
          book: bookCached
        });
      }
    }

    hydratedLoans.value = temp;
    selectedIds.value = [];
  } catch (e) {
    console.error("[LOANS VIEW] Échec d'hydratation du carnet :", e);
  } finally {
    isLoading.value = false;
  }
};

// 1. AGRÉGATION INSENSIBLE À LA CASSE, AUX ESPACES ET AUX ACCENTS
const loansByBorrower = computed(() => {
  const groups: Record<string, { friendName: string; list: HydratedLoan[] }> = {};

  hydratedLoans.value.forEach(item => {
    // FIX ACCENTS & MAJUSCULES : Décomposition NFD + purge des diacritiques combinés
    const key = item.loan.friendName
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    
    if (!groups[key]) {
      groups[key] = {
        friendName: item.loan.friendName,
        list: []
      };
    }
    groups[key].list.push(item);
  });

  return Object.values(groups).sort((a, b) => a.friendName.localeCompare(b.friendName));
});

// 2. LOGIQUE CHRONOLOGIQUE
const chronologicalLoans = computed(() => {
  return [...hydratedLoans.value].sort((a, b) => a.loan.loanDate - b.loan.loanDate);
});

const toggleBorrowerSection = (borrowerKey: string) => {
  expandedBorrowers.value[borrowerKey] = !expandedBorrowers.value[borrowerKey];
};

const handleToggleAll = (checked: boolean) => {
  if (!checked) {
    selectedIds.value = [];
  } else {
    selectedIds.value = hydratedLoans.value.map(item => item.loan.uri);
  }
};

const dispatchBatchAction = async (action: 'ADD_INVENTORY' | 'ADD_WISHLIST' | 'LEND' | 'RETURN') => {
  if (selectedIds.value.length === 0 || action !== 'RETURN') return;

  try {
    for (const uri of selectedIds.value) {
      await queueService.enqueueAction('RETURN', uri);
    }
    await fetchLoansRecords();
  } catch (e) {
    console.error("[LOANS BATCH ERROR]", e);
  }
};

const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString();
};

const resetSelection = () => {
  selectedIds.value = [];
};
</script>

<template>
  <div class="view-container">
    <BaseHeader :title="TEXTS.loansView?.title" showBack />

    <BatchActionBar 
      v-if="!isLoading"
      :model-value="isAllSelected"
      :selected-count="selectedIds.length"
      :is-mixed="false"
      context="lent"
      @update:model-value="handleToggleAll"
      @execute="dispatchBatchAction"
    />

    <div class="collection-modes-tabs" v-if="!isLoading">
      <button :class="['tab-button', { active: currentMode === 'borrower' }]" @click="currentMode = 'borrower'; resetSelection()">
        {{ TEXTS.loansView?.modeBorrower }}
      </button>
      <button :class="['tab-button', { active: currentMode === 'chrono' }]" @click="currentMode = 'chrono'; resetSelection()">
        {{ TEXTS.loansView?.modeChronological }}
      </button>
    </div>

    <BaseLoading v-if="isLoading" />

    <div class="series-list-container" v-else>
      <BaseBanner v-if="hydratedLoans.length === 0" type="error" :message="TEXTS.loansView?.emptyLoans" />

      <template v-else>
        <template v-if="currentMode === 'borrower'">
          <div 
            v-for="group in loansByBorrower" 
            :key="group.friendName" 
            class="loan-borrower-card"
          >
            <div class="loan-borrower-header" @click="toggleBorrowerSection(group.friendName.toLowerCase())">
              <span>👤 {{ group.friendName }}</span>
              <span>{{ group.list.length }} {{ TEXTS.loansView?.borrowedCount }} {{ expandedBorrowers[group.friendName.toLowerCase()] ? '▲' : '▼' }}</span>
            </div>

            <div class="loan-borrower-content" v-if="expandedBorrowers[group.friendName.toLowerCase()]">
              <div v-for="item in group.list" :key="item.loan.uri">
                <div class="loan-chrono-meta">
                  {{ TEXTS.loansView?.sinceLabel }} {{ formatDate(item.loan.loanDate) }}
                </div>
                <BookMiniCard 
                  :book="item.book"
                  :model-value="selectedIds.includes(item.loan.uri)"
                  @update:model-value="(val) => {
                    if(val) { if (!selectedIds.includes(item.loan.uri)) selectedIds.push(item.loan.uri); }
                    else selectedIds = selectedIds.filter(id => id !== item.loan.uri);
                  }"
                />
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <div v-for="item in chronologicalLoans" :key="item.loan.uri">
            <div class="loan-chrono-meta">
              ⏱️ {{ TEXTS.loansView?.friendLabel }} <strong>{{ item.loan.friendName }}</strong> — {{ TEXTS.loansView?.sinceLabel }} {{ formatDate(item.loan.loanDate) }}
            </div>
            <BookMiniCard 
              :book="item.book"
              :model-value="selectedIds.includes(item.loan.uri)"
              @update:model-value="(val) => {
                if(val) { if (!selectedIds.includes(item.loan.uri)) selectedIds.push(item.loan.uri); }
                else selectedIds = selectedIds.filter(id => id !== item.loan.uri);
              }"
            />
          </div>
        </template>
      </template>

    </div>
  </div>
</template>