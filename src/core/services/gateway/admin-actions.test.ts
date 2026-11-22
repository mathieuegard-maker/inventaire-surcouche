import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../../../../server/adapters/sqlite-db.adapter';
import * as d1Gateway from '../d1-gateway.service';
import { handleAdminGatewayAction } from './admin-actions';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

describe('admin-actions — édition unitaire et modification groupée du catalogue', () => {
  it('applique une modification groupée (éditeur, catégorie principale, série) sur plusieurs tomes dans catalog_entities et books V4 sans écraser les autres champs', async () => {
    const db = new SqliteDatabaseAdapter(':memory:');
    try {
      db.applyMigrations(MIGRATIONS_DIR);
      const now = '2026-11-22T18:00:00.000Z';

      await db
        .prepare('INSERT INTO users (id, email, password_hash, display_name, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .bind('admin_1', 'admin@example.fr', 'hash', 'Admin', now, now)
        .run();
      await db
        .prepare('INSERT INTO libraries (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind('lib_admin', 'Foyer Admin', 'admin_1', now, now)
        .run();

      const seedTomes = [
        { uri: 'isbn:9782365770125', id: 'bk_f1', title: 'Fables T.1', num: '1', cover: 'https://img.example/f1.jpg' },
        { uri: 'isbn:9782365770132', id: 'bk_f2', title: 'Fables T.2', num: '2', cover: 'https://img.example/f2.jpg' },
        { uri: 'isbn:9782365770149', id: 'bk_f3', title: 'Fables T.3', num: '3', cover: 'https://img.example/f3.jpg' }
      ];

      for (const t of seedTomes) {
        await db
          .prepare(
            `INSERT INTO catalog_entities (uri, entity_type, label, normalized_label, image_url, main_category, series_number, entity_json, created_at, updated_at)
             VALUES (?, 'edition', ?, ?, ?, 'BD', ?, ?, ?, ?)`
          )
          .bind(
            t.uri,
            t.title,
            t.title.toLowerCase(),
            t.cover,
            t.num,
            JSON.stringify({ label: t.title, publisher: 'Ancien Éditeur', publishDate: '2010' }),
            now,
            now
          )
          .run();

        await db
          .prepare(
            `INSERT INTO books
              (id, work_canonical_id, canonical_title, normalized_title, volume_number, volume_label, authors_json, language, known_isbns_json, editions_catalog_json, selected_cover_url, main_category, subgenres_json, legacy_entity_uri, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, '["Bill Willingham"]', 'fr', ?, ?, ?, 'BD', '[]', ?, ?, ?)`
          )
          .bind(
            t.id,
            `work:${t.id}`,
            t.title,
            t.title.toLowerCase(),
            Number(t.num),
            t.num,
            JSON.stringify([t.uri.slice(5)]),
            JSON.stringify([{ isbn13: t.uri.slice(5), publisher: 'Ancien Éditeur', publicationYear: '2010' }]),
            t.cover,
            t.uri,
            now,
            now
          )
          .run();
      }

      vi.spyOn(d1Gateway, 'resolveAuthSession').mockResolvedValue({
        userId: 'admin_1',
        libraryId: 'lib_admin',
        email: 'admin@example.fr',
        displayName: 'Admin',
        isAdmin: true
      } as any);

      const req = new Request('https://biblio.mathieuegardtest.fr/api/gateway?action=admin-catalog-bulk-update', {
        method: 'POST'
      });
      const resp = await handleAdminGatewayAction({
        action: 'admin-catalog-bulk-update',
        db,
        env: { DB: db },
        request: req,
        url: new URL(req.url),
        body: {
          uris: ['isbn:9782365770125', 'isbn:9782365770132'],
          patch: {
            publisher: 'Urban Comics',
            main_category: 'Comics',
            series_name: 'Fables'
          }
        },
        now: '2026-11-22T18:45:00.000Z'
      });

      expect(resp?.status).toBe(200);
      const data = (await resp!.json()) as { ok: boolean; updatedCount: number; updatedV4Count: number };
      expect(data).toEqual({ ok: true, requestedCount: 2, updatedCount: 2, updatedV4Count: 2 });

      // Vérifier Tome 1 & Tome 2 mis à jour dans catalog_entities ET books V4 sans toucher au titre/couverture/tome
      const ce1 = await db
        .prepare('SELECT label, image_url, main_category, series_number, entity_json FROM catalog_entities WHERE uri = ?')
        .bind('isbn:9782365770125')
        .first<any>();
      expect(ce1.label).toBe('Fables T.1');
      expect(ce1.image_url).toBe('https://img.example/f1.jpg');
      expect(ce1.main_category).toBe('Comics');
      expect(ce1.series_number).toBe('1');
      expect(JSON.parse(ce1.entity_json).publisher).toBe('Urban Comics');
      expect(JSON.parse(ce1.entity_json).publishDate).toBe('2010');

      const bk2 = await db
        .prepare('SELECT canonical_title, main_category, series_name, selected_cover_url, editions_catalog_json FROM books WHERE id = ?')
        .bind('bk_f2')
        .first<any>();
      expect(bk2.canonical_title).toBe('Fables T.2');
      expect(bk2.main_category).toBe('Comics');
      expect(bk2.series_name).toBe('Fables');
      expect(bk2.selected_cover_url).toBe('https://img.example/f2.jpg');
      expect(JSON.parse(bk2.editions_catalog_json)[0].publisher).toBe('Urban Comics');
      expect(JSON.parse(bk2.editions_catalog_json)[0].publicationYear).toBe('2010');

      // Vérifier Tome 3 (non sélectionné) strictement intact
      const bk3 = await db
        .prepare('SELECT main_category, editions_catalog_json FROM books WHERE id = ?')
        .bind('bk_f3')
        .first<any>();
      expect(bk3.main_category).toBe('BD');
      expect(JSON.parse(bk3.editions_catalog_json)[0].publisher).toBe('Ancien Éditeur');
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });

  it('refuse la modification groupée aux utilisateurs non administrateurs (403)', async () => {
    const db = new SqliteDatabaseAdapter(':memory:');
    try {
      db.applyMigrations(MIGRATIONS_DIR);
      const now = '2026-11-22T18:00:00.000Z';
      await db
        .prepare('INSERT INTO users (id, email, password_hash, display_name, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .bind('u_std', 'std@example.fr', 'hash', 'Standard', now, now)
        .run();

      vi.spyOn(d1Gateway, 'resolveAuthSession').mockResolvedValue({
        userId: 'u_std',
        libraryId: 'lib_std',
        email: 'std@example.fr',
        displayName: 'Standard',
        isAdmin: false
      } as any);

      const req = new Request('https://biblio.mathieuegardtest.fr/api/gateway?action=admin-catalog-bulk-update', {
        method: 'POST'
      });
      const resp = await handleAdminGatewayAction({
        action: 'admin-catalog-bulk-update',
        db,
        env: { DB: db },
        request: req,
        url: new URL(req.url),
        body: { uris: ['isbn:9782365770125'], patch: { publisher: 'Urban Comics' } },
        now
      });
      expect(resp?.status).toBe(403);
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });
});
