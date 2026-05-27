// src/router/index.ts
import { createRouter, createWebHistory } from 'vue-router';
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
      path: '/:pathMatch(.*)*',
      redirect: '/login'
    }
  ]
});

router.beforeEach((to, from) => {
  console.log(`[ROUTER] Navigation validée de '${from.path}' vers '${to.path}'`);
  return true;
});