import { describe, it, expect, vi } from 'vitest';
import {
  bytesToBase64,
  parseCoverDataUrl,
  storeCompressedCover,
  getStoredCover
} from './d1-cover-storage.service';

describe('d1-cover-storage.service', () => {
  it('parse une dataURL WebP valide et rejette les formats invalides', () => {
    const sample = new Uint8Array(150).fill(65);
    const dataUrl = `data:image/webp;base64,${bytesToBase64(sample)}`;
    const parsed = parseCoverDataUrl(dataUrl);

    expect(parsed).not.toBeNull();
    expect(parsed?.contentType).toBe('image/webp');
    expect(parsed?.bytes.byteLength).toBe(150);

    expect(parseCoverDataUrl('https://example.com/cover.jpg')).toBeNull();
    expect(parseCoverDataUrl('data:text/plain;base64,SGVsbG8=')).toBeNull();
  });

  it('stocke et lit prioritairement sur R2 lorsque COVERS_BUCKET est lié', async () => {
    const r2Map = new Map<string, { body: Uint8Array; contentType: string }>();
    const env: any = {
      COVERS_BUCKET: {
        put: vi.fn(async (key: string, value: any, opts?: any) => {
          r2Map.set(key, {
            body: value instanceof Uint8Array ? value : new Uint8Array(value),
            contentType: opts?.httpMetadata?.contentType || 'image/webp'
          });
        }),
        get: vi.fn(async (key: string) => {
          const entry = r2Map.get(key);
          if (!entry) return null;
          return {
            arrayBuffer: async () => entry.body.buffer.slice(entry.body.byteOffset, entry.body.byteOffset + entry.body.byteLength),
            httpMetadata: { contentType: entry.contentType }
          };
        })
      }
    };

    const bytes = new Uint8Array(240).fill(42);
    const saved = await storeCompressedCover(env, {
      isbn: '9782012101333',
      contentType: 'image/webp',
      bytes
    });

    expect(saved.ok).toBe(true);
    expect(saved.storage).toBe('r2');
    expect(saved.key).toBe('covers/isbn/9782012101333');

    const hit = await getStoredCover(env, { isbn: '9782012101333' });
    expect(hit).not.toBeNull();
    expect(hit?.storage).toBe('r2');
    expect(hit?.contentType).toBe('image/webp');
    expect(hit?.bytes.byteLength).toBe(240);
  });

  it('bascule automatiquement sur D1 catalog_covers tant que R2 n’est pas activé', async () => {
    const rows = new Map<string, { cover_key: string; isbn13: string | null; content_type: string; image_data: string }>();
    const env: any = {
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: (...args: any[]) => ({
            run: async () => {
              if (sql.includes('INSERT INTO catalog_covers')) {
                const [cover_key, isbn13, content_type, image_data] = args;
                rows.set(cover_key, { cover_key, isbn13, content_type, image_data });
              }
              return { success: true };
            },
            first: async () => {
              if (sql.includes('WHERE cover_key = ?')) {
                return rows.get(args[0]) ?? null;
              }
              if (sql.includes('WHERE isbn13 = ?')) {
                for (const v of rows.values()) {
                  if (v.isbn13 === args[0]) return v;
                }
              }
              return null;
            },
            all: async () => ({ results: Array.from(rows.values()), success: true })
          })
        }))
      }
    };

    const bytes = new Uint8Array(200).fill(99);
    const saved = await storeCompressedCover(env, {
      isbn: '978-2-01-210133-3',
      contentType: 'image/webp',
      bytes
    });

    expect(saved.ok).toBe(true);
    expect(saved.storage).toBe('d1');

    const hit = await getStoredCover(env, { isbn: '9782012101333' });
    expect(hit).not.toBeNull();
    expect(hit?.storage).toBe('d1');
    expect(hit?.contentType).toBe('image/webp');
    expect(hit?.bytes.byteLength).toBe(200);
  });
});
