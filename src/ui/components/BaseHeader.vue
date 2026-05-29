<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { TEXTS } from '../locales/fr';
import { scannerState } from '../../state/scanner';

const router = useRouter();
const isMenuOpen = ref(false);

const handleBack = () => { isMenuOpen.value = false; router.back(); };
const handleHome = () => { isMenuOpen.value = false; router.push('/dashboard'); };
const handleCollection = () => { isMenuOpen.value = false; router.push('/collection'); };
const handleWishlist = () => { isMenuOpen.value = false; router.push('/wishlist'); };
const handleLoans = () => { isMenuOpen.value = false; router.push('/loans'); };

const toggleScan = () => {
  isMenuOpen.value = false;
  scannerState.toggleScan(router);
};
</script>

<template>
  <header class="global-header">
    <div class="nav-desktop">
      <button class="wireframe-btn header-nav-btn" @click="handleBack">
        {{ TEXTS.header?.back || 'RETOUR' }}
      </button>
      <button class="wireframe-btn header-nav-btn" @click="handleCollection">
        {{ TEXTS.header?.collection || 'COLLECTION' }}
      </button>
      <button class="wireframe-btn header-nav-btn" @click="handleWishlist">
        {{ TEXTS.header?.wishlist || 'WISHLIST' }}
      </button>
      <button class="wireframe-btn header-nav-btn" @click="handleLoans">
        {{ TEXTS.header?.loans || 'PRÊTS' }}
      </button>
      <button class="wireframe-btn header-nav-btn" @click="handleHome">
        {{ TEXTS.header?.home || 'ACCUEIL' }}
      </button>
      <button class="wireframe-btn header-nav-btn btn-scan-global-trigger" @click="toggleScan" :class="{ 'btn-scan-active': scannerState.isScanningActive.value }">
        {{ scannerState.isScanningActive.value ? 'FERMER' : 'SCANNER 📷' }}
      </button>
    </div>

    <div class="nav-mobile">
      <div class="mobile-header-bar">
        <button class="wireframe-btn menu-trigger-btn" @click.stop="isMenuOpen = !isMenuOpen">
          {{ isMenuOpen ? (TEXTS.header?.closeMenu || 'FERMER LE MENU') : (TEXTS.header?.menu || 'MENU') }}
        </button>
        <button class="wireframe-btn mobile-scan-trigger-btn" @click="toggleScan" :class="{ 'btn-scan-active': scannerState.isScanningActive.value }">
          {{ scannerState.isScanningActive.value ? 'FERMER' : 'SCANNER 📷' }}
        </button>
      </div>
      
      <div v-if="isMenuOpen" class="menu-accordion-drawer">
        <button class="wireframe-btn menu-drawer-item" @click="handleBack">
          {{ TEXTS.header?.back || 'RETOUR' }}
        </button>
        <button class="wireframe-btn menu-drawer-item" @click="handleCollection">
          {{ TEXTS.header?.collection || 'COLLECTION' }}
        </button>
        <button class="wireframe-btn menu-drawer-item" @click="handleWishlist">
          {{ TEXTS.header?.wishlist || 'WISHLIST' }}
        </button>
        <button class="wireframe-btn menu-drawer-item" @click="handleLoans">
          {{ TEXTS.header?.loans || 'PRÊTS' }}
        </button>
        <button class="wireframe-btn menu-drawer-item" @click="handleHome">
          {{ TEXTS.header?.home || 'ACCUEIL' }}
        </button>
      </div>
    </div>
  </header>
</template>