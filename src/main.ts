// src/main.ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { router } from './router';
import App from './App.vue';
import { initPwaInstallListener } from './core/utils/pwa-install.util';

// Injection du Design System global
import './ui/styles/theme.css';

initPwaInstallListener();

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.mount('#app');