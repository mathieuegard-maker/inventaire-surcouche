<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { TEXTS } from '../locales/fr';

const router = useRouter();
const isMenuOpen = ref(false);

const handleBack = () => { isMenuOpen.value = false; router.back(); };
const handleHome = () => { isMenuOpen.value = false; router.push('/dashboard'); };
const handleCollection = () => { isMenuOpen.value = false; router.push('/collection'); };
const handleWishlist = () => { isMenuOpen.value = false; router.push('/wishlist'); };
const handleLoans = () => { isMenuOpen.value = false; router.push('/loans'); };
</script>

<template>
  <header class="global-header">
    <div class="nav-desktop">
      <button class="wireframe-btn header-nav-btn" @click="handleBack">
        {{ TEXTS.seriesView?.back || 'RETOUR' }}
      </button>
      <button class="wireframe-btn header-nav-btn" @click="handleCollection">
        {{ TEXTS.collectionView?.title || 'COLLECTION' }}
      </button>
      <button class="wireframe-btn header-nav-btn" @click="handleWishlist">
        {{ TEXTS.wishlistView?.title || 'WISHLIST' }}
      </button>
      <button class="wireframe-btn header-nav-btn" @click="handleLoans">
        {{ TEXTS.loansView?.title || 'PRÊTS' }}
      </button>
      <button class="wireframe-btn header-nav-btn" @click="handleHome">
        ACCUEIL
      </button>
    </div>

    <div class="nav-mobile">
      <button class="wireframe-btn menu-trigger-btn" @click.stop="isMenuOpen = !isMenuOpen">
        {{ isMenuOpen ? 'FERMER LE MENU' : 'MENU' }}
      </button>
      
      <div v-if="isMenuOpen" class="menu-accordion-drawer">
        <button class="wireframe-btn menu-drawer-item" @click="handleBack">
          RETOUR
        </button>
        <button class="wireframe-btn menu-drawer-item" @click="handleCollection">
          {{ TEXTS.collectionView?.title || 'COLLECTION' }}
        </button>
        <button class="wireframe-btn menu-drawer-item" @click="handleWishlist">
          {{ TEXTS.wishlistView?.title || 'WISHLIST' }}
        </button>
        <button class="wireframe-btn menu-drawer-item" @click="handleLoans">
          {{ TEXTS.loansView?.title || 'PRÊTS' }}
        </button>
        <button class="wireframe-btn menu-drawer-item" @click="handleHome">
          ACCUEIL
        </button>
      </div>
    </div>
  </header>
</template>