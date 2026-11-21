// src/ui/composables/useModalScrollable.ts
import { ref, onBeforeUnmount, watch, type Ref } from 'vue';

/**
 * Détecte réactivement si le conteneur d'une modale déborde verticalement
 * afin d'afficher un second bouton de fermeture en bas uniquement lorsque la modale est scrollable.
 */
export function useModalScrollable(cardRef: Ref<HTMLElement | null>, watchDeps?: () => unknown) {
  const isScrollable = ref(false);
  let resizeObs: ResizeObserver | null = null;
  let mutationObs: MutationObserver | null = null;

  const measure = () => {
    const el = cardRef.value;
    if (!el) {
      isScrollable.value = false;
      return;
    }
    isScrollable.value = el.scrollHeight > el.clientHeight + 6;
  };

  const cleanup = () => {
    resizeObs?.disconnect();
    mutationObs?.disconnect();
    resizeObs = null;
    mutationObs = null;
  };

  watch(
    cardRef,
    (el) => {
      cleanup();
      if (!el) return;
      requestAnimationFrame(measure);
      if (typeof ResizeObserver !== 'undefined') {
        resizeObs = new ResizeObserver(measure);
        resizeObs.observe(el);
      }
      if (typeof MutationObserver !== 'undefined') {
        mutationObs = new MutationObserver(() => requestAnimationFrame(measure));
        mutationObs.observe(el, { childList: true, subtree: true });
      }
    },
    { immediate: true }
  );

  if (watchDeps) {
    watch(watchDeps, () => {
      requestAnimationFrame(measure);
    }, { deep: true });
  }

  onBeforeUnmount(() => {
    cleanup();
  });

  return { isScrollable, remeasureScrollable: measure };
}
