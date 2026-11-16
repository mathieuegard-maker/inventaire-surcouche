import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'prompt',
      devOptions: {
        enabled: true, // Permet de tester le Service Worker en local via `vercel dev`
        type: 'module'
      },
      // Ajout de cette section pour corriger l'avertissement
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'], // On retire .wasm de la liste
        importScripts: ['/sw-push.js']
      },
      manifest: {
        name: 'Ma Bibliothèque Cloud',
        short_name: 'Ma Biblio',
        description: 'Gestionnaire de bibliothèque personnelle et familiale',
        theme_color: '#4f46e5',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: '/192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ]
});