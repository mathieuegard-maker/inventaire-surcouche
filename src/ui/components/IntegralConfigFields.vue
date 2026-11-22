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
  background: #f1f5f9;
  padding: 0.25rem;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}

.integral-seg-btn {
  border: 1px solid transparent;
  background: transparent;
  color: #475569;
  font-weight: 700;
  font-size: 0.8rem;
  padding: 0.42rem 0.55rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.integral-config-box.compact .integral-seg-btn {
  font-size: 0.74rem;
  padding: 0.3rem 0.45rem;
}

.integral-seg-btn.active {
  background: #4f46e5;
  color: #ffffff;
  border-color: #4338ca;
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
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
}

.integral-volumes-label {
  font-size: 0.78rem;
  color: #3730a3;
}

.integral-volumes-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 34px;
  padding: 0.35rem 0.55rem;
  border: 1px solid #a5b4fc;
  border-radius: 6px;
  font-size: 0.84rem;
  background: #ffffff;
  color: #0f172a;
}

.integral-parsed-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.integral-parsed-pill {
  font-size: 0.72rem;
  font-weight: 700;
  color: #4338ca;
  background: #ffffff;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  padding: 0.12rem 0.5rem;
}
</style>
