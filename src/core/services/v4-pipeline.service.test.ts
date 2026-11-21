import { describe, expect, it, vi } from 'vitest';
import type { DatabaseBinding, SqlPreparedStatement } from '../adapters/storage-db.interface';
import {
  checkBookIndexLayer2,
  consolidateBookLayer4,
  detectIntegralAndIncludedVolumes,
  discoverMultiSourceLayer3,
  electCanonicalSeriesFromVotes,
  normalizeIsbnWithPressFallback,
  searchLocalBooksForCanal3,
  type StagingPayload
} from './v4-pipeline.service';

/**
 * Mock SQLite/D1 en mémoire minimal pour valider la logique FRBR V4 sans dépendance Cloudflare.
 */
function createInMemoryV4Db(): {
  db: DatabaseBinding;
  series: Map<string, Record<string, any>>;
  books: Map<string, Record<string, any>>;
  isbnIndex: Map<string, { isbn13: string; book_id: string; is_integral: number }>;
  libBooks: Map<string, { library_id: string; book_id: string; is_owned: number; is_wished: number }>;
  logs: any[];
} {
  const series = new Map<string, Record<string, any>>();
  const books = new Map<string, Record<string, any>>();
  const isbnIndex = new Map<string, { isbn13: string; book_id: string; is_integral: number }>();
  const libBooks = new Map<string, { library_id: string; book_id: string; is_owned: number; is_wished: number }>();
  const logs: any[] = [];

  const makeStmt = (sql: string, args: unknown[] = []): SqlPreparedStatement => {
    const cleanSql = sql.replace(/\s+/g, ' ').trim();
    const stmt: SqlPreparedStatement = {
      bind: (...b: unknown[]) => makeStmt(sql, b),
      async first<T = Record<string, unknown>>() {
        if (cleanSql.startsWith('SELECT bi.book_id, b.* FROM book_isbn_index bi')) {
          const hit = isbnIndex.get(String(args[0]));
          if (!hit) return null;
          const b = books.get(hit.book_id);
          return b ? ({ ...b, book_id: hit.book_id } as T) : null;
        }
        if (cleanSql.startsWith('SELECT * FROM books WHERE known_isbns_json LIKE ?')) {
          const needle = String(args[0]).replace(/%/g, '');
          for (const b of books.values()) {
            if (String(b.known_isbns_json || '').includes(needle)) return b as T;
          }
          return null;
        }
        if (cleanSql.startsWith('SELECT is_owned, is_wished FROM v4_library_books')) {
          const row = libBooks.get(`${args[0]}::${args[1]}`);
          return (row || null) as T | null;
        }
        if (cleanSql.startsWith('SELECT is_owned FROM v4_library_books')) {
          const row = libBooks.get(`${args[0]}::${args[1]}`);
          return (row || null) as T | null;
        }
        if (cleanSql.startsWith('SELECT * FROM v4_series WHERE normalized_core_key = ?')) {
          for (const s of series.values()) {
            if (s.normalized_core_key === args[0]) return s as T;
          }
          return null;
        }
        if (cleanSql.startsWith('SELECT * FROM books WHERE work_canonical_id = ?')) {
          for (const b of books.values()) {
            if (b.work_canonical_id === args[0]) return b as T;
          }
          return null;
        }
        if (cleanSql.startsWith('SELECT * FROM books WHERE series_id = ? AND volume_number = ?')) {
          for (const b of books.values()) {
            if (b.series_id === args[0] && b.volume_number === args[1] && b.is_integral === 0) return b as T;
          }
          return null;
        }
        if (cleanSql.startsWith('SELECT * FROM books WHERE id = ?')) {
          return (books.get(String(args[0])) || null) as T | null;
        }
        if (cleanSql.startsWith('SELECT uri, label, entity_json FROM catalog_entities')) {
          return null;
        }
        if (cleanSql.startsWith('SELECT uri FROM catalog_entities')) {
          return null;
        }
        return null;
      },
      async all<T = Record<string, unknown>>() {
        if (cleanSql.startsWith('SELECT * FROM books') && cleanSql.includes('LIMIT 60')) {
          return { results: Array.from(books.values()) as T[], success: true };
        }
        if (cleanSql.startsWith('SELECT id, canonical_title, known_isbns_json, integral_metadata_json FROM books WHERE series_id = ? AND is_integral = 1')) {
          const res = Array.from(books.values()).filter((b) => b.series_id === args[0] && b.is_integral === 1);
          return { results: res as T[], success: true };
        }
        if (cleanSql.startsWith('SELECT id, volume_number, canonical_title, known_isbns_json, parent_integrals_json FROM books WHERE series_id = ? AND is_integral = 0')) {
          const res = Array.from(books.values()).filter((b) => b.series_id === args[0] && b.is_integral === 0);
          return { results: res as T[], success: true };
        }
        if (cleanSql.startsWith('SELECT library_id, is_owned, is_wished')) {
          const res = Array.from(libBooks.values()).filter((l) => l.book_id === String(args[0]));
          return { results: res as T[], success: true };
        }
        if (cleanSql.startsWith('SELECT id, volume_number FROM books WHERE series_id = ? AND is_integral = 0')) {
          const res = Array.from(books.values()).filter(
            (b) => b.series_id === args[0] && b.is_integral === 0 && b.is_hors_serie === 0
          );
          return { results: res as T[], success: true };
        }
        return { results: [], success: true };
      },
      async run() {
        if (cleanSql.startsWith('INSERT INTO v4_series')) {
          const [id, canonical_name, normalized_core_key, aliases_json, primary_authors_json, wikidata_qid, bnf_ensemble_ids_json, created_at, updated_at] = args;
          series.set(String(id), {
            id,
            canonical_name,
            normalized_core_key,
            aliases_json,
            primary_authors_json,
            wikidata_qid,
            bnf_ensemble_ids_json,
            is_complete_expanded: 0,
            created_at,
            updated_at
          });
        } else if (cleanSql.startsWith('UPDATE v4_series SET aliases_json')) {
          const [aliases_json, bnf_ensemble_ids_json, primary_authors_json, wikidata_qid, updated_at, id] = args;
          const s = series.get(String(id));
          if (s) {
            Object.assign(s, { aliases_json, bnf_ensemble_ids_json, primary_authors_json, updated_at });
            if (!s.wikidata_qid && wikidata_qid) s.wikidata_qid = wikidata_qid;
          }
        } else if (cleanSql.startsWith('INSERT INTO books')) {
          const [
            id, work_canonical_id, canonical_title, normalized_title, series_id, series_name,
            volume_number, volume_label, is_hors_serie, hors_serie_label, is_integral,
            integral_metadata_json, parent_integrals_json, authors_json, known_isbns_json,
            editions_catalog_json, selected_cover_url, main_category, subgenres_json,
            legacy_entity_uri, created_at, updated_at
          ] = args;
          books.set(String(id), {
            id, work_canonical_id, canonical_title, normalized_title, series_id, series_name,
            volume_number, volume_label, is_hors_serie, hors_serie_label, is_integral,
            integral_metadata_json, parent_integrals_json, authors_json, language: 'fr',
            known_isbns_json, editions_catalog_json, selected_cover_url, main_category,
            subgenres_json, legacy_entity_uri, created_at, updated_at
          });
        } else if (cleanSql.startsWith('UPDATE books SET canonical_title')) {
          const [
            canonical_title, normalized_title, series_id, series_name,
            volume_number, volume_label, is_hors_serie, hors_serie_label,
            is_integral, integral_metadata_json, parent_integrals_json,
            authors_json, known_isbns_json, editions_catalog_json,
            selected_cover_url, main_category, subgenres_json, legacy_entity_uri, updated_at, id
          ] = args;
          const b = books.get(String(id));
          if (b) {
            Object.assign(b, {
              canonical_title, normalized_title, series_id, series_name,
              volume_number, volume_label, is_hors_serie, hors_serie_label,
              is_integral, integral_metadata_json, parent_integrals_json,
              authors_json, known_isbns_json, editions_catalog_json,
              selected_cover_url, main_category, subgenres_json, updated_at
            });
            if (!b.legacy_entity_uri && legacy_entity_uri) b.legacy_entity_uri = legacy_entity_uri;
          }
        } else if (cleanSql.startsWith('UPDATE books SET parent_integrals_json')) {
          const b = books.get(String(args[2]));
          if (b) b.parent_integrals_json = args[0];
        } else if (cleanSql.startsWith('UPDATE books SET integral_metadata_json')) {
          const b = books.get(String(args[2]));
          if (b) b.integral_metadata_json = args[0];
        } else if (cleanSql.startsWith('INSERT INTO book_isbn_index')) {
          const [isbn13, book_id, is_integral] = args;
          isbnIndex.set(String(isbn13), {
            isbn13: String(isbn13),
            book_id: String(book_id),
            is_integral: Number(is_integral)
          });
        } else if (cleanSql.startsWith('INSERT INTO v4_library_books')) {
          const [library_id, book_id, is_owned, is_wished] = args;
          const key = `${library_id}::${book_id}`;
          const prev = libBooks.get(key);
          libBooks.set(key, {
            library_id: String(library_id),
            book_id: String(book_id),
            is_owned: Math.max(prev?.is_owned || 0, Number(is_owned)),
            is_wished: Number(is_owned) === 1 ? 0 : Number(is_wished)
          });
        } else if (cleanSql.startsWith('INSERT INTO pipeline_logs')) {
          logs.push(args);
        } else if (cleanSql.startsWith('DELETE FROM v4_library_books WHERE book_id = ?')) {
          for (const [k, v] of libBooks.entries()) {
            if (v.book_id === String(args[0])) libBooks.delete(k);
          }
        } else if (cleanSql.startsWith('DELETE FROM books WHERE id = ?')) {
          books.delete(String(args[0]));
        } else if (cleanSql.startsWith('UPDATE book_isbn_index SET book_id = ?')) {
          const [newBookId, isInt, oldBookId] = args;
          for (const entry of isbnIndex.values()) {
            if (entry.book_id === String(oldBookId)) {
              entry.book_id = String(newBookId);
              entry.is_integral = Number(isInt);
            }
          }
        }
        return { success: true };
      }
    };
    return stmt;
  };

  const db: DatabaseBinding = {
    prepare: (query: string) => makeStmt(query),
    batch: async <T = unknown>(stmts: SqlPreparedStatement[]): Promise<T[]> => {
      const res: unknown[] = [];
      for (const s of stmts) res.push(await s.run());
      return res as T[];
    }
  };

  return { db, series, books, isbnIndex, libBooks, logs };
}

describe('v4-pipeline.service', () => {
  it('normalise ISBN-10, ISBN-13 et détecte les codes presse 330/378/977', () => {
    const res10 = normalizeIsbnWithPressFallback('2-203-00106-2');
    expect(res10.isbn13Candidates).toEqual(['9782203001060']);
    expect(res10.isPressEan).toBe(false);

    const resPress = normalizeIsbnWithPressFallback('3309450057150');
    expect(resPress.isPressEan).toBe(true);
    expect(resPress.isbn13Candidates.every((c) => c.startsWith('978'))).toBe(true);
    expect(resPress.isbn13Candidates.length).toBeGreaterThan(0);

    expect(normalizeIsbnWithPressFallback('invalid-isbn').isbn13Candidates).toEqual([]);
  });

  it('considère les albums doubles (ex: Astérix le Gaulois / La serpe d or) comme des intégrales', () => {
    const payload: StagingPayload = {
      anchorIsbn13: '9782724200003',
      anchorTitle: 'Astérix le Gaulois / La serpe d\'or',
      language: 'fr',
      sisterEditions: [],
      seriesCandidates: [],
      authors: ['René Goscinny', 'Albert Uderzo'],
      illustrators: [],
      scriptwriters: [],
      pageCount: 96,
      rawSubjects: [],
      rawTitles: ['Astérix le Gaulois / La serpe d\'or'],
      sourcesHit: ['bnf']
    };
    const res = detectIntegralAndIncludedVolumes(payload);
    expect(res.isDoubleAlbum).toBe(true);
    expect(res.isIntegral).toBe(true);
    expect(res.doubleSubTitles).toEqual(['Astérix le Gaulois', 'La serpe d\'or']);
  });

  it('vote majoritaire sur clusters normalisés pour éviter les séries doublons', () => {
    const elected = electCanonicalSeriesFromVotes([
      {
        source: 'bnf_anchor',
        rawName: 'Astérix - La Grande Collection',
        coreKey: 'asterix',
        cleanDisplay: 'Astérix',
        weight: 3
      },
      {
        source: 'inventaire_p179',
        rawName: 'Astérix',
        coreKey: 'asterix',
        cleanDisplay: 'Astérix',
        weight: 3,
        wikidataQid: 'Q42490'
      },
      {
        source: 'google_books',
        rawName: 'Les Aventures d\'Astérix',
        coreKey: 'asterix',
        cleanDisplay: 'Astérix',
        weight: 1.5
      }
    ]);
    expect(elected).not.toBeNull();
    expect(elected!.coreKey).toBe('asterix');
    expect(elected!.canonicalName).toBe('Astérix');
    expect(elected!.confidenceRatio).toBe(1);
    expect(elected!.aliases).toContain('Astérix - La Grande Collection');
  });

  it('hérite du numéro de tome d une édition sœur FR AVANT de classer en Hors-Série', async () => {
    const { db } = createInMemoryV4Db();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    const payload: StagingPayload = {
      anchorIsbn13: '9782012101340', // Hachette sans $v
      anchorTitle: 'La Serpe d\'or',
      language: 'fr',
      sisterEditions: [
        { source: 'bnf', isbn13: '9782012101340', title: 'La Serpe d\'or', seriesRaw: 'Astérix', language: 'fre' },
        { source: 'bnf', isbn13: '9782205001105', title: 'La serpe d\'or', seriesRaw: 'Astérix', volumeNumber: '2', language: 'fre' }
      ],
      seriesCandidates: [
        { source: 'bnf', rawName: 'Astérix', coreKey: 'asterix', cleanDisplay: 'Astérix', weight: 3 }
      ],
      authors: ['René Goscinny', 'Albert Uderzo'],
      illustrators: [],
      scriptwriters: [],
      rawSubjects: ['Bande dessinée'],
      rawTitles: ['La Serpe d\'or'],
      sourcesHit: ['bnf']
    };

    const book = await consolidateBookLayer4(db, payload, {
      sourceChannel: 'canal_1_barcode',
      libraryId: 'lib_1',
      action: 'owned'
    });

    expect(book.isHorsSerie).toBe(false);
    expect(book.volumeNumber).toBe(2);
    expect(book.knownIsbns).toContain('9782012101340');
    expect(book.knownIsbns).toContain('9782205001105');

    // Un 2e scan d'une autre édition sœur frappe l'index O(1) directement en ALREADY_OWNED !
    const l2 = await checkBookIndexLayer2(db, '9782205001105', 'lib_1');
    expect(l2.status).toBe('ALREADY_OWNED');
    expect(l2.book?.id).toBe(book.id);

    vi.unstubAllGlobals();
  });

  it('gère la détection bidirectionnelle Intégrales <-> Tomes unitaires et la recherche D1 Canal 3', async () => {
    const { db } = createInMemoryV4Db();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    // 1. Utilisateur scanne et possède l'intégrale Tomes 1 à 3
    await consolidateBookLayer4(
      db,
      {
        anchorIsbn13: '9782800150000',
        anchorTitle: 'Thorgal - Intégrale Tomes 1 à 3',
        language: 'fr',
        sisterEditions: [],
        seriesCandidates: [
          { source: 'bnf', rawName: 'Thorgal', coreKey: 'thorgal', cleanDisplay: 'Thorgal', weight: 3 }
        ],
        authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
        illustrators: [],
        scriptwriters: [],
        rawSubjects: ['Bande dessinée'],
        rawTitles: ['Thorgal - Intégrale Tomes 1 à 3'],
        sourcesHit: ['bnf']
      },
      { sourceChannel: 'canal_1_barcode', libraryId: 'lib_1', action: 'owned' }
    );

    // 2. Arrivée ultérieure du Tome 2 unitaire en base (action preview / ami) -> lié bidirectionnellement
    await consolidateBookLayer4(
      db,
      {
        anchorIsbn13: '9782803603589',
        anchorTitle: 'L\'Île des mers gelées',
        language: 'fr',
        sisterEditions: [
          { source: 'bnf', isbn13: '9782803603589', title: 'L\'Île des mers gelées', volumeNumber: '2', language: 'fre' }
        ],
        seriesCandidates: [
          { source: 'bnf', rawName: 'Thorgal', coreKey: 'thorgal', cleanDisplay: 'Thorgal', weight: 3 }
        ],
        authors: ['Jean Van Hamme', 'Grzegorz Rosinski'],
        illustrators: [],
        scriptwriters: [],
        rawSubjects: ['Bande dessinée'],
        rawTitles: ['L\'Île des mers gelées'],
        sourcesHit: ['bnf']
      },
      { sourceChannel: 'canal_3_text_search', libraryId: 'lib_1', action: 'preview' }
    );

    const l2Tome2 = await checkBookIndexLayer2(db, '9782803603589', 'lib_1');
    expect(l2Tome2.status).toBe('INCLUDED_IN_INTEGRAL');
    expect(l2Tome2.ownedIntegralMatches[0]?.title).toContain('Intégrale');

    // Recherche locale D1 (Canal 3 Passe 1) retrouve bien le tome 2 sans appel externe
    const localHits = await searchLocalBooksForCanal3(db, {
      series: 'Thorgal',
      volumeNumber: '2'
    });
    expect(localHits.length).toBeGreaterThan(0);
    expect(localHits[0]?.isbn13).toBe('9782803603589');

    // Et inversement : si lib_2 possède seulement le tome 2 et scanne l'intégrale 1 à 3 -> PARTIAL_INTEGRAL_OWNED
    const t2Book = l2Tome2.book!;
    await db
      .prepare(
        'INSERT INTO v4_library_books (library_id, book_id, is_owned, is_wished, source_channel, selected_cover_url, added_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)'
      )
      .bind('lib_2', t2Book.id, 1, 0, 'test', 'now', 'now')
      .run();

    const l2IntegralForLib2 = await checkBookIndexLayer2(db, '9782800150000', 'lib_2');
    expect(l2IntegralForLib2.status).toBe('PARTIAL_INTEGRAL_OWNED');
    expect(l2IntegralForLib2.includedOwnedWorkIds).toContain(t2Book.id);

    vi.unstubAllGlobals();
  });

  it('priorise 460$t/$v sur Folio 295/410 (#6561) et empêche C3-bis d absorber le Tome 2 dans Tome 1', async () => {
    const { db } = createInMemoryV4Db();

    const culotteesT1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/" xmlns:mxc="info:lc/xmlns/marcxchange-v2">
<srw:record><mxc:record>
  <mxc:datafield tag="020"><mxc:subfield code="a">978-2-07-279410-0</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="100"><mxc:subfield code="a">Bagieu</mxc:subfield><mxc:subfield code="m">Pénélope</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="245"><mxc:subfield code="a">Culottées</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="295"><mxc:subfield code="a">Folio</mxc:subfield><mxc:subfield code="v">6561</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="410"><mxc:subfield code="t">Collection Folio</mxc:subfield><mxc:subfield code="v">6561</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="460"><mxc:subfield code="3">45646405</mxc:subfield><mxc:subfield code="t">Culottées</mxc:subfield><mxc:subfield code="v">1</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="280"><mxc:subfield code="a">1 vol. (75 p.)</mxc:subfield></mxc:datafield>
</mxc:record></srw:record>
</srw:searchRetrieveResponse>`;

    const culotteesSistersXml = `<?xml version="1.0" encoding="UTF-8"?>
<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/" xmlns:mxc="info:lc/xmlns/marcxchange-v2">
<srw:record><mxc:record>
  <mxc:datafield tag="020"><mxc:subfield code="a">9782072794100</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="245"><mxc:subfield code="a">Culottées</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="460"><mxc:subfield code="3">45646405</mxc:subfield><mxc:subfield code="t">Culottées</mxc:subfield><mxc:subfield code="v">1</mxc:subfield></mxc:datafield>
</mxc:record></srw:record>
<srw:record><mxc:record>
  <mxc:datafield tag="020"><mxc:subfield code="a">9782075212007</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="245"><mxc:subfield code="a">Culottées</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="460"><mxc:subfield code="3">45646405</mxc:subfield><mxc:subfield code="t">Culottées</mxc:subfield><mxc:subfield code="v">2</mxc:subfield></mxc:datafield>
</mxc:record></srw:record>
</srw:searchRetrieveResponse>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('catalogue.bnf.fr') && url.includes('9782072794100')) {
          return new Response(culotteesT1Xml, { status: 200 });
        }
        if (url.includes('catalogue.bnf.fr') && url.includes('Culott')) {
          return new Response(culotteesSistersXml, { status: 200 });
        }
        return new Response('', { status: 404 });
      })
    );

    const staging = await discoverMultiSourceLayer3('9782072794100');
    expect(staging).not.toBeNull();
    // Tome 2 (9782075212007) ne doit PAS être aspiré dans les sœurs du Tome 1 !
    expect(staging!.sisterEditions.some((s) => s.isbn13 === '9782075212007')).toBe(false);
    // Folio ne doit jamais voter comme série
    expect(staging!.seriesCandidates.some((c) => /folio/i.test(c.rawName))).toBe(false);

    const bookT1 = await consolidateBookLayer4(db, staging!, {
      sourceChannel: 'canal_4_ai_photo',
      libraryId: 'lib_1',
      action: 'owned'
    });
    expect(bookT1.seriesName).toBe('Culottées');
    expect(bookT1.volumeNumber).toBe(1);
    expect(bookT1.knownIsbns).not.toContain('9782075212007');

    // Tome 2 doit rester un FULL_MISS indépendant prêt à être ingéré séparément
    const l2T2 = await checkBookIndexLayer2(db, '9782075212007', 'lib_1');
    expect(l2T2.status).toBe('FULL_MISS');

    vi.unstubAllGlobals();
  });

  it('unifie Collection les Schtroumpfs et Les Schtroumpfs: série classique dans le même cluster série', () => {
    const elected = electCanonicalSeriesFromVotes([
      {
        source: 'bnf_anchor',
        rawName: 'Collection les Schtroumpfs',
        coreKey: 'schtroumpfs',
        cleanDisplay: 'Les Schtroumpfs',
        weight: 3
      },
      {
        source: 'inventaire_p179',
        rawName: 'Les Schtroumpfs: série classique',
        coreKey: 'schtroumpfs',
        cleanDisplay: 'Les Schtroumpfs',
        weight: 3
      }
    ]);
    expect(elected?.coreKey).toBe('schtroumpfs');
    expect(elected?.canonicalName).toBe('Les Schtroumpfs');
    expect(elected?.confidenceRatio).toBe(1);
  });

  it('ne classe JAMAIS un one-shot épais (>=180 pages ou avec sous-titre) comme Intégrale', async () => {
    const { db } = createInMemoryV4Db();
    const payload: StagingPayload = {
      anchorIsbn13: '9782754829212',
      anchorTitle: "Le droit du sol / Journal d'un vertige",
      language: 'fr',
      sisterEditions: [
        {
          source: 'openlibrary',
          isbn13: '9782754829212',
          title: 'Le droit du sol',
          pageCount: 216
        }
      ],
      seriesCandidates: [],
      authors: ['Étienne Davodeau'],
      illustrators: [],
      scriptwriters: [],
      pageCount: 216,
      rawSubjects: ['Bande dessinée'],
      rawTitles: ["Le droit du sol / Journal d'un vertige"],
      sourcesHit: ['bnf', 'openlibrary']
    };
    const intCheck = detectIntegralAndIncludedVolumes(payload);
    expect(intCheck.isIntegral).toBe(false);
    const saved = await consolidateBookLayer4(db, payload, {
      sourceChannel: 'canal_4_ai_photo',
      libraryId: 'lib_1',
      action: 'owned'
    });
    expect(saved.isIntegral).toBe(false);
  });

  it('reconnaît BnF 245$e=intégrale + Inventaire multi-P629 (ex: Aya de Yopougon Intégrale 2), extrait les tomes 4-6 et migre un ancien squelette', async () => {
    const { db, books, libBooks } = createInMemoryV4Db();
    // Pré-semer un vieux squelette C5 erroné sur lequel l'utilisateur était lié
    books.set('bk_old_skel', {
      id: 'bk_old_skel',
      work_canonical_id: 'series:aya yopougon:vol:2',
      canonical_title: 'Aya de Yopougon',
      is_integral: 0,
      known_isbns_json: '["9782075079334"]'
    });
    libBooks.set('lib_1::bk_old_skel', { library_id: 'lib_1', book_id: 'bk_old_skel', is_owned: 1, is_wished: 0 });

    const bnfXml = `<?xml version="1.0" encoding="UTF-8"?>
<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/" xmlns:mxc="info:lc/xmlns/marcxchange-v2">
<srw:record><mxc:record>
  <mxc:datafield tag="020"><mxc:subfield code="a">9782075079334</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="245"><mxc:subfield code="a">Aya de Yopougon</mxc:subfield><mxc:subfield code="e">intégrale</mxc:subfield><mxc:subfield code="u">02</mxc:subfield><mxc:subfield code="h">2</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="460"><mxc:subfield code="3">45271432</mxc:subfield><mxc:subfield code="t">Aya de Yopougon</mxc:subfield><mxc:subfield code="v">2</mxc:subfield></mxc:datafield>
  <mxc:datafield tag="950"><mxc:subfield code="a">777111</mxc:subfield></mxc:datafield>
</mxc:record></srw:record>
</srw:searchRetrieveResponse>`;

    const invJson = {
      entities: {
        'isbn:9782075079334': {
          type: 'edition',
          claims: {
            'wdt:P1476': ['Aya de Yopougon - Intégrale 2'],
            'wdt:P629': ['wd:Q110482781', 'wd:Q110482783', 'wd:Q110482785']
          }
        },
        'wd:Q110482781': { claims: { 'wdt:P1545': ['4'], 'wdt:P179': ['wd:Q2734031'] } },
        'wd:Q110482783': { claims: { 'wdt:P1545': ['5'], 'wdt:P179': ['wd:Q2734031'] } },
        'wd:Q110482785': { claims: { 'wdt:P1545': ['6'], 'wdt:P179': ['wd:Q2734031'] } },
        'wd:Q2734031': { labels: { fr: 'Aya de Yopougon' } }
      }
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('catalogue.bnf.fr')) return new Response(bnfXml, { status: 200 });
        if (url.includes('inventaire.io')) return new Response(JSON.stringify(invJson), { status: 200 });
        return new Response('', { status: 404 });
      })
    );

    const staging = await discoverMultiSourceLayer3('9782075079334');
    expect(staging).not.toBeNull();
    expect(staging!.includedVolumeNumbersHint).toEqual(['4', '5', '6']);

    const saved = await consolidateBookLayer4(db, staging!, {
      sourceChannel: 'canal_4_ai_photo',
      libraryId: 'lib_1',
      action: 'owned',
      replaceSkeletonBookId: 'bk_old_skel'
    });
    expect(saved.isIntegral).toBe(true);
    expect(saved.canonicalTitle).toContain('Intégrale 2');
    expect(saved.volumeNumber).toBeNull();
    expect(saved.integralMetadata.includedVolumeNumbers).toEqual(['4', '5', '6']);
    expect(saved.selectedCoverUrl).toContain('idImage=777111');
    // Ancien squelette supprimé et possession migrée proprement sur le nouveau livre
    expect(books.has('bk_old_skel')).toBe(false);
    expect(libBooks.get(`lib_1::${saved.id}`)?.is_owned).toBe(1);

    vi.unstubAllGlobals();
  });

  it('propage userHint.includedVolumeNumbers sur une Intégrale et détecte INCLUDED_IN_INTEGRAL sur le tome inclus', async () => {
    const { db } = createInMemoryV4Db();

    const integralStaging: StagingPayload = {
      anchorIsbn13: '9782070658787',
      anchorTitle: 'Aya de Yopougon — Intégrale 1',
      language: 'fre',
      sisterEditions: [
        { isbn13: '9782070658787', title: 'Aya de Yopougon — Intégrale 1', language: 'fre', source: 'bnf' }
      ],
      seriesCandidates: [
        { source: 'bnf', rawName: 'Aya de Yopougon', coreKey: 'aya yopougon', cleanDisplay: 'Aya de Yopougon', weight: 4 }
      ],
      authors: ['Marguerite Abouet', 'Clément Oubrerie'],
      illustrators: [],
      scriptwriters: [],
      rawSubjects: ['Bande dessinée'],
      rawTitles: ['Aya de Yopougon — Intégrale 1'],
      sourcesHit: ['bnf']
    };

    const savedIntegral = await consolidateBookLayer4(db, integralStaging, {
      sourceChannel: 'canal_4_ai_photo',
      libraryId: 'lib_1',
      action: 'owned',
      userHint: {
        isIntegral: true,
        includedVolumeNumbers: ['1', '2', '3']
      }
    });

    expect(savedIntegral.isIntegral).toBe(true);
    expect(savedIntegral.integralMetadata.includedVolumeNumbers).toEqual(['1', '2', '3']);

    // Ajout d'un tome unitaire 3 (non possédé) -> Couche 2 doit détecter INCLUDED_IN_INTEGRAL
    const vol3Staging: StagingPayload = {
      anchorIsbn13: '9782075171229',
      anchorTitle: 'Aya de Yopougon',
      language: 'fre',
      sisterEditions: [
        { isbn13: '9782075171229', title: 'Aya de Yopougon', volumeNumber: '3', language: 'fre', source: 'bnf' }
      ],
      seriesCandidates: [
        { source: 'bnf', rawName: 'Aya de Yopougon', coreKey: 'aya yopougon', cleanDisplay: 'Aya de Yopougon', weight: 4 }
      ],
      authors: ['Marguerite Abouet'],
      illustrators: [],
      scriptwriters: [],
      rawSubjects: ['Bande dessinée'],
      rawTitles: ['Aya de Yopougon'],
      sourcesHit: ['bnf']
    };
    await consolidateBookLayer4(db, vol3Staging, {
      sourceChannel: 'canal_2_manual_isbn',
      libraryId: 'lib_1',
      action: 'preview'
    });

    const l2 = await checkBookIndexLayer2(db, '9782075171229', 'lib_1');
    expect(l2.status).toBe('INCLUDED_IN_INTEGRAL');
    expect(l2.ownedIntegralMatches.length).toBeGreaterThanOrEqual(1);
    expect(l2.ownedIntegralMatches[0].isbn13).toBe('9782070658787');
  });
});
