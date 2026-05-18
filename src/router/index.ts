// src/router/index.ts
import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../ui/views/LoginView.vue';
import DashboardView from '../ui/views/DashboardView.vue';

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
    // Redirection de sécurité : si on tape une URL qui n'existe pas
    {
      path: '/:pathMatch(.*)*',
      redirect: '/login'
    }
  ]
});