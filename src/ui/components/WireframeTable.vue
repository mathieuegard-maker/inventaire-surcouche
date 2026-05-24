<template>
  <div class="wireframe-table-container">
    <slot></slot>
  </div>
</template>

<style>
/* Gestion centralisée de la grille continue pour éliminer les doubles bordures */
.wireframe-table-container {
  display: flex !important;
  flex-direction: column !important;
  border: var(--border-width) solid var(--color-border) !important;
  background-color: var(--color-bg-main) !important;
  width: 100% !important;
  margin-bottom: var(--spacing-lg) !important;
}

/* On fusionne les lignes entre elles en effaçant les contours natifs des cartes enfants */
.wireframe-table-container > * {
  margin: 0 !important;
  border: none !important;
  border-bottom: var(--border-width) solid var(--color-border) !important;
}

/* Suppression de la bordure de la dernière ligne pour éviter le passage à 4px en bas */
.wireframe-table-container > *:last-child {
  border-bottom: none !important;
}
</style>