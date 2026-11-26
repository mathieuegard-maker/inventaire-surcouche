// src/server/routes/collection-import.test.ts
// Tests d'intégration de l'import CSV / JSON / Excel (.xlsx) :
// Règle stricte du pivot ISBN-13 (ISBN direct, résolution titre->BnF->ISBN, zéro création sans ISBN pour les non trouvés).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDatabaseAdapter } from '../db/sqlite.adapter';
import { applySqlMigrations } from '../db/migrator';
import { loadServerConfig } from '../config';
import { createApp } from '../app';
import type { BibliographicConnectors } from '../connectors/types';
import type { CollectionImportResultPayload } from '../services/collection-import.service';

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/biblio_session=([^;]+)/);
  if (!m) throw new Error('Cookie manquant');
  return `biblio_session=${m[1]}`;
}

/**
 * Construit un véritable fichier Excel `.xlsx` (archive ZIP STORE conforme OOXML) en mémoire sans dépendance externe.
 */
function buildMinimalXlsxBuffer(rows: Array<Array<string | number>>): Buffer {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const sheetRowsXml = rows
    .map((cells, rIdx) => {
      const cellsXml = cells
        .map((val, cIdx) => {
          const colLetter = String.fromCharCode(65 + cIdx);
          const ref = `${colLetter}${rIdx + 1}`;
          if (typeof val === 'number') {
            return `<c r="${ref}"><v>${val}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(val))}</t></is></c>`;
        })
        .join('');
      return `<row r="${rIdx + 1}">${cellsXml}</row>`;
    })
    .join('');

  const files: Array<{ name: string; content: Buffer }> = [
    {
      name: '[Content_Types].xml',
      content: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
        'utf8'
      )
    },
    {
      name: '_rels/.rels',
      content: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
        'utf8'
      )
    },
    {
      name: 'xl/workbook.xml',
      content: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Collection" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'utf8'
      )
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
        'utf8'
      )
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<sheetData>${sheetRowsXml}</sheetData></worksheet>`,
        'utf8'
      )
    }
  ];

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = file.content;
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // STORE
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

describe('POST /api/me/import — Import CSV / JSON / Excel (.xlsx) à pivot ISBN-13 strict', () => {
  let db: SqliteDatabaseAdapter;
  let tmpRootDir: string;
  let tmpCoversDir: string;
  let appCtx: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    applySqlMigrations(db, path.resolve(process.cwd(), 'migrations'));
    tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblio-imp-'));
    tmpCoversDir = path.join(tmpRootDir, 'covers');
    fs.mkdirSync(tmpCoversDir, { recursive: true });

    const mockConnectors: BibliographicConnectors = {
      bnf: {
        async lookupByIsbn(isbn13) {
          if (isbn13 === '9782871293019') {
            return {
              source: 'bnf',
              isbn13,
              title: 'La Marque du diable',
              seriesName: 'Le Scorpion',
              seriesLinkKind: 'marc_ensemble_460',
              volumeNumber: '1',
              authors: ['Stephen Desberg', 'Enrico Marini'],
              scriptwriters: ['Stephen Desberg'],
              illustrators: ['Enrico Marini'],
              publisher: 'Dargaud',
              rawSubjects: ['Bandes dessinées']
            };
          }
          if (isbn13 === '9782205051230') {
            return {
              source: 'bnf',
              isbn13,
              title: 'Blacksad : Quelque part entre les ombres',
              seriesName: 'Blacksad',
              seriesLinkKind: 'marc_ensemble_460',
              volumeNumber: '1',
              authors: ['Juan Díaz Canales', 'Juanjo Guarnido'],
              scriptwriters: [],
              illustrators: [],
              publisher: 'Dargaud',
              rawSubjects: ['Bandes dessinées']
            };
          }
          return null;
        },
        async searchByEnsembleId() { return []; },
        async sampleByCollectionName() { return []; },
        async searchByTitleAndAuthor(title) {
          if (title.toLowerCase().includes('blacksad')) {
            return [
              {
                source: 'bnf',
                isbn13: '9782205051230',
                title: 'Blacksad : Quelque part entre les ombres',
                seriesName: 'Blacksad',
                seriesLinkKind: 'marc_ensemble_460',
                volumeNumber: '1',
                authors: ['Juan Díaz Canales', 'Juanjo Guarnido'],
                scriptwriters: [],
                illustrators: [],
                publisher: 'Dargaud',
                rawSubjects: ['Bandes dessinées']
              }
            ];
          }
          return [];
        }
      },
      sudoc: { async lookupByIsbn() { return null; } },
      inventaire: { async lookupByIsbn() { return null; }, async fetchSeriesWorks() { return []; } },
      wikidata: { async lookupWorkByQid() { return null; }, async fetchSeriesWorksByQid() { return []; } },
      googleBooks: { async lookupByIsbn() { return null; } },
      openLibrary: { async lookupByIsbn() { return null; } }
    };

    const config = loadServerConfig({
      NODE_ENV: 'test',
      ADMIN_EMAIL: 'admin@biblio.test',
      COVERS_DIR: tmpCoversDir,
      CRON_ENABLED: 'false'
    });
    appCtx = createApp({
      db,
      config,
      connectors: mockConnectors,
      coverFetchImpl: async () => new Response(null, { status: 404 })
    });
  });

  afterEach(() => {
    appCtx.worker.stop();
    db.close();
    fs.rmSync(tmpRootDir, { recursive: true, force: true });
  });

  async function registerUser(username: string, email: string): Promise<string> {
    const res = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, email, password: 'Password123!', gdprAccepted: true })
    });
    expect(res.status).toBe(201);
    return extractCookie(res);
  }

  it('importe un CSV mixte (ISBN direct + Titre→BnF→ISBN + ligne sans ISBN rejetée sans création manuelle + statut none ignoré)', async () => {
    const cookie = await registerUser('ImportCsvUser', 'csv@biblio.test');

    const csv =
      '\uFEFFISBN;Titre;Auteurs;Statut;Lecture;Note;Notes personnelles\r\n' +
      '9782871293019;La Marque du diable;Marini;owned;read;5;Excellent tome 1\r\n' +
      ';Blacksad;Guarnido;wish;;;\r\n' +
      ';Livre totalement introuvable XYZ;Inconnu;owned;;;\r\n' +
      '9782871293019;Tome ignoré;Marini;none;;;\r\n';

    const importRes = await appCtx.app.request('/api/me/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        filename: 'ma-collection.csv',
        contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
        defaultStatus: 'owned'
      })
    });
    expect(importRes.status).toBe(202);
    const created = (await importRes.json()) as {
      ok: true;
      totalRows: number;
      skippedCount: number;
      job: { id: string; type: string };
    };
    expect(created.job.type).toBe('collection_import');
    expect(created.totalRows).toBe(3); // 1 ligne 'none' filtrée d'emblée
    expect(created.skippedCount).toBe(1);

    while (await appCtx.worker.processNextJob()) {
      // exécute le job collection_import et les expansions éventuelles
    }

    const jobsRes = await appCtx.app.request('/api/jobs', { headers: { cookie } });
    const jobsBody = (await jobsRes.json()) as {
      jobs: Array<{ id: string; status: string; result: CollectionImportResultPayload }>;
    };
    const doneJob = jobsBody.jobs.find((j) => j.id === created.job.id)!;
    expect(doneJob.status).toBe('done');
    expect(doneJob.result.importedCount).toBe(2);
    expect(doneJob.result.resolvedByIsbnCount).toBe(1);
    expect(doneJob.result.resolvedBySearchCount).toBe(1);
    expect(doneJob.result.unmatchedCount).toBe(1);
    expect(doneJob.result.unmatched[0]).toMatchObject({
      title: 'Livre totalement introuvable XYZ',
      reason: 'isbn_not_found'
    });

    // Vérification stricte : exactement 2 livres créés (ZÉRO livre manuel sans ISBN), avec statuts + lecture restaurés !
    const pullRes = await appCtx.app.request('/api/sync/pull', { headers: { cookie } });
    const pullBody = (await pullRes.json()) as {
      books: Array<{
        title: string;
        primaryIsbn13: string | null;
        ownershipStatus: string;
        readingState: { status: string; rating: number; notes: string } | null;
      }>;
    };
    expect(pullBody.books).toHaveLength(2);
    expect(pullBody.books.every((b) => Boolean(b.primaryIsbn13))).toBe(true);

    const scorpion = pullBody.books.find((b) => b.primaryIsbn13 === '9782871293019')!;
    expect(scorpion.ownershipStatus).toBe('owned');
    expect(scorpion.readingState).toMatchObject({ status: 'read', rating: 5, notes: 'Excellent tome 1' });

    const blacksad = pullBody.books.find((b) => b.primaryIsbn13 === '9782205051230')!;
    expect(blacksad.ownershipStatus).toBe('wish');
  });

  it('importe un véritable fichier Excel (.xlsx) avec ISBN numérique et supporte le round-trip JSON export -> import', async () => {
    const cookie1 = await registerUser('ExcelUser', 'excel@biblio.test');

    // 1. Import Excel (.xlsx) réel
    const xlsxBuf = buildMinimalXlsxBuffer([
      ['ISBN', 'Titre', 'Statut'],
      [9782871293019, 'Le Scorpion T1', 'Possédé'],
      ['', 'Blacksad', 'Wishlist']
    ]);

    const xlsxRes = await appCtx.app.request('/api/me/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie1 },
      body: JSON.stringify({
        filename: 'bibliotheque.xlsx',
        contentBase64: xlsxBuf.toString('base64'),
        defaultStatus: 'owned'
      })
    });
    expect(xlsxRes.status).toBe(202);
    const xlsxJobId = ((await xlsxRes.json()) as { job: { id: string } }).job.id;
    while (await appCtx.worker.processNextJob()) {
      // exécution
    }

    const jobs1 = (await (await appCtx.app.request('/api/jobs', { headers: { cookie: cookie1 } })).json()) as {
      jobs: Array<{ id: string; status: string; result: CollectionImportResultPayload }>;
    };
    const job1 = jobs1.jobs.find((j) => j.id === xlsxJobId)!;
    expect(job1.status).toBe('done');
    expect(job1.result.importedCount).toBe(2);

    // 2. Round-trip Export JSON de user1 -> Import JSON dans le compte user2
    const exportJsonRes = await appCtx.app.request('/api/me/export?format=json', { headers: { cookie: cookie1 } });
    expect(exportJsonRes.status).toBe(200);
    const exportedJsonText = await exportJsonRes.text();

    const cookie2 = await registerUser('JsonRoundTripUser', 'jsonrt@biblio.test');
    const jsonImpRes = await appCtx.app.request('/api/me/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie2 },
      body: JSON.stringify({
        filename: 'biblio-export.json',
        contentBase64: Buffer.from(exportedJsonText, 'utf8').toString('base64'),
        defaultStatus: 'owned'
      })
    });
    expect(jsonImpRes.status).toBe(202);
    while (await appCtx.worker.processNextJob()) {
      // exécution
    }

    const pull2 = (await (await appCtx.app.request('/api/sync/pull', { headers: { cookie: cookie2 } })).json()) as {
      books: Array<{ primaryIsbn13: string; ownershipStatus: string }>;
    };
    expect(pull2.books).toHaveLength(2);
    expect(pull2.books.find((b) => b.primaryIsbn13 === '9782871293019')?.ownershipStatus).toBe('owned');
    expect(pull2.books.find((b) => b.primaryIsbn13 === '9782205051230')?.ownershipStatus).toBe('wish');
  });

  it('expose la trace ligne par ligne enrichie dans GET /api/admin/import-benchmarks et vide la DB livres via POST /api/admin/reset-book-catalog', async () => {
    const adminCookie = await registerUser('AdminBench', 'admin@biblio.test');
    const userCookie = await registerUser('RegularUser', 'user@biblio.test');

    // CSV avec colonne Catégorie de test, tome volontairement erroné sur la ligne 1, recherche texte ligne 2, échec ligne 3
    const csv =
      'Catégorie;ISBN;Titre;Série;Tome;Auteur\r\n' +
      'BD classique;9782871293019;La Marque du diable;Le Scorpion;9;Marini\r\n' +
      'Sans ISBN;;Blacksad;;1;Guarnido\r\n' +
      'Cas piège;;Ouvrage Fantôme 9999;;;Inconnu\r\n';

    const importRes = await appCtx.app.request('/api/me/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        filename: 'recette-ia.csv',
        contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
        defaultStatus: 'owned'
      })
    });
    expect(importRes.status).toBe(202);
    while (await appCtx.worker.processNextJob()) {
      // exécution
    }

    // 1. Protection stricte Admin (403 pour utilisateur normal)
    const forbiddenBench = await appCtx.app.request('/api/admin/import-benchmarks', {
      headers: { cookie: userCookie }
    });
    expect(forbiddenBench.status).toBe(403);

    const forbiddenReset = await appCtx.app.request('/api/admin/reset-book-catalog', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ confirmation: 'VIDER' })
    });
    expect(forbiddenReset.status).toBe(403);

    // 2. Lecture benchmark enrichi côté Admin
    const benchRes = await appCtx.app.request('/api/admin/import-benchmarks', {
      headers: { cookie: adminCookie }
    });
    expect(benchRes.status).toBe(200);
    const benchBody = (await benchRes.json()) as {
      ok: true;
      activeCatalogJobsCount: number;
      jobs: Array<{
        filename: string;
        summary: {
          totalRows: number;
          matchedCount: number;
          warningCount: number;
          unmatchedCount: number;
          missingCoverCount: number;
          resolvedByIsbnCount: number;
          resolvedBySearchCount: number;
        };
        items: Array<{
          rowNumber: number;
          status: string;
          resolutionChannel: string;
          verdict: string;
          warnings: string[];
          input: { testCategory: string | null; inputProfile: string };
          live: { title: string; seriesName: string | null; volumeNumber: number | null } | null;
        }>;
      }>;
    };

    expect(benchBody.jobs).toHaveLength(1);
    const job = benchBody.jobs[0];
    expect(job.filename).toBe('recette-ia.csv');
    expect(job.summary.totalRows).toBe(3);
    expect(job.summary.matchedCount).toBe(2);
    expect(job.summary.unmatchedCount).toBe(1);
    expect(job.summary.resolvedByIsbnCount).toBe(1);
    expect(job.summary.resolvedBySearchCount).toBe(1);
    expect(job.items).toHaveLength(3);

    // Ligne 1 (ISBN direct + tome 9 attendu vs tome 1 trouvé -> volume_mismatch)
    expect(job.items[0].input.testCategory).toBe('BD classique');
    expect(job.items[0].input.inputProfile).toBe('isbn_series_vol');
    expect(job.items[0].resolutionChannel).toBe('isbn_direct');
    expect(job.items[0].verdict).toBe('warning');
    expect(job.items[0].warnings).toContain('volume_mismatch');
    expect(job.items[0].live?.seriesName).toBe('Le Scorpion');

    // Vérification de l'enrichissement LIVE : si la couverture est retirée en base, `missing_cover` remonte immédiatement
    db.run('UPDATE books SET cover_key = NULL');
    const liveBenchRes = await appCtx.app.request('/api/admin/import-benchmarks', {
      headers: { cookie: adminCookie }
    });
    expect(liveBenchRes.status).toBe(200);
    const liveBenchBody = (await liveBenchRes.json()) as typeof benchBody;
    expect(liveBenchBody.jobs[0].items[0].warnings).toEqual(
      expect.arrayContaining(['volume_mismatch', 'missing_cover'])
    );
    expect(liveBenchBody.jobs[0].summary.missingCoverCount).toBe(2);

    // Ligne 2 (Sans ISBN -> recherche BnF -> Blacksad T1 trouvé, titre nettoyé sans faux positif title_mismatch)
    expect(job.items[1].input.testCategory).toBe('Sans ISBN');
    expect(job.items[1].input.inputProfile).toBe('title_vol_author');
    expect(job.items[1].resolutionChannel).toBe('search_to_isbn');
    expect(job.items[1].live?.seriesName).toBe('Blacksad');
    expect(job.items[1].live?.title).toBe('Quelque part entre les ombres');
    expect(job.items[1].warnings).not.toContain('title_mismatch');

    // Ligne 3 (échec)
    expect(job.items[2].status).toBe('unmatched');
    expect(job.items[2].verdict).toBe('failed');

    // 3. Reset DB livres : confirmation invalide refusée (400)
    const badReset = await appCtx.app.request('/api/admin/reset-book-catalog', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ confirmation: 'OUI' })
    });
    expect(badReset.status).toBe(400);

    // Dépose un fichier .webp témoin pour vérifier le nettoyage disque
    fs.writeFileSync(path.join(tmpCoversDir, 'cov_test123456.webp'), Buffer.from('fake-webp'));

    const okReset = await appCtx.app.request('/api/admin/reset-book-catalog', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ confirmation: 'VIDER' })
    });
    expect(okReset.status).toBe(200);
    const resetBody = (await okReset.json()) as {
      ok: true;
      deletedBooks: number;
      deletedSeries: number;
      deletedCoverFiles: number;
      resetAt: string;
    };
    expect(resetBody.deletedBooks).toBe(2);
    expect(resetBody.deletedSeries).toBeGreaterThanOrEqual(2);
    expect(resetBody.deletedCoverFiles).toBeGreaterThanOrEqual(1);
    expect(fs.readdirSync(tmpCoversDir).filter((f) => f.endsWith('.webp'))).toHaveLength(0);

    // Vérifie que les comptes, sessions et foyers sont préservés et que catalog_reset est horodaté
    const overviewRes = await appCtx.app.request('/api/admin/overview', {
      headers: { cookie: adminCookie }
    });
    expect(overviewRes.status).toBe(200);
    const overview = ((await overviewRes.json()) as {
      overview: {
        usersCount: number;
        librariesCount: number;
        booksCount: number;
        seriesCount: number;
        jobsCount: number;
        cronRuns: Array<{ job_name: string; last_run_at: string }>;
      };
    }).overview;
    expect(overview.usersCount).toBe(2);
    expect(overview.librariesCount).toBe(2);
    expect(overview.booksCount).toBe(0);
    expect(overview.seriesCount).toBe(0);
    expect(overview.jobsCount).toBe(0);
    expect(overview.cronRuns.some((r) => r.job_name === 'catalog_reset')).toBe(true);
  });

  it('note automatiquement un import via un CSV de correction, génère le rapport Markdown sur disque + pipeline_logs et le sert sur /report.md', async () => {
    const adminCookie = await registerUser('AdminGrader', 'admin@biblio.test');

    const inputCsv =
      'ISBN;Titre;Serie;Tome;Auteur;Editeur;Statut;Integrale;Tomes inclus;Lecture;Note;Notes\r\n' +
      '9782871293019;La Marque du diable;Le Scorpion;1;Marini;Dargaud;Possédé;;;Lu;5;Super tome\r\n' +
      ';Blacksad;;;Guarnido;;Wishlist;;;;;\r\n' +
      ';Introuvable Total;;;Inconnu;;Possédé;;;;;\r\n';

    const importRes = await appCtx.app.request('/api/me/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        filename: 'test_01.csv',
        contentBase64: Buffer.from(inputCsv, 'utf8').toString('base64'),
        defaultStatus: 'owned'
      })
    });
    expect(importRes.status).toBe(202);
    const { job } = (await importRes.json()) as { job: { id: string } };
    while (await appCtx.worker.processNextJob()) {
      // exécution
    }

    const groundTruthCsv =
      'Ligne;Fichier_origine;Ligne_fichier;Categorie;Profil_entree;Media;ISBN_Verifie;Titre_Attendu;Serie_Attendue;Tome_Attendu;Auteur_Attendu;Editeur_Attendu;Collection_Editoriale;Integrale_Attendue;Tomes_inclus_Attendus;Statut;Lecture;Note;Notes;Regle_Verification\r\n' +
      '1;test_01.csv;1;cat1;isbn_seul;BD;9782871293019;La Marque du diable;Le Scorpion;1;Stephen Desberg, Enrico Marini;Dargaud;;Non;;Possédé;Lu;5;Super tome;BD classique T1\r\n' +
      '2;test_01.csv;2;cat5;titre_auteur;Roman;;Blacksad : Quelque part entre les ombres;Blacksad;1;Juanjo Guarnido;Dargaud;;Non;;Wishlist;;;;Piège média volontaire (attendu Roman vs BD trouvée)\r\n' +
      '3;test_01.csv;3;cat8;titre_seul;Roman;;Introuvable Total;;;Inconnu;;;Non;;Possédé;;;;Cas introuvable\r\n';

    const gradeRes = await appCtx.app.request(`/api/admin/import-benchmarks/${job.id}/grade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        filename: 'reponses_complet_1080.csv',
        contentBase64: Buffer.from(groundTruthCsv, 'utf8').toString('base64')
      })
    });
    expect(gradeRes.status).toBe(200);
    const graded = (await gradeRes.json()) as {
      ok: true;
      reportFilename: string;
      archiveFilename: string;
      seriesReportFilename: string;
      seriesArchiveFilename: string;
      markdown: string;
      seriesMarkdown: string;
      report: {
        alignmentMode: string;
        totals: { evaluatedRows: number; resolvedRows: number; failedRows: number };
        seriesAudit: Array<{ canonicalName: string; volumes: Array<{ title: string }> }>;
        items: Array<{ dataLineNumber: number; verdict: string; failedFields: string[] }>;
      };
    };

    expect(graded.report.alignmentMode).toBe('fichier_origine');
    expect(graded.report.totals.evaluatedRows).toBe(3);
    expect(graded.report.totals.resolvedRows).toBe(2);
    expect(graded.report.totals.failedRows).toBe(1);
    expect(graded.report.items[1].failedFields).toContain('media');
    expect(graded.report.items[2].verdict).toBe('failed');
    expect(graded.report.seriesAudit.length).toBeGreaterThanOrEqual(2);
    expect(graded.markdown).toContain('# Rapport de Benchmark Automatique — `test_01.csv`');
    expect(graded.markdown).toContain('## 7. Extensions de séries — Inventaire des tomes');
    expect(graded.markdown).toContain('Piège média volontaire');
    expect(graded.seriesMarkdown).toContain('# Audit des Extensions de Séries — `test_01.csv`');
    expect(graded.seriesMarkdown).toContain('La Marque du diable');

    // Vérifie la persistance des rapports Markdown sur disque (principal + séries)
    const reportsDir = path.join(tmpRootDir, 'benchmark-reports');
    expect(fs.existsSync(path.join(reportsDir, graded.reportFilename))).toBe(true);
    expect(fs.existsSync(path.join(reportsDir, graded.archiveFilename))).toBe(true);
    expect(fs.existsSync(path.join(reportsDir, graded.seriesReportFilename))).toBe(true);
    expect(fs.existsSync(path.join(reportsDir, graded.seriesArchiveFilename))).toBe(true);

    // Vérifie l'enregistrement dans pipeline_logs (stage = benchmark_report)
    const logsRes = await appCtx.app.request('/api/admin/logs?stage=benchmark_report', {
      headers: { cookie: adminCookie }
    });
    expect(logsRes.status).toBe(200);
    const logsBody = (await logsRes.json()) as { logs: Array<{ stage: string; summary: string }> };
    expect(logsBody.logs.length).toBeGreaterThanOrEqual(1);
    expect(logsBody.logs[0].summary).toContain('test_01.csv');

    // Vérifie les téléchargements bruts .md (global + séries) et le recalcul /regrade
    const mdRes = await appCtx.app.request(`/api/admin/import-benchmarks/${job.id}/report.md`, {
      headers: { cookie: adminCookie }
    });
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get('content-type')).toContain('text/markdown');
    expect(await mdRes.text()).toContain('## 1. Synthèse globale');

    const seriesMdRes = await appCtx.app.request(`/api/admin/import-benchmarks/${job.id}/series-report.md`, {
      headers: { cookie: adminCookie }
    });
    expect(seriesMdRes.status).toBe(200);
    expect(seriesMdRes.headers.get('content-type')).toContain('text/markdown');
    expect(await seriesMdRes.text()).toContain('Le Scorpion');

    const regradeRes = await appCtx.app.request(`/api/admin/import-benchmarks/${job.id}/regrade`, {
      method: 'POST',
      headers: { cookie: adminCookie }
    });
    expect(regradeRes.status).toBe(200);
  });

  it('persiste un CSV corrigé préchargé côté serveur et déclenche automatiquement la notation dès la fin de l’import + borne external_cache', async () => {
    const adminCookie = await registerUser('AdminAutoGrade', 'admin@biblio.test');

    // 1. Préchargement du CSV de correction sur le SERVEUR avant même de lancer l'import
    const gtCsv =
      'Ligne,Fichier_Origine,Categorie,Profil_Entree,ISBN_Attendu,Titre_Attendu,Serie_Attendue,Tome_Attendu,Auteur_Attendu,Editeur_Attendu,Collection_Editoriale,Annee_Attendue,Media_Attendu,Integrale_Attendue,Tomes_Inclus_Attendus,Statut_Attendu,Lecture_Attendue,Note_Attendue,Notes_Attendues,Regle_Verification\n' +
      '1,auto_test.csv,cat1,isbn_seul,9782871293019,La Marque du diable,Le Scorpion,1,"Stephen Desberg, Enrico Marini",Dargaud,,2000,BD,Non,,owned,read,5,Top,Auto-grade test\n';

    const savePendingRes = await appCtx.app.request('/api/admin/import-benchmarks/pending-ground-truth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        filename: 'reponses_auto.csv',
        contentBase64: Buffer.from(gtCsv, 'utf8').toString('base64')
      })
    });
    expect(savePendingRes.status).toBe(200);
    const savedMeta = (await savePendingRes.json()) as {
      ok: true;
      pendingGroundTruth: { filename: string; rowCount: number };
    };
    expect(savedMeta.pendingGroundTruth.filename).toBe('reponses_auto.csv');
    expect(savedMeta.pendingGroundTruth.rowCount).toBe(1);

    // 2. Import CSV exécuté par le BackgroundWorker (sans aucun navigateur ouvert)
    const inputCsv =
      'ISBN,Titre,Auteur,Statut,Lecture,Note,Notes\n' +
      '9782871293019,La Marque du diable,Marini,owned,read,5,Top\n';
    const importRes = await appCtx.app.request('/api/me/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        filename: 'auto_test.csv',
        contentBase64: Buffer.from(inputCsv, 'utf8').toString('base64'),
        defaultStatus: 'owned'
      })
    });
    expect(importRes.status).toBe(202);
    const { job } = (await importRes.json()) as { job: { id: string } };

    // Déroule le worker -> le hook afterComplete déclenche autoGradeWithPendingGroundTruth automatiquement !
    while (await appCtx.worker.processNextJob()) {
      // drain
    }

    // 3. Le rapport Markdown a été généré automatiquement et le pendingGroundTruth a été consommé
    const gradeGetRes = await appCtx.app.request(`/api/admin/import-benchmarks/${job.id}/grade`, {
      headers: { cookie: adminCookie }
    });
    expect(gradeGetRes.status).toBe(200);
    const gradeBody = (await gradeGetRes.json()) as {
      ok: true;
      hasGroundTruth: boolean;
      report?: { totals: { evaluatedRows: number; resolvedRows: number } };
    };
    expect(gradeBody.hasGroundTruth).toBe(true);
    expect(gradeBody.report?.totals.evaluatedRows).toBe(1);
    expect(gradeBody.report?.totals.resolvedRows).toBe(1);

    const pendingAfter = (await (
      await appCtx.app.request('/api/admin/import-benchmarks/pending-ground-truth', {
        headers: { cookie: adminCookie }
      })
    ).json()) as { pendingGroundTruth: unknown };
    expect(pendingAfter.pendingGroundTruth).toBeNull();

    // 4. Vérifie le plafonnement pruneExternalCache sur external_cache
    const future = new Date(Date.now() + 86400_000).toISOString();
    const past = new Date(Date.now() - 86400_000).toISOString();
    for (let i = 0; i < 6; i++) {
      appCtx.repos.jobRepo.setExternalCache(`k_${i}`, 'bnf', { text: 'ok' }, i < 2 ? past : future);
    }
    const purged = appCtx.repos.jobRepo.pruneExternalCache(new Date().toISOString(), 2);
    expect(purged).toBe(4); // 2 expirés + 2 excédentaires au-dessus du plafond maxRows=2
  });

  it('prévisualise systématiquement les colonnes CSV / JSON / Excel via POST /api/me/import/preview et applique la bijection validée sur POST /api/me/import', async () => {
    const reg = await appCtx.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'MappingTester',
        email: 'mapping@biblio.test',
        password: 'Password123',
        gdprAccepted: true
      })
    });
    const cookie = extractCookie(reg);

    // 1. Prévisualisation CSV sans ligne d'en-tête -> détecte hasHeaderRow=false et infère les colonnes
    const headerlessCsv = 'Le Scorpion;Enrico Marini;9782871293019\n';
    const csvB64 = Buffer.from(headerlessCsv, 'utf8').toString('base64');
    const prevCsvRes = await appCtx.app.request('/api/me/import/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ filename: 'ma_liste.csv', contentBase64: csvB64 })
    });
    expect(prevCsvRes.status).toBe(200);
    const prevCsvBody = (await prevCsvRes.json()) as {
      ok: true;
      preview: {
        format: string;
        hasHeaderRow: boolean;
        canToggleHeaderRow: boolean;
        totalDataRows: number;
        columns: Array<{ columnKey: string; suggestedField: string | null; sampleValues: string[] }>;
      };
    };
    expect(prevCsvBody.preview.format).toBe('csv');
    expect(prevCsvBody.preview.hasHeaderRow).toBe(false);
    expect(prevCsvBody.preview.canToggleHeaderRow).toBe(true);
    expect(prevCsvBody.preview.totalDataRows).toBe(1);
    expect(prevCsvBody.preview.columns.map((c) => c.suggestedField)).toEqual(['title', 'author', 'isbn']);

    // 2. Prévisualisation JSON avec clés libres -> canToggleHeaderRow=false + inférence ISBN par contenu
    const exoticJson = JSON.stringify([
      { libelle_perso: 'La Marque du diable', auteur_bd: 'Marini', ref_barre: '9782871293019' }
    ]);
    const jsonB64 = Buffer.from(exoticJson, 'utf8').toString('base64');
    const prevJsonRes = await appCtx.app.request('/api/me/import/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ filename: 'export_perso.json', contentBase64: jsonB64 })
    });
    expect(prevJsonRes.status).toBe(200);
    const prevJsonBody = (await prevJsonRes.json()) as {
      preview: {
        format: string;
        canToggleHeaderRow: boolean;
        columns: Array<{ columnKey: string; suggestedField: string | null }>;
      };
    };
    expect(prevJsonBody.preview.format).toBe('json');
    expect(prevJsonBody.preview.canToggleHeaderRow).toBe(false);
    expect(prevJsonBody.preview.columns.find((c) => c.columnKey === 'ref_barre')?.suggestedField).toBe('isbn');

    // 3. Import effectif avec la bijection personnalisée validée par l'utilisateur
    const impRes = await appCtx.app.request('/api/me/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        filename: 'export_perso.json',
        contentBase64: jsonB64,
        defaultStatus: 'owned',
        columnMapping: {
          libelle_perso: 'title',
          auteur_bd: 'author',
          ref_barre: 'isbn'
        }
      })
    });
    expect(impRes.status).toBe(202);
    const impBody = (await impRes.json()) as { job: { id: string }; totalRows: number };
    expect(impBody.totalRows).toBe(1);

    await appCtx.worker.processNextJob();
    const jobRow = appCtx.repos.jobRepo.findJobById(impBody.job.id)!;
    expect(jobRow.status).toBe('done');
    const result = JSON.parse(jobRow.result_json!) as CollectionImportResultPayload;
    expect(result.importedCount).toBe(1);
    expect(result.resolvedByIsbnCount).toBe(1);
  });
});
