/** A chapter of ordered image parts, written without retaining the chapter in memory. */
import type { FastifyRequest } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { MAX_PAGE_BYTES } from './archiveCaps';

export const IMAGE_CHAPTER_MAX_PAGES = 2000;
export class ImageChapterError extends Error {
  constructor(public code: string, public statusCode = 400, public page?: string) { super(code); }
}
const formats: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', heif: 'avif' };
const allowed = /\.(?:jpe?g|png|webp|gif|avif)$/i;

/** STORE ZIP entries: pages are already compressed, and recompressing them wastes CPU and RAM. */
export async function writeImageChapter(req: FastifyRequest, output: string, maxBytes: number, checkSpace: () => Promise<void>): Promise<number> {
  const staging = join(dirname(output), `.${basename(output)}.pages-${randomBytes(6).toString('hex')}`);
  const cancelled = new AbortController();
  const abort = () => cancelled.abort();
  req.raw.once('aborted', abort);
  const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(15 * 60_000)]);
  let out: Awaited<ReturnType<typeof fs.open>> | undefined;
  let offset = 0, total = 0, count = 0;
  const central: Buffer[] = [];
  const ceiling = Math.min(maxBytes, 0xffff0000); // bounded ZIP32; no browser-sized allocation or ZIP64 surprise
  const write = async (data: Buffer) => {
    if (signal.aborted) throw signal.reason;
    if (offset + data.length > ceiling) throw new ImageChapterError('too_large', 413);
    let at = 0;
    while (at < data.length) at += (await out!.write(data, at, data.length - at, offset + at)).bytesWritten;
    offset += data.length;
  };
  try {
    await fs.mkdir(staging, { mode: 0o700 });
    out = await fs.open(output, 'wx', 0o600);
    for await (const part of req.parts({ limits: { fields: 0, files: IMAGE_CHAPTER_MAX_PAGES, parts: IMAGE_CHAPTER_MAX_PAGES,
      fileSize: Math.min(MAX_PAGE_BYTES, ceiling), fieldNameSize: 40, headerPairs: 30 } })) {
      if (part.type !== 'file' || part.fieldname !== 'pages') throw new ImageChapterError('bad_request');
      const page = basename(part.filename).slice(0, 255);
      if (!allowed.test(page)) { part.file.resume(); throw new ImageChapterError('image_type', 400, page); }
      if (++count > IMAGE_CHAPTER_MAX_PAGES) throw new ImageChapterError('too_many_pages', 413);
      const temporary = join(staging, String(count));
      let size = 0, checked = 0;
      const cap = new Transform({ transform(chunk: Buffer, _encoding, done) {
        size += chunk.length; total += chunk.length; checked += chunk.length;
        if (size > MAX_PAGE_BYTES || total > ceiling) return done(new ImageChapterError('too_large', 413, page));
        if (checked >= 1024 * 1024) { checked = 0; checkSpace().then(() => done(null, chunk), done); }
        else done(null, chunk);
      } });
      await pipeline(part.file, cap, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      if (part.file.truncated) throw new ImageChapterError('too_large', 413, page);
      if (!size) throw new ImageChapterError('invalid_page', 400, page);
      let extension: string;
      try {
        const metadata = await sharp(temporary, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
        extension = formats[metadata.format ?? ''];
        if (!extension || (metadata.format === 'heif' && !/\.avif$/i.test(page))) throw new Error('unsupported image');
        await sharp(temporary, { limitInputPixels: 64 * 1024 * 1024 }).resize({ width: 1, height: 1, fit: 'inside' }).toBuffer();
      } catch { throw new ImageChapterError('invalid_page', 400, page); }
      await checkSpace();
      const name = Buffer.from(`${String(count).padStart(5, '0')}.${extension}`);
      const start = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 6);
      header.writeUInt16LE(33, 12); // 1980-01-01, the earliest valid DOS date
      header.writeUInt16LE(name.length, 26);
      await write(header); await write(name);
      let crc = 0, sinceSpace = 0;
      for await (const chunk of createReadStream(temporary, { signal })) {
        crc = crc32(chunk, crc); await write(chunk); sinceSpace += chunk.length;
        if (sinceSpace >= 1024 * 1024) { sinceSpace = 0; await checkSpace(); }
      }
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); await write(descriptor);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 8);
      entry.writeUInt16LE(33, 14);
      entry.writeUInt32LE(crc >>> 0, 16); entry.writeUInt32LE(size, 20); entry.writeUInt32LE(size, 24);
      entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(start, 42);
      central.push(entry, name);
      await fs.unlink(temporary);
    }
    if (!count) throw new ImageChapterError('empty');
    const directoryStart = offset;
    for (const chunk of central) await write(chunk);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
    end.writeUInt32LE(offset - directoryStart, 12); end.writeUInt32LE(directoryStart, 16); await write(end);
    return offset;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new ImageChapterError('too_large', 413);
    if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') throw new ImageChapterError('too_many_pages', 413);
    if (code === 'FST_FIELDS_LIMIT') throw new ImageChapterError('bad_request');
    throw error;
  } finally {
    req.raw.off('aborted', abort);
    await out?.close();
    await fs.rm(staging, { recursive: true, force: true });
  }
}
