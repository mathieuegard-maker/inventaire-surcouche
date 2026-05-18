// src/core/utils/isbn.util.ts

export const isbnUtil = {
  /**
   * Nettoie un ISBN en supprimant les tirets et les espaces
   */
  normalize(rawIsbn: string): string {
    if (!rawIsbn) return '';
    return rawIsbn.replace(/[-\s]/g, '');
  },

  /**
   * Vérifie si la longueur correspond à un format standard (10 ou 13 chiffres)
   * (Peut être enrichi plus tard avec un vrai calcul de Checksum)
   */
  isValidFormat(isbn: string): boolean {
    const cleanIsbn = this.normalize(isbn);
    return cleanIsbn.length === 10 || cleanIsbn.length === 13;
  }
};