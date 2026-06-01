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
    const clean = this.normalize(isbn);
    return /^(\d{10}|\d{13})$/.test(clean);
  },

  /**
   * Convertit un ISBN-10 en ISBN-13
   */
  toIsbn13(isbn10: string): string {
    const clean = this.normalize(isbn10);
    if (clean.length !== 10) return clean;
    const base = '978' + clean.substring(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(base[i], 10);
      sum += (i % 2 === 0) ? digit : digit * 3;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return base + checkDigit;
  }
};