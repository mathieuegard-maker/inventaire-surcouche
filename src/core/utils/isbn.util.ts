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
   * Vérifie si un ISBN-13 possède un préfixe livre valide (978 ou 979) et une clé de contrôle EAN-13 valide.
   * Indispensable pour le scanner caméra afin d'éliminer les lectures floues (ex: 578..., 9780025...).
   */
  isValidBookBarcode(isbn: string): boolean {
    const clean = this.normalize(isbn);
    if (!/^(978|979)\d{10}$/.test(clean)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(clean[i], 10);
      sum += i % 2 === 0 ? digit : digit * 3;
    }
    const expectedCheck = (10 - (sum % 10)) % 10;
    return expectedCheck === parseInt(clean[12], 10);
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
  },

  /**
   * Convertit un ISBN-13 (préfixe 978) en ISBN-10 (utile pour certains CDN éditeurs/librairies)
   */
  toIsbn10(isbn13: string): string | null {
    const clean = this.normalize(isbn13);
    if (!/^978\d{10}$/.test(clean)) return null;
    const core = clean.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += Number(core[i]) * (10 - i);
    }
    const rem = (11 - (sum % 11)) % 11;
    return `${core}${rem === 10 ? 'X' : String(rem)}`;
  }
};