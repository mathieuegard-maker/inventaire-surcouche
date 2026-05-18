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
   * Utilise une regex stricte pour bloquer les lettres et caractères spéciaux
   */
  isValidFormat(isbn: string): boolean {
    const cleanIsbn = this.normalize(isbn);
    return /^(\d{10}|\d{13})$/.test(cleanIsbn);
  }
};