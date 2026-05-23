import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../ui/views/LoginView.vue';
import DashboardView from '../ui/views/DashboardView.vue';
import SeriesView from '../ui/views/SeriesView.vue';
import DebugDbView from '../ui/views/DebugDbView.vue';
import BookDetailView from '../ui/views/BookDetailView.vue';

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
      // La nouvelle route DOIT être déclarée ici, avant le catch-all
      path: '/book/:uri',
      name: 'BookDetail',
      component: BookDetailView
    },
    {
      path: '/debug',
      name: 'debug',
      component: DebugDbView
    },
    {
      // Le filet de sécurité doit STRICTEMENT rester la dernière route du tableau
      path: '/:pathMatch(.*)*',
      redirect: '/login'
    }
  ]
});

router.beforeEach((to, from) => {
  console.log(`[ROUTER] Navigation validée de '${from.path}' vers '${to.path}'`);
  return true;
});