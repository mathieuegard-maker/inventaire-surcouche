import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkBookIndexLayer2,
  consolidateBookLayer4,
  getV4SeriesBooks,
  linkBookToLibrary,
  syncV4LibraryBooks,
  updateV4BookMetadata
} from '../../src/core/services/v4-pipeline.service';
import {
  clearUserPhotoScanJobs,
  listUserPhotoScanJobs
} from '../../src/core/services/photo-scan-jobs.service';
import { FsCoverBucketAdapter } from './fs-cover-bucket.adapter';
import { SqliteDatabaseAdapter } from './sqlite-db.adapter';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

describe('Self-hosted adapters (SQLite + FS Cover Bucket)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applique les 12 migrations SQL réelles de manière idempotente et exécute le pipeline V4 + Option B sur SQLite', async () => {
    const db = new SqliteDatabaseAdapter(':memory:');
    try {
      const firstRun = db.applyMigrations(MIGRATIONS_DIR);
      expect(firstRun.applied.length).toBeGreaterThanOrEqual(12);
      expect(firstRun.skipped).toBe(0);

      // Idempotence : relancer ne réapplique rien
      const secondRun = db.applyMigrations(MIGRATIONS_DIR);
      expect(secondRun.applied).toHaveLength(0);
      expect(secondRun.skipped).toBe(firstRun.applied.length);

      // Créer un utilisateur + foyer minimal pour satisfaire les FK SQLite
      const now = new Date().toISOString();
      await db
        .prepare(
          'INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind('u1', 'test@mathieuegardtest.fr', 'hash', 'Test', now, now)
        .run();
      await db
        .prepare('INSERT INTO libraries (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind('lib_1', 'Foyer Test', 'u1', now, now)
        .run();

      // Consolidation FRBR V4 sur vrai SQLite
      const book = await consolidateBookLayer4(
        db,
        {
          anchorIsbn13: '9782012101333',
          anchorTitle: 'Astérix le Gaulois',
          language: 'fre',
          sisterEditions: [
            {
              source: 'bnf',
              isbn13: '9782012101333',
              title: 'Astérix le Gaulois',
              seriesRaw: 'Astérix',
              volumeNumber: '1',
              language: 'fre',
              coverUrl: 'https://covers.example/asterix1.jpg'
            }
          ],
          seriesCandidates: [
            { source: 'bnf', rawName: 'Astérix', coreKey: 'asterix', cleanDisplay: 'Astérix', weight: 4 }
          ],
          authors: ['René Goscinny', 'Albert Uderzo'],
          illustrators: [],
          scriptwriters: [],
          rawSubjects: ['BD'],
          rawTitles: ['Astérix le Gaulois'],
          sourcesHit: ['bnf']
        },
        { sourceChannel: 'canal_1_barcode', libraryId: 'lib_1', action: 'owned' }
      );

      expect(book.id).toBeTruthy();
      expect(book.seriesName).toBe('Astérix');

      // Vérification Couche 2 O(1)
      const l2 = await checkBookIndexLayer2(db, '9782012101333', 'lib_1');
      expect(l2.status).toBe('ALREADY_OWNED');
      expect(l2.book?.canonicalTitle).toBe('Astérix le Gaulois');

      // Option B : surcharge privée de couverture/titre pour lib_1
      const updated = await updateV4BookMetadata(db, {
        bookId: book.id,
        libraryId: 'lib_1',
        title: 'Astérix le Gaulois (Édition Perso)',
        coverUrl: 'https://covers.example/custom.jpg'
      });
      expect(updated?.canonicalTitle).toBe('Astérix le Gaulois (Édition Perso)');

      // Lecture série sur SQLite (stub fetch pour rester 100 % offline et déterministe)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
      try {
        await db.prepare('UPDATE v4_series SET is_complete_expanded = 1 WHERE id = ?').bind(book.seriesId).run();
        const seriesRes = await getV4SeriesBooks(db, { seriesId: book.seriesId!, libraryId: 'lib_1' });
        expect(seriesRes.books).toHaveLength(1);
        expect(seriesRes.books[0].ownershipStatus).toBe('owned');
        expect(seriesRes.books[0].book.canonicalTitle).toBe('Astérix le Gaulois (Édition Perso)');

        // Migration 0013 : suivi du membre du foyer ayant ajouté un livre à la wishlist
        await db
          .prepare(
            'INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind('u2', 'alice@mathieuegardtest.fr', 'hash', 'Alice', now, now)
          .run();
        const wishedBook = await consolidateBookLayer4(
          db,
          {
            anchorIsbn13: '9782012101340',
            anchorTitle: 'La Serpe d’or',
            language: 'fre',
            sisterEditions: [
              {
                source: 'bnf',
                isbn13: '9782012101340',
                title: 'La Serpe d’or',
                seriesRaw: 'Astérix',
                volumeNumber: '2',
                language: 'fre'
              }
            ],
            seriesCandidates: [
              { source: 'bnf', rawName: 'Astérix', coreKey: 'asterix', cleanDisplay: 'Astérix', weight: 4 }
            ],
            authors: ['René Goscinny'],
            illustrators: [],
            scriptwriters: [],
            rawSubjects: ['BD'],
            rawTitles: ['La Serpe d’or'],
            sourcesHit: ['bnf']
          },
          { sourceChannel: 'canal_3_text_search', libraryId: 'lib_1', action: 'preview' }
        );
        await linkBookToLibrary(db, {
          libraryId: 'lib_1',
          bookId: wishedBook.id,
          isOwned: false,
          isWished: true,
          wishedByUserId: 'u2',
          sourceChannel: 'canal_3_text_search'
        });
        const syncRes = await syncV4LibraryBooks(db, { libraryId: 'lib_1' });
        const syncedWish = syncRes.books.find((item) => item.book.id === wishedBook.id);
        expect(syncedWish?.ownershipStatus).toBe('wish');
        expect(syncedWish?.book.wishedByUserId).toBe('u2');
        expect(syncedWish?.book.wishedByName).toBe('Alice');

        // Chantier 1 : conversion Option B d'un livre en Intégrale (tomes 1 à 2)
        const asIntegral = await updateV4BookMetadata(db, {
          bookId: book.id,
          libraryId: 'lib_1',
          isIntegral: true,
          includedVolumeNumbers: ['1', '2']
        });
        expect(asIntegral?.isIntegral).toBe(true);
        expect(asIntegral?.integralMetadata.includedVolumeNumbers).toEqual(['1', '2']);
        expect(asIntegral?.integralMetadata.includedWorkIds).toContain(wishedBook.id);

        // Migration 0014 : isolation stricte des lots Photo IA serveur par utilisateur
        await db
          .prepare(
            `INSERT INTO photo_scan_jobs (id, user_id, library_id, mode, status, image_data_url, mime_type, candidates_count, progress_done, created_at, updated_at)
             VALUES (?, ?, ?, 'shelf', 'done', 'data:image/webp;base64,AA==', 'image/webp', 2, 2, ?, ?)`
          )
          .bind('pjob_u1', 'u1', 'lib_1', now, now)
          .run();
        await db
          .prepare(
            `INSERT INTO photo_scan_jobs (id, user_id, library_id, mode, status, image_data_url, mime_type, candidates_count, progress_done, created_at, updated_at)
             VALUES (?, ?, ?, 'shelf', 'done', 'data:image/webp;base64,AA==', 'image/webp', 1, 1, ?, ?)`
          )
          .bind('pjob_u2', 'u2', 'lib_1', now, now)
          .run();

        const u1Jobs = await listUserPhotoScanJobs(db, 'u1');
        const u2Jobs = await listUserPhotoScanJobs(db, 'u2');
        expect(u1Jobs.map((j) => j.id)).toEqual(['pjob_u1']);
        expect(u2Jobs.map((j) => j.id)).toEqual(['pjob_u2']);
        await clearUserPhotoScanJobs(db, 'u1');
        expect(await listUserPhotoScanJobs(db, 'u1')).toHaveLength(0);
        expect(await listUserPhotoScanJobs(db, 'u2')).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      db.close();
    }
  });

  it('FsCoverBucketAdapter stocke, relit et supprime proprement les couvertures sur disque', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-covers-'));
    tempDirs.push(tmpDir);
    const bucket = new FsCoverBucketAdapter(tmpDir);

    const payload = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x20]);
    await bucket.put('covers/9782012101333.webp', payload, {
      httpMetadata: { contentType: 'image/webp' }
    });

    const hit = await bucket.get('covers/9782012101333.webp');
    expect(hit).not.toBeNull();
    expect(hit?.httpMetadata?.contentType).toBe('image/webp');
    const ab = await hit!.arrayBuffer!();
    expect(new Uint8Array(ab)).toEqual(payload);

    await bucket.delete('covers/9782012101333.webp');
    expect(await bucket.get('covers/9782012101333.webp')).toBeNull();
  });
});
