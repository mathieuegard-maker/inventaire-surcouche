// server/adapters/fs-cover-bucket.adapter.ts
// Adaptateur stockage disque local implémentant `CoverBucketBinding` (remplace Cloudflare R2 en auto-hébergement).

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CoverBucketBinding } from '../../src/core/adapters/storage-db.interface';

interface StoredMeta {
  contentType?: string;
  cacheControl?: string;
  etag?: string;
}

export class FsCoverBucketAdapter implements CoverBucketBinding {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  private resolveSafePath(key: string): string {
    const cleanKey = key.replace(/^\/+/, '').replace(/\\/g, '/');
    const resolved = path.resolve(this.rootDir, cleanKey);
    if (!resolved.startsWith(this.rootDir + path.sep) && resolved !== this.rootDir) {
      throw new Error(`Invalid cover storage key: ${key}`);
    }
    return resolved;
  }

  async get(key: string) {
    const filePath = this.resolveSafePath(key);
    try {
      const buf = await fsp.readFile(filePath);
      let meta: StoredMeta = {};
      try {
        const rawMeta = await fsp.readFile(`${filePath}.meta.json`, 'utf-8');
        meta = JSON.parse(rawMeta) as StoredMeta;
      } catch {
        // Métadonnées optionnelles
      }

      const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(uint8);
          controller.close();
        }
      });

      return {
        body: stream,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        httpMetadata: {
          contentType: meta.contentType || 'image/webp'
        },
        etag: meta.etag || crypto.createHash('sha1').update(buf).digest('hex')
      };
    } catch {
      return null;
    }
  }

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }
  ): Promise<unknown> {
    const filePath = this.resolveSafePath(key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });

    let buf: Buffer;
    if (typeof value === 'string') {
      buf = Buffer.from(value, 'utf-8');
    } else if (value instanceof ArrayBuffer) {
      buf = Buffer.from(value);
    } else if (value instanceof Uint8Array) {
      buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunk) chunks.push(chunk);
      }
      buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    }

    const etag = crypto.createHash('sha1').update(buf).digest('hex');
    await fsp.writeFile(filePath, buf);
    const meta: StoredMeta = {
      contentType: options?.httpMetadata?.contentType || 'image/webp',
      cacheControl: options?.httpMetadata?.cacheControl,
      etag
    };
    await fsp.writeFile(`${filePath}.meta.json`, JSON.stringify(meta), 'utf-8');
    return { key, etag, size: buf.byteLength };
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveSafePath(key);
    await fsp.unlink(filePath).catch(() => {});
    await fsp.unlink(`${filePath}.meta.json`).catch(() => {});
  }
}
