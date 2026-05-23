<script setup lang="ts">
import { ref } from 'vue';
import { TEXTS } from '../locales/fr';

const props = defineProps<{
  show: boolean;
  bookCount: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', friendName: string): void;
}>();

const friendName = ref('');

const handleConfirm = () => {
  if (!friendName.value.trim()) return;
  emit('confirm', friendName.value.trim());
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
      
      <div class="modal-actions">
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