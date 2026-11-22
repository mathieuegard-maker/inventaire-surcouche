<script setup lang="ts">
import { computed } from 'vue';
import { parseIncludedVolumeNumbers } from '../../core/bibliographic/integral.util';

const props = withDefaults(
  defineProps<{
    isIntegral: boolean;
    includedVolumesText: string;
    compact?: boolean;
    disabled?: boolean;
    inputId?: string;
  }>(),
  {
    compact: false,
    disabled: false,
    inputId: 'integral-vols-input'
  }
);

const emit = defineEmits<{
  (e: 'update:isIntegral', value: boolean): void;
  (e: 'update:includedVolumesText', value: string): void;
  (e: 'change'): void;
}>();

const parsedVolumes = computed(() => parseIncludedVolumeNumbers(props.includedVolumesText));

const setIntegral = (value: boolean) => {
  if (props.disabled) return;
  emit('update:isIntegral', value);
  emit('change');
};

const onTextInput = (event: Event) => {
  const val = (event.target as HTMLInputElement).value;
  emit('update:includedVolumesText', val);
  emit('change');
};
</script>

<template>
  <div class="integral-config-box" :class="{ compact }">
    <div class="integral-segmented" role="group" aria-label="Format du livre">
      <button
        type="button"
        class="integral-seg-btn"
        :class="{ active: !isIntegral }"
        :disabled="disabled"
        @click="setIntegral(false)"
      >
        Tome / Album standard
      </button>
      <button
        type="button"
        class="integral-seg-btn"
        :class="{ active: isIntegral }"
        :disabled="disabled"
        @click="setIntegral(true)"
      >
        Intégrale / Coffret
      </button>
    </div>

    <div v-if="isIntegral" class="integral-volumes-row">
      <label class="integral-volumes-label" :for="inputId">
        <strong>Tomes inclus :</strong>
      </label>
      <input
        :id="inputId"
        :value="includedVolumesText"
        type="text"
        class="integral-volumes-input"
        placeholder="ex : 1 à 3  ou  4, 5, 6"
        :disabled="disabled"
        @input="onTextInput"
      />
      <div v-if="parsedVolumes.length > 0" class="integral-parsed-pills">
        <span class="integral-parsed-pill">
          Tomes détectés : {{ parsedVolumes.map((v) => `T.${v}`).join(', ') }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.integral-config-box {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.integral-segmented {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.35rem;
  background: var(--color-bg-alt);
  padding: 0.25rem;
  border-radius: var(--radius-sm);
  border: var(--border-width) solid var(--color-border);
}

.integral-seg-btn {
  border: var(--border-width) solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  font-weight: 700;
  font-size: 0.8rem;
  padding: 0.42rem 0.55rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.integral-config-box.compact .integral-seg-btn {
  font-size: 0.74rem;
  padding: 0.3rem 0.45rem;
}

.integral-seg-btn.active {
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border-color: var(--color-primary-hover);
}

.integral-seg-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.integral-volumes-row {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.55rem 0.65rem;
  background: var(--color-status-integral-light);
  border: var(--border-width) solid var(--color-status-integral-border);
  border-radius: var(--radius-sm);
}

.integral-volumes-label {
  font-size: 0.78rem;
  color: var(--color-status-integral-text);
}

.integral-volumes-input {
  width: 100%;
  box-sizing: border-box;
  min-height: var(--input-height-compact);
  padding: 0.35rem 0.55rem;
  border: var(--border-width) solid var(--color-status-integral-border);
  border-radius: var(--radius-sm);
  font-size: 0.84rem;
  background: var(--color-bg-main);
  color: var(--color-text-main);
}

.integral-parsed-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.integral-parsed-pill {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--color-status-integral-text);
  background: var(--color-bg-main);
  border: var(--border-width) solid var(--color-status-integral-border);
  border-radius: 999px;
  padding: 0.12rem 0.5rem;
}
</style>
