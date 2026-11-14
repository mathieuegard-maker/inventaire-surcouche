/**
 * Calcule la distance de Levenshtein entre deux chaînes de caractères (insensible à la casse et aux espaces aux extrémités).
 */
export function getLevenshteinDistance(a: string, b: string): number {
  const tmpA = (a || '').toLowerCase().trim();
  const tmpB = (b || '').toLowerCase().trim();

  if (tmpA.length === 0) return tmpB.length;
  if (tmpB.length === 0) return tmpA.length;

  const matrix: number[][] = [];

  // Initialisation de la matrice
  for (let i = 0; i <= tmpB.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= tmpA.length; j++) {
    matrix[0][j] = j;
  }

  // Calcul des distances
  for (let i = 1; i <= tmpB.length; i++) {
    for (let j = 1; j <= tmpA.length; j++) {
      if (tmpB.charAt(i - 1) === tmpA.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // suppression
        );
      }
    }
  }

  return matrix[tmpB.length][tmpA.length];
}
