// src/router/index.ts
import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../ui/views/LoginView.vue';
import DashboardView from '../ui/views/DashboardView.vue';
import SeriesView from '../ui/views/SeriesView.vue';
import DebugDbView from '../ui/views/DebugDbView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: DashboardView
    },
    {
      path: '/series/:id',
      name: 'SeriesView',
      component: SeriesView
    },
    {
      path: '/debug',
      name: 'debug',
      component: DebugDbView
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/login'
    }
  ]
});

// Gardien de navigation (Syntaxe moderne Vue 3 - Sans 'next()')
// Il ne fait que tracer la navigation pour le débug, sans bloquer.
router.beforeEach((to, from) => {
  console.log(`[ROUTER] Navigation validée de '${from.path}' vers '${to.path}'`);
  return true; // true autorise la navigation, false la bloque.
});