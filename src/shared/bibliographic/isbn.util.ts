// src/shared/bibliographic/isbn.util.ts
// Validation, normalisation et conversion ISBN-10 / ISBN-13 + extrapolation codes presse FR (330/378/977).

export const isbnUtil = {
  normalize(rawIsbn: string): string {
    if (!rawIsbn) return '';
    return rawIsbn.replace(/[-\s]/g, '').toUpperCase();
  },

  isValidFormat(isbn: string): boolean {
    const clean = this.normalize(isbn);
    return /^(\d{9}[\dX]|\d{13})$/.test(clean);
  },

  isValidIsbn10(isbn10: string): boolean {
    const clean = this.normalize(isbn10);
    if (!/^\d{9}[\dX]$/.test(clean)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += parseInt(clean[i], 10) * (10 - i);
    }
    const check = clean[9] === 'X' ? 10 : parseInt(clean[9], 10);
    return (sum + check) % 11 === 0;
  },

  computeEan13CheckDigit(first12Digits: string): number {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(first12Digits[i], 10);
      sum += i % 2 === 0 ? digit : digit * 3;
    }
    return (10 - (sum % 10)) % 10;
  },

  isValidBookBarcode(isbn: string): boolean {
    const clean = this.normalize(isbn);
    if (!/^(978|979)\d{10}$/.test(clean)) return false;
    return this.computeEan13CheckDigit(clean.slice(0, 12)) === parseInt(clean[12], 10);
  },

  isBookOrPressEan13(rawIsbn?: string): boolean {
    const clean = (rawIsbn || '').replace(/[^0-9]/g, '');
    if (clean.length !== 13) return false;
    return /^(978|979|330|378|977)/.test(clean);
  },

  isFrancophoneBookIsbn13(rawIsbn?: string): boolean {
    const clean = (rawIsbn || '').replace(/[^0-9]/g, '');
    if (clean.length !== 13) return false;
    return /^(9782|97910|330|378|977)/.test(clean);
  },

  toIsbn13(isbn: string): string {
    const clean = this.normalize(isbn);
    if (/^(978|979)\d{10}$/.test(clean)) return clean;
    if (!/^\d{9}[\dX]$/.test(clean)) return clean;
    const base = '978' + clean.substring(0, 9);
    return base + this.computeEan13CheckDigit(base);
  },

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
  },

  /**
   * Normalise un code-barres (ISBN-10/13 ou code presse/kiosque 330/378/977) en ISBN-13 propres.
   */
  normalizeToIsbn13(raw?: string): string | null {
    if (!raw) return null;
    const clean = this.normalize(raw);
    if (this.isValidBookBarcode(clean)) return clean;
    if (this.isValidIsbn10(clean)) return this.toIsbn13(clean);
    if (/^(330|378|977)\d{10}$/.test(clean)) return clean;
    return null;
  }
};
