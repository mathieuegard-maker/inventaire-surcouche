<!-- src/client/components/base/PhotoLightboxModal.vue -->
<!-- Visionneuse photo plein écran tactile : pinch-to-zoom à 2 doigts, pan (déplacement), double-tap, molette et contrôles. -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { t } from '../../../shared/locales';

const props = defineProps<{
  open: boolean;
  src: string | null;
  alt?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);

// Suivi tactile (pinch 2 doigts + pan 1 doigt) et souris (drag)
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let originX = 0;
let originY = 0;

let pinchStartDist = 0;
let pinchStartScale = 1;
let lastTapAt = 0;

function resetView(): void {
  scale.value = 1;
  translateX.value = 0;
  translateY.value = 0;
}

function clampScale(next: number): number {
  return Math.min(5, Math.max(1, Math.round(next * 100) / 100));
}

function adjustScale(delta: number): void {
  const next = clampScale(scale.value + delta);
  scale.value = next;
  if (next === 1) {
    translateX.value = 0;
    translateY.value = 0;
  }
}

function getTouchDistance(t1: Touch, t2: Touch): number {
  const dx = t2.clientX - t1.clientX;
  const dy = t2.clientY - t1.clientY;
  return Math.hypot(dx, dy);
}

function handleTouchStart(event: TouchEvent): void {
  if (event.touches.length === 2) {
    isDragging = false;
    pinchStartDist = getTouchDistance(event.touches[0], event.touches[1]);
    pinchStartScale = scale.value;
    return;
  }

  if (event.touches.length === 1) {
    const now = Date.now();
    if (now - lastTapAt < 280) {
      // Double-tap : bascule 1x <-> 2.5x
      if (scale.value > 1.2) {
        resetView();
      } else {
        scale.value = 2.5;
      }
      lastTapAt = 0;
      return;
    }
    lastTapAt = now;

    isDragging = true;
    dragStartX = event.touches[0].clientX;
    dragStartY = event.touches[0].clientY;
    originX = translateX.value;
    originY = translateY.value;
  }
}

function handleTouchMove(event: TouchEvent): void {
  if (event.touches.length === 2 && pinchStartDist > 0) {
    event.preventDefault();
    const dist = getTouchDistance(event.touches[0], event.touches[1]);
    const next = clampScale(pinchStartScale * (dist / pinchStartDist));
    scale.value = next;
    if (next === 1) {
      translateX.value = 0;
      translateY.value = 0;
    }
    return;
  }

  if (event.touches.length === 1 && isDragging && scale.value > 1) {
    event.preventDefault();
    const dx = event.touches[0].clientX - dragStartX;
    const dy = event.touches[0].clientY - dragStartY;
    translateX.value = originX + dx;
    translateY.value = originY + dy;
  }
}

function handleTouchEnd(event: TouchEvent): void {
  if (event.touches.length < 2) {
    pinchStartDist = 0;
  }
  if (event.touches.length === 0) {
    isDragging = false;
  } else if (event.touches.length === 1) {
    // Reprise fluide du pan après relâchement d'un des 2 doigts
    isDragging = true;
    dragStartX = event.touches[0].clientX;
    dragStartY = event.touches[0].clientY;
    originX = translateX.value;
    originY = translateY.value;
  }
}

function handleMouseDown(event: MouseEvent): void {
  if (scale.value <= 1) return;
  event.preventDefault();
  isDragging = true;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  originX = translateX.value;
  originY = translateY.value;
}

function handleMouseMove(event: MouseEvent): void {
  if (!isDragging) return;
  translateX.value = originX + (event.clientX - dragStartX);
  translateY.value = originY + (event.clientY - dragStartY);
}

function handleMouseUp(): void {
  isDragging = false;
}

function handleWheel(event: WheelEvent): void {
  event.preventDefault();
  adjustScale(event.deltaY < 0 ? 0.35 : -0.35);
}

function handleDoubleClick(): void {
  if (scale.value > 1.2) {
    resetView();
  } else {
    scale.value = 2.5;
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (props.open && event.key === 'Escape') {
    emit('close');
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetView();
      document.addEventListener('keydown', handleKeydown);
      document.body.style.overflow = 'hidden';
    } else {
      document.removeEventListener('keydown', handleKeydown);
      document.body.style.overflow = '';
    }
  }
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open && src" class="lightbox-overlay" role="dialog" aria-modal="true">
      <header class="lightbox-toolbar">
        <div class="ds-row">
          <button type="button" class="ds-btn ds-btn--sm" @click="adjustScale(-0.5)">−</button>
          <button type="button" class="ds-btn ds-btn--sm" @click="resetView">
            {{ Math.round(scale * 100) }} %
          </button>
          <button type="button" class="ds-btn ds-btn--sm" @click="adjustScale(0.5)">+</button>
        </div>

        <button type="button" class="ds-btn ds-btn--primary ds-btn--sm" @click="emit('close')">
          {{ t('app.close') }}
        </button>
      </header>

      <div
        class="lightbox-stage"
        @touchstart="handleTouchStart"
        @touchmove="handleTouchMove"
        @touchend="handleTouchEnd"
        @mousedown="handleMouseDown"
        @mousemove="handleMouseMove"
        @mouseup="handleMouseUp"
        @mouseleave="handleMouseUp"
        @wheel="handleWheel"
        @dblclick="handleDoubleClick"
      >
        <img
          :src="src"
          :alt="alt || ''"
          class="lightbox-img"
          draggable="false"
          :style="{
            transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`
          }"
        />
      </div>

      <footer class="lightbox-hint">
        {{ t('scan.photoLightboxHint') }}
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
  color: var(--text-primary);
}

.lightbox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  z-index: 2;
}

.lightbox-stage {
  flex: 1;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  user-select: none;
  cursor: grab;
  background: var(--bg-elevated);
}

.lightbox-stage:active {
  cursor: grabbing;
}

.lightbox-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transform-origin: center center;
  will-change: transform;
  pointer-events: none;
}

.lightbox-hint {
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-muted);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-surface);
  border-top: 1px solid var(--border-subtle);
}
</style>
