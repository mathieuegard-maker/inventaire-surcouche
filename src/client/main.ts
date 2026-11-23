// src/client/main.ts
// Point d'entrée client Vue 3 + Pinia + Vue Router + Design System Tokens V2.

import './styles/tokens.css';
import './styles/base.css';
import './styles/primitives.css';
import './styles/layouts.css';

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useUiStore } from './stores/ui.store';

// Restauration immédiate du thème avant le premier rendu (évite tout flash visuel)
try {
  const savedTheme = localStorage.getItem('biblio_theme_v2');
  if (savedTheme === 'editorial-light' || savedTheme === 'dark' || savedTheme === 'warm') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
} catch {
  // ignore
}

// Ergonomie transverse : sélection automatique du texte au focus des champs saisissables
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'file',
  'range',
  'color',
  'hidden'
]);

function isSelectableTextElement(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) {
    return !target.readOnly && !target.disabled;
  }
  if (target instanceof HTMLInputElement) {
    return !target.readOnly && !target.disabled && !NON_TEXT_INPUT_TYPES.has(target.type);
  }
  return false;
}

let justFocusedElement: HTMLElement | null = null;

document.addEventListener('focusin', (event) => {
  if (!isSelectableTextElement(event.target)) return;
  const el = event.target;
  justFocusedElement = el;
  window.setTimeout(() => {
    try {
      el.select();
    } catch {
      // certains types d'input natifs ne supportent pas select()
    }
  }, 0);
});

document.addEventListener('mouseup', (event) => {
  if (justFocusedElement && event.target === justFocusedElement) {
    event.preventDefault();
    justFocusedElement = null;
  }
});

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

const uiStore = useUiStore(pinia);
uiStore.initGlobalListeners();

app.mount('#app');
