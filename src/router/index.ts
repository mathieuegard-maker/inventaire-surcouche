// src/router/index.ts
import { createRouter, createWebHistory } from 'vue-router';
import { sessionStore } from '../state/session';
import { connectionService } from '../core/orchestrators/connection.orchestrator';
import LoginView from '../ui/views/LoginView.vue';
import DashboardView from '../ui/views/DashboardView.vue';
import SeriesView from '../ui/views/SeriesView.vue';
import DebugDbView from '../ui/views/DebugDbView.vue';
import BookDetailView from '../ui/views/BookDetailView.vue';
import CollectionView from '../ui/views/CollectionView.vue';
import WishlistView from '../ui/views/WishlistView.vue';
import LoansView from '../ui/views/LoansView.vue'; // AJOUT : Importation du carnet de prêts
import SearchResultView from '../ui/views/SearchResultView.vue';
import AuthorView from '../ui/views/AuthorView.vue';

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
      path: '/collection',
      name: 'CollectionView',
      component: CollectionView
    },
    {
      path: '/wishlist',
      name: 'WishlistView',
      component: WishlistView
    },
    {
      path: '/loans',
      name: 'LoansView',
      component: LoansView
    },
    {
      path: '/stats',
      name: 'StatsView',
      component: () => import('../ui/views/StatsView.vue')
    },
    {
      path: '/friends',
      name: 'FriendsView',
      component: () => import('../ui/views/FriendsView.vue')
    },
    {
      path: '/search-results',
      name: 'SearchResultView',
      component: SearchResultView
    },
    {
      path: '/author/:id',
      name: 'AuthorView',
      component: AuthorView
    },
    {
      path: '/book/create-unknown',
      name: 'BookCreateUnknown',
      component: () => import('../ui/views/BookCreateUnknown.vue')
    },
    {
      path: '/book/:uri',
      name: 'BookDetail',
      component: BookDetailView
    },
    {
      path: '/book/:uri/edit',
      name: 'BookEdit',
      component: () => import('../ui/views/BookEdit.vue')
    },
    {
      path: '/debug',
      name: 'debug',
      component: DebugDbView
    },
    {
      path: '/shared/:token',
      name: 'PublicShareView',
      component: () => import('../ui/views/PublicShareView.vue')
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/login'
    }
  ]
});

router.beforeEach((to, from) => {
  if (to.path.startsWith('/shared/')) {
    return true;
  }
  const isAuthenticated = Boolean(sessionStore.getUserUri());

  if (to.path === '/login') {
    if (isAuthenticated) {
      console.log(`[ROUTER] Session active détectée, redirection '${from.path}' -> '/dashboard'`);
      return '/dashboard';
    }
    return true;
  }

  if (connectionService.isInitialized && !isAuthenticated) {
    console.warn(`[ROUTER] Accès refusé à '${to.path}' sans session active. Redirection vers '/login'.`);
    return '/login';
  }

  console.log(`[ROUTER] Navigation validée de '${from.path}' vers '${to.path}'`);
  return true;
});