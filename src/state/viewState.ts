import { reactive } from 'vue';

export interface ViewPageState {
  currentPage: number;
  pageSize: number;
  searchQuery: string;
  scrollPosition: number;
  filters: Record<string, any>;
}

export const viewStateStore = reactive<Record<string, ViewPageState>>({});

export function getOrCreateViewState(viewKey: string, defaults: Partial<ViewPageState> = {}): ViewPageState {
  if (!viewStateStore[viewKey]) {
    viewStateStore[viewKey] = {
      currentPage: defaults.currentPage ?? 1,
      pageSize: defaults.pageSize ?? 20,
      searchQuery: defaults.searchQuery ?? '',
      scrollPosition: defaults.scrollPosition ?? 0,
      filters: defaults.filters ?? {},
    };
  }
  return viewStateStore[viewKey];
}

export function saveViewState(viewKey: string, state: Partial<ViewPageState>) {
  const current = getOrCreateViewState(viewKey);
  Object.assign(current, state);
}
