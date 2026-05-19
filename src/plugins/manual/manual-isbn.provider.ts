// src/plugins/manual/manual-isbn.provider.ts

export const manualIsbnProvider = {
  /**
   * Injecte le HTML de recherche dans un conteneur et configure l'écouteur
   */
  setup(containerId: string, onSearch: (isbn: string) => void) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
      <div class="plugin-manual-container">
        <h3>Acquisition Manuelle</h3>
        <div class="plugin-manual-form">
          <input type="text" id="manual-isbn-input" class="plugin-manual-input" placeholder="Entrez un ISBN (ex: 9782012101333)">
          <button id="manual-isbn-btn" class="btn-action">Rechercher</button>
        </div>
      </div>
    `;

    const btn = document.getElementById('manual-isbn-btn');
    const input = document.getElementById('manual-isbn-input') as HTMLInputElement;

    btn?.addEventListener('click', () => {
      const value = input.value.trim().replace(/-/g, ''); // Nettoyage de base
      if (value) {
        onSearch(value);
      }
    });
  }
};