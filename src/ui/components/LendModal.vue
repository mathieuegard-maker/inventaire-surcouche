<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { TEXTS } from '../locales/fr';
import { userService, type LoanContact } from '../../core/services/user.service';

const LOCAL_CONTACTS_KEY = 'biblio_loan_contacts_v1';

const props = defineProps<{
  show: boolean;
  bookCount: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', friendName: string): void;
}>();

const friendName = ref('');
const contacts = ref<LoanContact[]>([]);
const loadingContacts = ref(false);

const readLocalContacts = (): LoanContact[] => {
  try {
    const raw = localStorage.getItem(LOCAL_CONTACTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeLocalContacts = (list: LoanContact[]) => {
  try {
    localStorage.setItem(LOCAL_CONTACTS_KEY, JSON.stringify(list));
  } catch {
    // Stockage local indisponible
  }
};

const mergeContacts = (remote: LoanContact[], local: LoanContact[]): LoanContact[] => {
  const map = new Map<string, LoanContact>();
  const add = (c: LoanContact) => {
    const clean = String(c?.name || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    const existing = map.get(key);
    if (!existing || (c.source === 'friend_share' && existing.source !== 'friend_share')) {
      map.set(key, { name: clean, source: c.source === 'friend_share' ? 'friend_share' : 'borrower' });
    }
  };
  for (const c of local) add(c);
  for (const c of remote) add(c);

  return Array.from(map.values()).sort((a, b) => {
    if (a.source !== b.source) return a.source === 'friend_share' ? -1 : 1;
    return a.name.localeCompare(b.name, 'fr');
  });
};

const loadContacts = async () => {
  const cached = readLocalContacts();
  contacts.value = cached;
  loadingContacts.value = true;
  try {
    const remote = await userService.listLoanContacts();
    const merged = mergeContacts(remote, cached);
    contacts.value = merged;
    if (remote.length > 0) {
      writeLocalContacts(merged);
    }
  } catch {
    // Hors ligne : on garde le cache local
  } finally {
    loadingContacts.value = false;
  }
};

watch(
  () => props.show,
  (isOpen) => {
    if (isOpen) {
      friendName.value = '';
      loadContacts();
    }
  },
  { immediate: true }
);

const normalizedInput = computed(() => friendName.value.trim().toLowerCase());

const selectContact = (name: string) => {
  friendName.value = name;
};

const handleConfirm = () => {
  const clean = friendName.value.trim();
  if (!clean) return;

  const updated = mergeContacts(contacts.value, [{ name: clean, source: 'borrower' }]);
  contacts.value = updated;
  writeLocalContacts(updated);

  emit('confirm', clean);
  friendName.value = '';
};

const handleClose = () => {
  emit('close');
  friendName.value = '';
};
</script>

<template>
  <div v-if="show" class="modal-overlay" @click.self="handleClose">
    <div class="modal-box">
      <h2>{{ TEXTS.lendModal.title }}</h2>
      <p class="modal-text">
        {{ bookCount > 1 ? TEXTS.lendModal.instructionPlural : TEXTS.lendModal.instructionSingular }}
      </p>

      <!-- Liste rapide : amis connus par partage + anciens emprunteurs -->
      <div v-if="contacts.length > 0 || loadingContacts" class="contacts-picker">
        <span class="picker-label">
          Choisir une personne connue :
          <small v-if="loadingContacts" class="loading-tag">(mise à jour...)</small>
        </span>
        <div class="contacts-chips">
          <button
            v-for="c in contacts"
            :key="c.name.toLowerCase()"
            type="button"
            :class="[
              'contact-chip',
              c.source === 'friend_share' ? 'is-friend' : 'is-borrower',
              { selected: normalizedInput === c.name.toLowerCase() }
            ]"
            @click="selectContact(c.name)"
          >
            {{ c.source === 'friend_share' ? '[Ami] ' : '' }}{{ c.name }}
          </button>
        </div>
      </div>

      <div class="modal-actions">
        <label class="new-person-label">
          {{ contacts.length > 0 ? 'Ou saisir / créer une nouvelle personne :' : 'Nom de l’emprunteur :' }}
        </label>
        <input
          v-model="friendName"
          type="text"
          :placeholder="TEXTS.lendModal.placeholder"
          class="form-input"
          @keyup.enter="handleConfirm"
        />

        <button
          :disabled="!friendName.trim()"
          @click="handleConfirm"
          class="btn-action"
        >
          {{ TEXTS.lendModal.confirm }}
        </button>

        <button @click="handleClose" class="btn-close">
          {{ TEXTS.lendModal.cancel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.contacts-picker {
  margin-bottom: 0.85rem;
  text-align: left;
}

.picker-label,
.new-person-label {
  display: block;
  font-size: 0.8rem;
  font-weight: 800;
  color: #374151;
  margin-bottom: 0.35rem;
}

.loading-tag {
  font-weight: 600;
  color: #6b7280;
}

.contacts-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  max-height: 150px;
  overflow-y: auto;
  padding: 0.15rem 0;
}

.contact-chip {
  border: 2px solid #111827;
  background: #f9fafb;
  padding: 0.3rem 0.6rem;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
}

.contact-chip.is-friend {
  background: #ecfdf5;
  border-color: #059669;
  color: #065f46;
}

.contact-chip.is-borrower {
  background: #eef2ff;
  border-color: #4f46e5;
  color: #312e81;
}

.contact-chip.selected {
  background: #111827;
  border-color: #111827;
  color: #ffffff;
}
</style>
