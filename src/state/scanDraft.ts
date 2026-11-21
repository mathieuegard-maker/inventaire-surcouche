// src/state/scanDraft.ts
// Brouillon persistant des arbitrages Photo IA sur /scan :
// survit aux navigations dans l'application (Collection, Séries, Fiche livre) et au rechargement de page.

import { ref, watch } from 'vue';
import type { ResolvedPhotoItem } from '../core/services/photo-book-resolution.service';

const DRAFT_STORAGE_KEY = 'biblio_scan_photo_draft_v1';

interface PersistedScanDraft {
  resolvedDetectedItems: ResolvedPhotoItem[];
  doubtItems: ResolvedPhotoItem[];
  unresolvedItems: ResolvedPhotoItem[];
  seriesExtraItems: ResolvedPhotoItem[];
  detectedSeriesNames: string[];
  expandedSeriesKeys: Record<string, boolean>;
  handledSourceIds: string[];
  updatedAt: number;
}

function loadDraftFromStorage(): Partial<PersistedScanDraft> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedScanDraft>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const initial = loadDraftFromStorage();

const resolvedDetectedItems = ref<ResolvedPhotoItem[]>(Array.isArray(initial.resolvedDetectedItems) ? initial.resolvedDetectedItems : []);
const doubtItems = ref<ResolvedPhotoItem[]>(Array.isArray(initial.doubtItems) ? initial.doubtItems : []);
const unresolvedItems = ref<ResolvedPhotoItem[]>(Array.isArray(initial.unresolvedItems) ? initial.unresolvedItems : []);
const seriesExtraItems = ref<ResolvedPhotoItem[]>(Array.isArray(initial.seriesExtraItems) ? initial.seriesExtraItems : []);
const detectedSeriesNames = ref<string[]>(Array.isArray(initial.detectedSeriesNames) ? initial.detectedSeriesNames : []);
const expandedSeriesKeys = ref<Record<string, boolean>>(
  initial.expandedSeriesKeys && typeof initial.expandedSeriesKeys === 'object' ? initial.expandedSeriesKeys : {}
);
const handledSourceIds = ref<string[]>(Array.isArray(initial.handledSourceIds) ? initial.handledSourceIds : []);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistDraftNow() {
  if (typeof localStorage === 'undefined') return;
  try {
    const hasData =
      resolvedDetectedItems.value.length > 0 ||
      doubtItems.value.length > 0 ||
      unresolvedItems.value.length > 0 ||
      seriesExtraItems.value.length > 0;
    if (!hasData) {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      return;
    }
    const payload: PersistedScanDraft = {
      resolvedDetectedItems: resolvedDetectedItems.value,
      doubtItems: doubtItems.value,
      unresolvedItems: unresolvedItems.value,
      seriesExtraItems: seriesExtraItems.value,
      detectedSeriesNames: detectedSeriesNames.value,
      expandedSeriesKeys: expandedSeriesKeys.value,
      handledSourceIds: handledSourceIds.value,
      updatedAt: Date.now()
    };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota localStorage éventuel : le store en mémoire reste intact pour toute la session
  }
}

function schedulePersistDraft() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistDraftNow();
  }, 180);
}

watch(
  [resolvedDetectedItems, doubtItems, unresolvedItems, seriesExtraItems, detectedSeriesNames, expandedSeriesKeys, handledSourceIds],
  () => {
    schedulePersistDraft();
  },
  { deep: true }
);

/**
 * Trie les éléments selon l'ordre exact des photos puis de gauche à droite (`spineIndex`).
 */
export function sortItemsByShelfOrder(items: ResolvedPhotoItem[]): void {
  items.sort((a, b) => {
    const jobA = typeof a.sourceJobId === 'number' ? a.sourceJobId : Number.MAX_SAFE_INTEGER;
    const jobB = typeof b.sourceJobId === 'number' ? b.sourceJobId : Number.MAX_SAFE_INTEGER;
    if (jobA !== jobB) return jobA - jobB;
    const spineA = typeof a.rawCandidate?.spineIndex === 'number' ? a.rawCandidate.spineIndex : Number.MAX_SAFE_INTEGER;
    const spineB = typeof b.rawCandidate?.spineIndex === 'number' ? b.rawCandidate.spineIndex : Number.MAX_SAFE_INTEGER;
    if (spineA !== spineB) return spineA - spineB;
    return (a.title || '').localeCompare(b.title || '', 'fr');
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persistDraftNow);
  window.addEventListener('beforeunload', persistDraftNow);
}

export const scanDraftStore = {
  resolvedDetectedItems,
  doubtItems,
  unresolvedItems,
  seriesExtraItems,
  detectedSeriesNames,
  expandedSeriesKeys,
  handledSourceIds,
  flushNow: persistDraftNow,

  markSourceIdHandled(id?: string | null) {
    if (!id) return;
    if (!handledSourceIds.value.includes(id)) {
      handledSourceIds.value.push(id);
    }
  },

  clearAll() {
    resolvedDetectedItems.value = [];
    doubtItems.value = [];
    unresolvedItems.value = [];
    seriesExtraItems.value = [];
    detectedSeriesNames.value = [];
    expandedSeriesKeys.value = {};
    handledSourceIds.value = [];
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  }
};
