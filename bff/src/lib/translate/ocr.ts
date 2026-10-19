import { fork, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { OcrLine } from './ocrCore';

export interface PageText { lines: OcrLine[]; width: number; height: number; ms: number }

/**
 * The parent side of the OCR worker (ocrWorker.ts): one child process, started on the first page, holding the models
 * until `stop()`. Pages go one at a time; a page that takes longer than its deadline kills the child, which the next
 * page starts again, rather than leaving every later page queued behind a stuck one.
 */
export class OcrWorker {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: PageText) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly dir: string, private readonly threads: number) {}

  private start(): Promise<ChildProcess> {
    if (this.child && this.child.connected) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.starting = new Promise<ChildProcess>((resolve, reject) => {
      // The worker runs with the same loader as this process (tsx in tests, plain node in the image).
      const entry = path.join(__dirname, `ocrWorker${path.extname(__filename)}`);
      // Nothing of the server's environment is needed there, the database URL and secrets least of all.
      const child = fork(entry, [], {
        serialization: 'advanced', execArgv: process.execArgv,
        env: { PATH: process.env.PATH ?? '', UCHIYOMI_OCR_WORKER: '1' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      try { if (child.pid) os.setPriority(child.pid, 15); } catch { /* not permitted: it runs at normal priority */ }
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
      const fail = (e: Error) => {
        this.child = null; this.starting = null;
        for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(e); }
        this.waiting.clear();
        reject(e);
      };
      child.on('message', (m: { type: string; id?: number; message?: string } & Partial<PageText>) => {
        if (m.type === 'ready') { this.child = child; this.starting = null; resolve(child); return; }
        const w = m.id != null ? this.waiting.get(m.id) : undefined;
        if (!w) {
          if (m.type === 'error' && m.id == null) fail(new Error(`OCR worker: ${m.message}`));
          return;
        }
        this.waiting.delete(m.id!);
        clearTimeout(w.timer);
        if (m.type === 'result') w.resolve({ lines: m.lines ?? [], width: m.width ?? 0, height: m.height ?? 0, ms: m.ms ?? 0 });
        else w.reject(new Error(m.message ?? 'OCR failed'));
      });
      child.on('exit', (code, signal) => fail(new Error(`OCR worker exited (${signal ?? code})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)));
      child.on('error', fail);
      child.send({ type: 'init', dir: this.dir, threads: this.threads });
    });
    return this.starting;
  }

  /** The text lines of one page (its bytes as stored), in the page's own pixels. */
  async read(bytes: Buffer, lang: string, timeoutMs = 120_000): Promise<PageText> {
    const child = await this.start();
    const id = ++this.seq;
    return new Promise<PageText>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('OCR took too long'));
        this.stop();
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      child.send({ type: 'ocr', id, bytes, lang });
    });
  }

  get running(): boolean { return !!this.child?.connected; }

  stop(): void {
    const c = this.child;
    this.child = null; this.starting = null;
    for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error('OCR stopped')); }
    this.waiting.clear();
    if (c && c.exitCode == null) c.kill();
  }
}
