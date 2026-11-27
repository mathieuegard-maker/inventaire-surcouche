// src/client/router/index.ts
// Routeur SPA Vue Router V2 avec garde d'authentification stricte (cookie HttpOnly via /api/me) + garde Admin.

import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.store';
import LoginView from '../views/LoginView.vue';
import DashboardView from '../views/DashboardView.vue';
import CollectionView from '../views/CollectionView.vue';
import WishlistView from '../views/WishlistView.vue';
import LoansView from '../views/LoansView.vue';
import ProfileView from '../views/ProfileView.vue';
import DebugCacheView from '../views/DebugCacheView.vue';
import BookDetailView from '../views/BookDetailView.vue';
import BookEditView from '../views/BookEditView.vue';
import BookCreateView from '../views/BookCreateView.vue';
import SeriesDetailView from '../views/SeriesDetailView.vue';
import AuthorDetailView from '../views/AuthorDetailView.vue';
import ReleasesView from '../views/ReleasesView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { publicOnly: true }
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: DashboardView,
      meta: { requiresAuth: true }
    },
    {
      path: '/check',
      name: 'quick-check',
      component: DashboardView,
      meta: { requiresAuth: true }
    },
    {
      path: '/collection',
      name: 'collection',
      component: CollectionView,
      meta: { requiresAuth: true }
    },
    {
      path: '/wishlist',
      name: 'wishlist',
      component: WishlistView,
      meta: { requiresAuth: true }
    },
    {
      path: '/loans',
      name: 'loans',
      component: LoansView,
      meta: { requiresAuth: true }
    },
    {
      path: '/profile',
      name: 'profile',
      component: ProfileView,
      meta: { requiresAuth: true }
    },
    {
      path: '/debug',
      name: 'debug',
      component: DebugCacheView,
      meta: { requiresAuth: true }
    },
    // Alias de rétrocompatibilité navigation
    { path: '/stats', redirect: { path: '/profile', query: { tab: 'stats' } } },
    { path: '/friends', redirect: { path: '/social', query: { tab: 'friends' } } },
    // Fiches Livres, Édition Couche 3 & Création Manuelle
    { path: '/book/create', name: 'book-create', component: BookCreateView, meta: { requiresAuth: true } },
    { path: '/book/:bookId/edit', name: 'book-edit', component: BookEditView, meta: { requiresAuth: true } },
    { path: '/book/:bookId', name: 'book-detail', component: BookDetailView, meta: { requiresAuth: true } },
    // Acquisition 4 onglets (lazy-loaded pour isoler html5-qrcode du bundle principal)
    {
      path: '/scan',
      name: 'scan',
      component: () => import('../views/ScanView.vue'),
      meta: { requiresAuth: true }
    },
    // Séries, Auteurs & Nouveautés
    { path: '/series/:seriesId', name: 'series-detail', component: SeriesDetailView, meta: { requiresAuth: true } },
    { path: '/author/:name', name: 'author-detail', component: AuthorDetailView, meta: { requiresAuth: true } },
    { path: '/releases', name: 'releases', component: ReleasesView, meta: { requiresAuth: true } },
    // Social, Partage Public & Administration (Jalon 7, lazy-loaded)
    {
      path: '/social',
      name: 'social',
      component: () => import('../views/SocialView.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/shared/:token',
      name: 'public-share',
      component: () => import('../views/PublicShareView.vue')
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('../views/AdminView.vue'),
      meta: { requiresAuth: true, requiresAdmin: true }
    },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
  ]
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();
  if (!authStore.isInitialized) {
    await authStore.initSession();
  }

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    const query: Record<string, string> = {};
    if (to.fullPath && to.fullPath !== '/dashboard') {
      query.redirect = to.fullPath;
    }
    if (typeof to.query.invite === 'string') query.invite = to.query.invite;
    if (typeof to.query.friend === 'string') query.friend = to.query.friend;
    return { path: '/login', query };
  }

  if (to.meta.requiresAdmin && !authStore.isAdmin) {
    return { path: '/dashboard' };
  }

  if (to.meta.publicOnly && authStore.isAuthenticated) {
    return { path: '/dashboard' };
  }

  return true;
});
