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

export interface DetailedStats extends DashboardStats {
  totalOneshots: number;
  totalPagesOwned: number;
  averagePages: number;
  completedSeriesCount: number;
  seriesCompletionRate: number;
  overdueLoansCount: number;
  readingCounts: {
    read: number;
    reading: number;
    to_read: number;
    abandoned: number;
    none: number;
  };
  ratedCount: number;
  averageRating: number;
  topPublishers: { name: string; count: number }[];
  topSeries: { name: string; owned: number; knownTotal: number }[];
  borrowers: { name: string; count: number; maxDays: number }[];
}

export const statsService = {
  /**
   * Calcule les statistiques détaillées pour la page KPI dédiée.
   */
  async getDetailedStats(periodDays: number): Promise<DetailedStats> {
    const base = await this.getDashboardStats(periodDays);
    const inventoryEntries = await databaseService.getAllRegistryEntries('inventory');
    const loans = await databaseService.getAllLoans();
    const allBooks = await databaseService.getAllCachedBooks();

    const ownedUris = new Set(inventoryEntries.map((e) => e.uri));
    const ownedBooks = allBooks.filter(
      (b) => b.ownershipStatus === 'owned' || ownedUris.has(b.uri) || (b.workUri && ownedUris.has(b.workUri))
    );

    const totalOneshots = ownedBooks.filter((b) => !b.seriesId && !b.series?.trim()).length;
    const pagesList = ownedBooks.map((b) => Number(b.pageCount) || 0).filter((p) => p > 0);
    const totalPagesOwned = pagesList.reduce((acc, p) => acc + p, 0);
    const averagePages = pagesList.length > 0 ? Math.round(totalPagesOwned / pagesList.length) : 0;

    // Groupement par série (possédés vs connus au catalogue)
    const seriesMap = new Map<string, { name: string; owned: number; knownUris: Set<string> }>();
    for (const b of allBooks) {
      const sKey = b.seriesId || b.series?.trim();
      if (!sKey) continue;
      const entry = seriesMap.get(sKey) || { name: b.series?.trim() || sKey, owned: 0, knownUris: new Set() };
      if (b.series?.trim()) entry.name = b.series.trim();
      entry.knownUris.add(b.uri);
      if (b.ownershipStatus === 'owned' || ownedUris.has(b.uri) || (b.workUri && ownedUris.has(b.workUri))) {
        entry.owned++;
      }
      seriesMap.set(sKey, entry);
    }

    const startedSeries = Array.from(seriesMap.values()).filter((s) => s.owned > 0);
    const completedSeriesCount = startedSeries.filter((s) => s.knownUris.size > 0 && s.owned >= s.knownUris.size).length;
    const seriesCompletionRate =
      startedSeries.length > 0 ? Math.round((completedSeriesCount / startedSeries.length) * 100) : 0;

    const topSeries = startedSeries
      .map((s) => ({ name: s.name, owned: s.owned, knownTotal: Math.max(s.owned, s.knownUris.size) }))
      .sort((a, b) => b.owned - a.owned || a.name.localeCompare(b.name, 'fr'))
      .slice(0, 8);

    // Top Genres, Auteurs et Éditeurs (jusqu'à 10)
    const genreCounts: Record<string, number> = {};
    const authorCounts: Record<string, number> = {};
    const publisherCounts: Record<string, number> = {};
    const readingCounts = { read: 0, reading: 0, to_read: 0, abandoned: 0, none: 0 };
    let ratingSum = 0;
    let ratedCount = 0;

    for (const book of ownedBooks) {
      for (const g of book.genres || []) {
        const c = g?.trim();
        if (c && !c.startsWith('wd:')) genreCounts[c] = (genreCounts[c] || 0) + 1;
      }
      for (const a of book.authors || []) {
        const c = a?.trim();
        if (c && !c.startsWith('wd:')) authorCounts[c] = (authorCounts[c] || 0) + 1;
      }
      const pub = book.publisher?.trim();
      if (pub && !pub.startsWith('wd:') && !pub.startsWith('inv:')) {
        publisherCounts[pub] = (publisherCounts[pub] || 0) + 1;
      }

      let metaStatus: keyof typeof readingCounts = 'none';
      let metaRating = 0;
      if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(`biblio_reading_${book.uri}`);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.status && parsed.status in readingCounts) {
              metaStatus = parsed.status;
            }
            metaRating = Number(parsed.rating) || 0;
          }
        } catch {
          // ignore
        }
      }
      readingCounts[metaStatus]++;
      if (metaRating > 0) {
        ratingSum += metaRating;
        ratedCount++;
      }
    }

    const sortTop = (rec: Record<string, number>, limit: number) =>
      Object.entries(rec)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

    // Prêts & emprunteurs
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const overdueLoansCount = loans.filter((l) => now - l.loanDate > 30 * DAY_MS).length;
    const borrowerMap = new Map<string, { name: string; count: number; maxDays: number }>();
    for (const loan of loans) {
      const name = (loan.friendName || 'Inconnu').trim() || 'Inconnu';
      const days = Math.max(0, Math.floor((now - loan.loanDate) / DAY_MS));
      const existing = borrowerMap.get(name);
      if (existing) {
        existing.count++;
        existing.maxDays = Math.max(existing.maxDays, days);
      } else {
        borrowerMap.set(name, { name, count: 1, maxDays: days });
      }
    }
    const borrowers = Array.from(borrowerMap.values()).sort((a, b) => b.count - a.count || b.maxDays - a.maxDays);

    return {
      ...base,
      totalOneshots,
      totalPagesOwned,
      averagePages,
      completedSeriesCount,
      seriesCompletionRate,
      overdueLoansCount,
      readingCounts,
      ratedCount,
      averageRating: ratedCount > 0 ? Math.round((ratingSum / ratedCount) * 10) / 10 : 0,
      topGenres: sortTop(genreCounts, 10),
      topAuthors: sortTop(authorCounts, 10),
      topPublishers: sortTop(publisherCounts, 6),
      topSeries,
      borrowers
    };
  },

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

    const findCachedBookForUri = (uri: string) => {
      for (const b of allBooks) {
        if (
          b.uri === uri ||
          b.workUri === uri ||
          b.bookId === uri ||
          (b.bookId && `v4:${b.bookId}` === uri) ||
          (b.bookId && `book:${b.bookId}` === uri) ||
          (b.isbn13 && `isbn:${b.isbn13}` === uri)
        ) {
          return b;
        }
      }
      return undefined;
    };

    const canonicalBookKey = (b: (typeof allBooks)[0]) =>
      b.bookId || b.workUri || b.isbn13 || b.uri;

    const ownedUris = new Set(inventoryEntries.map((e) => e.uri));
    const ownedBookMap = new Map<string, (typeof allBooks)[0]>();
    for (const b of allBooks) {
      if (b.ownershipStatus === 'owned' || ownedUris.has(b.uri) || (b.workUri && ownedUris.has(b.workUri))) {
        const key = canonicalBookKey(b);
        if (!ownedBookMap.has(key)) ownedBookMap.set(key, b);
      }
    }
    const ownedBooks = Array.from(ownedBookMap.values());
    const distinctOwnedKeys = new Set<string>(ownedBookMap.keys());
    for (const entry of inventoryEntries) {
      const matched = findCachedBookForUri(entry.uri);
      if (matched) {
        distinctOwnedKeys.add(canonicalBookKey(matched));
      } else {
        distinctOwnedKeys.add(entry.uri);
      }
    }
    const totalOwned = distinctOwnedKeys.size;
    const totalLoans = loans.length;

    // 2. Déduplication canonique de la wishlist (évite double comptage work + edition + v4)
    const distinctWishKeys = new Set<string>();
    for (const b of allBooks) {
      if (b.ownershipStatus === 'wish') {
        distinctWishKeys.add(canonicalBookKey(b));
      }
    }
    for (const entry of wishlistEntries) {
      const matched = findCachedBookForUri(entry.uri);
      if (matched) {
        if (matched.ownershipStatus === 'wish') {
          distinctWishKeys.add(canonicalBookKey(matched));
        }
      } else {
        distinctWishKeys.add(entry.uri);
      }
    }
    const totalWishlist = distinctWishKeys.size;

    // 2b. Nombre de sagas commencées
    const uniqueSeriesIds = new Set(
      ownedBooks
        .map((b) => b.seriesId || (b.series?.trim() ? b.series.trim().toLowerCase() : ''))
        .filter(Boolean)
    );
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
