// src/main.ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { router } from './router';
import App from './App.vue';
import { initPwaInstallListener } from './core/utils/pwa-install.util';

// Injection du Design System global
import './ui/styles/theme.css';

initPwaInstallListener();

// UX globale : sélectionner automatiquement tout le contenu d'un champ texte rempli au focus
if (typeof document !== 'undefined') {
  const SELECTABLE_TYPES = new Set(['text', 'search', 'email', 'number', 'tel', 'url', '']);
  let lastAutoSelected: HTMLInputElement | HTMLTextAreaElement | null = null;

  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) {
      if (target.dataset.noAutoselect !== undefined || target.readOnly || target.disabled) return;
      if (target.value.length > 0) {
        lastAutoSelected = target;
        requestAnimationFrame(() => target.select());
      }
      return;
    }
    if (target instanceof HTMLInputElement) {
      if (target.dataset.noAutoselect !== undefined || target.readOnly || target.disabled) return;
      const type = (target.type || '').toLowerCase();
      if (!SELECTABLE_TYPES.has(type)) return;
      if (target.value.length > 0) {
        lastAutoSelected = target;
        requestAnimationFrame(() => {
          try {
            target.select();
          } catch {
            // Certains types (ex: number sur anciens navigateurs) ne supportent pas select()
          }
        });
      }
    }
  });

  // Empêche le mouseup immédiatement consécutif au clic initial de désélectionner le texte
  document.addEventListener('mouseup', (event) => {
    if (lastAutoSelected && event.target === lastAutoSelected) {
      event.preventDefault();
      lastAutoSelected = null;
    }
  });
}

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.mount('#app');