<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { TEXTS } from '../locales/fr';
import { userService, type LoanContact } from '../../core/services/user.service';
import { useModalScrollable } from '../composables/useModalScrollable';

const LOCAL_CONTACTS_KEY = 'biblio_loan_contacts_v1';

const isValidPersonName = (raw: string | null | undefined): boolean => {
  const clean = String(raw || '').trim();
  if (!clean) return false;
  const low = clean.toLowerCase();
  if (
    low === 'prêt' ||
    low === 'pret' ||
    low === 'prêts' ||
    low === 'prets' ||
    low === 'ami' ||
    low === 'inconnu' ||
    low.startsWith('inconnu (') ||
    low.startsWith('prêt -') ||
    low.startsWith('pret -')
  ) {
    return false;
  }
  return true;
};

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
const modalCardRef = ref<HTMLElement | null>(null);
const { isScrollable } = useModalScrollable(modalCardRef, () => [props.show, contacts.value.length]);

const readLocalContacts = (): LoanContact[] => {
  try {
    const raw = localStorage.getItem(LOCAL_CONTACTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const cleaned = parsed.filter((c: LoanContact) => isValidPersonName(c?.name));
    if (cleaned.length !== parsed.length) {
      writeLocalContacts(cleaned);
    }
    return cleaned;
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
    if (!isValidPersonName(clean)) return;
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
    writeLocalContacts(merged);
  } catch {
    // Hors ligne : on garde le cache local nettoyé
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
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="handleClose">
      <div ref="modalCardRef" class="modal-box" role="dialog" aria-modal="true" aria-label="Prêter">
        <div class="modal-header-row">
          <h2>{{ TEXTS.lendModal.title }}</h2>
          <button type="button" class="modal-close-icon" aria-label="Fermer" @click="handleClose">✕</button>
        </div>
        <p class="modal-text">
          {{ bookCount > 1 ? TEXTS.lendModal.instructionPlural : TEXTS.lendModal.instructionSingular }}
        </p>

        <!-- Liste contextuelle : affichée uniquement s'il existe de vrais amis/emprunteurs enregistrés -->
        <div v-if="contacts.length > 0" class="contacts-picker">
          <span class="picker-label">
            Choisir une personne connue :
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
          <label class="new-person-label" for="lend-friend-input">
            {{ contacts.length > 0 ? 'Ou saisir / créer une nouvelle personne :' : 'Nom de l’emprunteur :' }}
          </label>
          <input
            id="lend-friend-input"
            v-model="friendName"
            type="text"
            :placeholder="TEXTS.lendModal.placeholder"
            class="form-input"
            @keyup.enter="handleConfirm"
          />

          <button
            type="button"
            :disabled="!friendName.trim()"
            @click="handleConfirm"
            class="btn-action"
          >
            {{ TEXTS.lendModal.confirm }}
          </button>

          <button type="button" @click="handleClose" class="btn-close">
            {{ TEXTS.lendModal.cancel }}
          </button>
        </div>

        <div v-if="isScrollable" class="modal-bottom-close-bar">
          <button type="button" class="modal-close-icon" aria-label="Fermer" @click="handleClose">✕</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.contacts-picker {
  margin-bottom: 0.25rem;
  text-align: left;
}

.picker-label,
.new-person-label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.35;
  color: var(--color-text-muted, #475569);
  margin-bottom: 0.4rem;
}

.loading-tag {
  font-weight: 500;
  color: var(--color-text-muted, #64748b);
}

.contacts-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  max-block-size: 150px;
  overflow-y: auto;
  padding: 0.15rem 0;
}

.contact-chip {
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 9999px;
  background: var(--color-bg-alt, #f8fafc);
  min-block-size: 32px;
  padding: 0.25rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.25;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.contact-chip.is-friend {
  background: #ecfdf5;
  border-color: #6ee7b7;
  color: #065f46;
}

.contact-chip.is-borrower {
  background: #eef2ff;
  border-color: #c7d2fe;
  color: #3730a3;
}

.contact-chip.selected {
  background: var(--color-primary, #4f46e5);
  border-color: var(--color-primary, #4f46e5);
  color: #ffffff;
}
</style>
