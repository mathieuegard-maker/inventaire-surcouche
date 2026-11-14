<script setup lang="ts">
import { computed } from 'vue';
import { TEXTS } from '../locales/fr';
import BaseButton from './BaseButton.vue';

interface MatchItem {
  name: string;
  uri: string;
  distance: number;
}

interface ResolutionStep {
  type: 'series' | 'author';
  name: string;
  matches: MatchItem[];
}

const props = defineProps<{
  show: boolean;
  step: ResolutionStep | null;
  selectedUri: string;
}>();

const emit = defineEmits<{
  (e: 'update:selectedUri', value: string): void;
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const modalTitle = computed(() => {
  if (!props.step) return '';
  return props.step.type === 'series'
    ? TEXTS.dedupModal.titleSeries
    : TEXTS.dedupModal.titleAuthors;
});

const modalDescription = computed(() => {
  if (!props.step) return '';
  const template = props.step.type === 'series'
    ? TEXTS.dedupModal.seriesMsg
    : TEXTS.dedupModal.authorsMsg;
  return template.replace('{name}', props.step.name);
});

const handleSelect = (uri: string) => {
  emit('update:selectedUri', uri);
};
</script>

<template>
  <div v-if="show && step" class="modal-overlay" @click.self="emit('cancel')">
    <div class="modal-box dedup-modal-box">
      <h3 class="dedup-title">
        [ {{ modalTitle }} ]
      </h3>
      <p class="dedup-desc">
        {{ modalDescription }}
      </p>

      <div class="dedup-options-list">
        <!-- Options existantes -->
        <div 
          v-for="item in step.matches" 
          :key="item.uri" 
          class="dedup-option-row"
          :class="{ selected: selectedUri === item.uri }"
          @click="handleSelect(item.uri)"
        >
          <input 
            type="radio" 
            name="dedupOption" 
            :id="'opt-' + item.uri" 
            :value="item.uri" 
            :checked="selectedUri === item.uri"
            class="wireframe-radio"
          />
          <label :for="'opt-' + item.uri" class="dedup-option-label">
            {{ TEXTS.dedupModal.linkExisting }} <span class="dedup-underline">{{ item.name }}</span> ({{ TEXTS.dedupModal.distance }} {{ item.distance }})
          </label>
        </div>

        <!-- Option de création nouvelle -->
        <div 
          class="dedup-option-row new-entity"
          :class="{ selected: selectedUri === 'NEW' }"
          @click="handleSelect('NEW')"
        >
          <input 
            type="radio" 
            name="dedupOption" 
            id="opt-new" 
            value="NEW" 
            :checked="selectedUri === 'NEW'"
            class="wireframe-radio"
          />
          <label for="opt-new" class="dedup-option-label">
            {{ TEXTS.dedupModal.createNew }} "{{ step.name }}"
          </label>
        </div>
      </div>

      <div class="modal-actions dedup-actions">
        <BaseButton @click="emit('cancel')" class="btn-cancel">
          [ {{ TEXTS.dedupModal.btnCancel }} ]
        </BaseButton>
        <BaseButton type="primary" @click="emit('confirm')" class="btn-save">
          [ {{ TEXTS.dedupModal.btnConfirm }} ]
        </BaseButton>
      </div>
    </div>
  </div>
</template>
