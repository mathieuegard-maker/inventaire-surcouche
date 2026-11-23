<!-- src/client/components/books/IntegralFields.vue -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  formatIncludedVolumeNumbers,
  parseIncludedVolumeNumbers
} from '../../../shared/bibliographic/integral.util';
import { t } from '../../../shared/locales';

const props = defineProps<{
  isIntegral: boolean;
  includedVolumes: string[];
}>();

const emit = defineEmits<{
  (e: 'update:isIntegral', value: boolean): void;
  (e: 'update:includedVolumes', value: string[]): void;
}>();

const rangeInput = ref(formatIncludedVolumeNumbers(props.includedVolumes));

watch(
  () => props.includedVolumes,
  (next) => {
    const formatted = formatIncludedVolumeNumbers(next);
    if (formatted !== formatIncludedVolumeNumbers(parseIncludedVolumeNumbers(rangeInput.value))) {
      rangeInput.value = formatted;
    }
  }
);

const parsedVolumes = computed(() => parseIncludedVolumeNumbers(rangeInput.value));

function handleModeChange(nextIsIntegral: boolean): void {
  emit('update:isIntegral', nextIsIntegral);
  if (!nextIsIntegral) {
    rangeInput.value = '';
    emit('update:includedVolumes', []);
  }
}

function handleRangeInput(raw: string): void {
  rangeInput.value = raw;
  emit('update:includedVolumes', parseIncludedVolumeNumbers(raw));
}
</script>

<template>
  <div class="ds-panel ds-stack integral-box">
    <span class="ds-label">{{ t('book.formatLabel') }}</span>

    <div class="ds-row">
      <button
        type="button"
        class="ds-btn ds-btn--sm"
        :class="{ 'ds-btn--primary': !isIntegral }"
        @click="handleModeChange(false)"
      >
        {{ t('book.standardFormat') }}
      </button>
      <button
        type="button"
        class="ds-btn ds-btn--sm"
        :class="{ 'ds-btn--primary': isIntegral }"
        @click="handleModeChange(true)"
      >
        {{ t('book.integralFormat') }}
      </button>
    </div>

    <div v-if="isIntegral" class="ds-field integral-range-field">
      <label class="ds-label" for="integral-volumes-input">{{ t('book.includedVolumesLabel') }}</label>
      <input
        id="integral-volumes-input"
        :value="rangeInput"
        type="text"
        class="ds-input"
        :placeholder="t('book.includedVolumesPlaceholder')"
        @input="handleRangeInput(($event.target as HTMLInputElement).value)"
      />
      <p v-if="parsedVolumes.length > 0" class="ds-text-muted">
        {{ t('book.includedPreviewLabel', { list: parsedVolumes.join(', ') }) }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.integral-range-field {
  margin-bottom: 0;
}
</style>
