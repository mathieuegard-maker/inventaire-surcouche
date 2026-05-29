// src/core/services/stats.service.ts
import { databaseService } from '../database/database.service';

export interface DashboardStats {
  totalOwned: number;
  totalWishlist: number;
  totalLoans: number;
  totalSeries: number;
  acquiredInPeriod: number;
  loansInPeriod: number;
  loanRate: number;
  topGenres: { name: string; count: number }[];
  topAuthors: { name: string; count: number }[];
}

export const statsService = {
  /**
   * Calcule les statistiques globales et périodiques de la bibliothèque à partir de Dexie
   * @param periodDays Période glissante en jours (-1 pour désactiver le filtre)
   */
  async getDashboardStats(periodDays: number): Promise<DashboardStats> {
    // 1. Récupération brute des registres et de la base
    const inventoryEntries = await databaseService.getAllRegistryEntries('inventory');
    const wishlistEntries = await databaseService.getAllRegistryEntries('wishlist');
    const loans = await databaseService.getAllLoans();
    const allBooks = await databaseService.getAllCachedBooks();

    const totalOwned = inventoryEntries.length;
    const totalWishlist = wishlistEntries.length;
    const totalLoans = loans.length;

    // 2. Nombre de sagas commencées
    // On matche les livres en cache qui appartiennent réellement à l'inventaire actuel
    const ownedUris = new Set(inventoryEntries.map(e => e.uri));
    const ownedBooks = allBooks.filter(b => ownedUris.has(b.uri) || (b.workUri && ownedUris.has(b.workUri)));
    const uniqueSeriesIds = new Set(ownedBooks.map(b => b.seriesId).filter(Boolean));
    const totalSeries = uniqueSeriesIds.size;

    // 3. Taux de prêt en pourcentage
    const loanRate = totalOwned > 0 ? Math.round((totalLoans / totalOwned) * 100) : 0;

    // 4. Acquisitions et prêts sur la période
    let acquiredInPeriod = 0;
    let loansInPeriod = 0;
    if (periodDays > 0) {
      const now = Date.now();
      const cutoff = now - (periodDays * 24 * 60 * 60 * 1000);
      acquiredInPeriod = inventoryEntries.filter(e => e.addedAt >= cutoff).length;
      loansInPeriod = loans.filter(l => l.loanDate >= cutoff).length;
    } else {
      acquiredInPeriod = totalOwned; // Tout l'historique
      loansInPeriod = totalLoans;
    }

    // 5. Calcul des Top Genres et Top Auteurs
    const genreCounts: Record<string, number> = {};
    const authorCounts: Record<string, number> = {};

    for (const book of ownedBooks) {
      // Extraction des genres
      if (book.genres && Array.isArray(book.genres)) {
        for (const genre of book.genres) {
          if (genre && genre.trim()) {
            const cleanGenre = genre.trim();
            genreCounts[cleanGenre] = (genreCounts[cleanGenre] || 0) + 1;
          }
        }
      }
      // Extraction des auteurs
      if (book.authors && Array.isArray(book.authors)) {
        for (const author of book.authors) {
          if (author && author.trim()) {
            const cleanAuthor = author.trim();
            authorCounts[cleanAuthor] = (authorCounts[cleanAuthor] || 0) + 1;
          }
        }
      }
    }

    const topGenres = Object.entries(genreCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const topAuthors = Object.entries(authorCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return {
      totalOwned,
      totalWishlist,
      totalLoans,
      totalSeries,
      acquiredInPeriod,
      loansInPeriod,
      loanRate,
      topGenres,
      topAuthors
    };
  }
};
