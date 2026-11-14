// src/ui/composables/useSemanticResolution.ts
import { ref, computed } from 'vue';
import type { ResolutionStep } from '../../core/orchestrators/book-semantic.orchestrator';

export function useSemanticResolution() {
  const resolutionQueue = ref<ResolutionStep[]>([]);
  const currentStepIndex = ref(-1);
  const selectedOptionUri = ref('NEW');

  const resolvedSeriesUri = ref<string | undefined>(undefined);
  const resolvedAuthorUris = ref<Record<string, string>>({});

  const currentStep = computed(() => {
    if (currentStepIndex.value >= 0 && currentStepIndex.value < resolutionQueue.value.length) {
      return resolutionQueue.value[currentStepIndex.value];
    }
    return null;
  });

  const showResolutionModal = computed(() => {
    return currentStepIndex.value >= 0;
  });

  const startResolution = (steps: ResolutionStep[]) => {
    resolutionQueue.value = steps;
    resolvedSeriesUri.value = undefined;
    resolvedAuthorUris.value = {};
    
    if (steps.length > 0) {
      currentStepIndex.value = 0;
      selectedOptionUri.value = steps[0].matches[0]?.uri || 'NEW';
    } else {
      currentStepIndex.value = -1;
    }
  };

  const confirmStep = async (onComplete: () => Promise<void>) => {
    const step = currentStep.value;
    if (!step) return;

    const chosenUri = selectedOptionUri.value === 'NEW' ? undefined : selectedOptionUri.value;

    if (step.type === 'series') {
      resolvedSeriesUri.value = chosenUri;
    } else if (step.type === 'author') {
      if (chosenUri) {
        resolvedAuthorUris.value[step.name] = chosenUri;
      }
    }

    currentStepIndex.value++;

    if (currentStepIndex.value < resolutionQueue.value.length) {
      const nextStep = resolutionQueue.value[currentStepIndex.value];
      selectedOptionUri.value = nextStep.matches[0]?.uri || 'NEW';
    } else {
      currentStepIndex.value = -1;
      await onComplete();
    }
  };

  const cancelResolution = () => {
    resolutionQueue.value = [];
    currentStepIndex.value = -1;
    resolvedSeriesUri.value = undefined;
    resolvedAuthorUris.value = {};
  };

  return {
    resolutionQueue,
    currentStepIndex,
    currentStep,
    selectedOptionUri,
    resolvedSeriesUri,
    resolvedAuthorUris,
    showResolutionModal,
    startResolution,
    confirmStep,
    cancelResolution
  };
}
