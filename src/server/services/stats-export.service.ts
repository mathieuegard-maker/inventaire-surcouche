// src/server/services/stats-export.service.ts
// Service Statistiques (Foyer + Lecture individuelle user_id) & Export utilisateur CSV (UTF-8 BOM) / JSON.

import type { LibraryService } from './library.service';

export interface RankedStatItem {
  label: string;
  count: number;
}

export interface LibraryStatsPayload {
  periodDays: number | null;
  kpis: {
    ownedCount: number;
    coveredVolumesCount: number;
    wishedCount: number;
    lentCount: number;
    seriesCount: number;
    addedInPeriodCount: number;
    totalPages: number;
  };
  reading: {
    readCount: number;
    readingCount: number;
    toReadCount: number;
    abandonedCount: number;
    ratedCount: number;
    averageRating: number | null;
  };
  tops: {
    genres: RankedStatItem[];
    authors: RankedStatItem[];
    series: RankedStatItem[];
    publishers: RankedStatItem[];
  };
  activeLoans: Array<{
    bookId: string;
    title: string;
    borrowerName: string;
    loanedAt: string;
  }>;
}

function topN(map: Map<string, number>, n = 10): RankedStatItem[] {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fr'))
    .slice(0, n);
}

function escapeCsvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[;"\r\n,]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export class StatsExportService {
  private readonly libraryService: LibraryService;

  constructor(deps: { libraryService: LibraryService }) {
    this.libraryService = deps.libraryService;
  }

  computeStats(libraryId: string, userId: string, periodDays: number | null): LibraryStatsPayload {
    const snap = this.libraryService.buildSyncPullPayload(libraryId, userId);
    const owned = snap.books.filter((b) => b.ownershipStatus === 'owned');
    const wished = snap.books.filter((b) => b.ownershipStatus === 'wish');
    const lent = snap.books.filter((b) => Boolean(b.activeLoan));

    const cutoffIso =
      periodDays && periodDays > 0
        ? new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

    const addedInPeriodCount = cutoffIso
      ? owned.filter((b) => b.updatedAt >= cutoffIso).length
      : owned.length;

    let totalPages = 0;
    const genreCounts = new Map<string, number>();
    const authorCounts = new Map<string, number>();
    const seriesCounts = new Map<string, number>();
    const publisherCounts = new Map<string, number>();

    let readCount = 0;
    let readingCount = 0;
    let toReadCount = 0;
    let abandonedCount = 0;
    let ratingSum = 0;
    let ratedCount = 0;

    for (const book of owned) {
      if (book.pageCount && book.pageCount > 0) totalPages += book.pageCount;

      for (const g of book.genres) {
        genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
      }
      for (const a of book.authors) {
        authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1);
      }
      if (book.seriesName) {
        seriesCounts.set(book.seriesName, (seriesCounts.get(book.seriesName) ?? 0) + 1);
      }
      if (book.publisher) {
        publisherCounts.set(book.publisher, (publisherCounts.get(book.publisher) ?? 0) + 1);
      }

      const rs = book.readingState;
      if (rs) {
        if (rs.status === 'read') readCount++;
        else if (rs.status === 'reading') readingCount++;
        else if (rs.status === 'to_read') toReadCount++;
        else if (rs.status === 'abandoned') abandonedCount++;

        if (rs.rating > 0) {
          ratingSum += rs.rating;
          ratedCount++;
        }
      }
    }

    let coveredVolumesCount = 0;
    for (const book of owned) {
      if (book.isIntegral && book.includedVolumes.length > 0) {
        coveredVolumesCount += book.includedVolumes.length;
      } else if (!book.ownedViaIntegral) {
        coveredVolumesCount += 1;
      }
    }

    return {
      periodDays,
      kpis: {
        ownedCount: owned.length,
        coveredVolumesCount: Math.max(owned.length, coveredVolumesCount),
        wishedCount: wished.length,
        lentCount: lent.length,
        seriesCount: snap.series.filter((s) => s.ownedCount > 0).length,
        addedInPeriodCount,
        totalPages
      },
      reading: {
        readCount,
        readingCount,
        toReadCount,
        abandonedCount,
        ratedCount,
        averageRating: ratedCount > 0 ? Math.round((ratingSum / ratedCount) * 10) / 10 : null
      },
      tops: {
        genres: topN(genreCounts, 10),
        authors: topN(authorCounts, 10),
        series: topN(seriesCounts, 10),
        publishers: topN(publisherCounts, 10)
      },
      activeLoans: lent.map((b) => ({
        bookId: b.id,
        title: b.title,
        borrowerName: b.activeLoan?.borrowerName ?? '',
        loanedAt: b.activeLoan?.loanedAt ?? ''
      }))
    };
  }

  exportLibrary(
    libraryId: string,
    userId: string,
    format: 'csv' | 'json'
  ): { contentType: string; filename: string; body: string } {
    const snap = this.libraryService.buildSyncPullPayload(libraryId, userId);
    const dateSlug = new Date().toISOString().slice(0, 10);

    const rows = snap.books.map((b) => ({
      id: b.id,
      titre: b.title,
      serie: b.seriesName ?? '',
      tome: b.volumeLabel ?? '',
      integrale: b.isIntegral ? 'Oui' : 'Non',
      tomesInclus: b.includedVolumes.join(', '),
      auteurs: b.authors.join(', '),
      editeur: b.publisher ?? '',
      annee: b.publishYear ?? '',
      pages: b.pageCount ?? '',
      categorie: b.mainCategory,
      genres: b.genres.join(', '),
      isbn: b.primaryIsbn13 ?? '',
      statutFoyer: b.ownershipStatus,
      preteA: b.activeLoan?.borrowerName ?? '',
      lecturePerso: b.readingState?.status ?? 'none',
      notePerso: b.readingState?.rating ?? 0,
      notesPerso: b.readingState?.notes ?? ''
    }));

    if (format === 'json') {
      return {
        contentType: 'application/json; charset=utf-8',
        filename: `biblio-export-${dateSlug}.json`,
        body: JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            count: rows.length,
            books: rows
          },
          null,
          2
        )
      };
    }

    const headers = [
      'ID',
      'Titre',
      'Série',
      'Tome',
      'Intégrale',
      'Tomes inclus',
      'Auteurs',
      'Éditeur',
      'Année',
      'Pages',
      'Catégorie',
      'Genres',
      'ISBN',
      'Statut',
      'Prêté à',
      'Lecture',
      'Note',
      'Notes personnelles'
    ];

    const lines = [
      headers.map(escapeCsvCell).join(';'),
      ...rows.map((r) =>
        [
          r.id,
          r.titre,
          r.serie,
          r.tome,
          r.integrale,
          r.tomesInclus,
          r.auteurs,
          r.editeur,
          r.annee,
          r.pages,
          r.categorie,
          r.genres,
          r.isbn,
          r.statutFoyer,
          r.preteA,
          r.lecturePerso,
          r.notePerso,
          r.notesPerso
        ]
          .map(escapeCsvCell)
          .join(';')
      )
    ];

    return {
      contentType: 'text/csv; charset=utf-8',
      filename: `biblio-export-${dateSlug}.csv`,
      body: `\uFEFF${lines.join('\r\n')}`
    };
  }
}
