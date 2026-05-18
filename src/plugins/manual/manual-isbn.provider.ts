// src/providers/manual-isbn.provider.ts

export const manualIsbnProvider = {
  /**
   * Injecte le HTML de recherche dans un conteneur et configure l'écouteur
   */
  setup(containerId: string, onSearch: (isbn: string) => void) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
      <div class="acquisition-box" style="margin-top: 20px; padding: 15px; border: 1px dashed #ccc;">
        <h3>Acquisition Manuelle</h3>
        <input type="text" id="manual-isbn-input" placeholder="Entrez un ISBN (ex: 9782012101333)" style="width: 70%; padding: 8px;">
        <button id="manual-isbn-btn" style="padding: 8px 15px; cursor: pointer;">Rechercher</button>
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