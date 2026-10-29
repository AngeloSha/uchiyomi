import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { OcrLine } from './ocrCore';

export interface PageText { lines: OcrLine[]; width: number; height: number; ms: number }
interface WorkerOptions {
  /** Injectable process boundary for deterministic lifecycle tests. */
  spawn?: (entry: string, options: ForkOptions) => ChildProcess;
  initTimeoutMs?: number;
}

/**
 * The parent side of the OCR worker (ocrWorker.ts): one child process, started on the first page, holding the models
 * until `stop()`. Pages go one at a time; a page that takes longer than its deadline kills the child, which the next
 * page starts again, rather than leaving every later page queued behind a stuck one.
 */
export class OcrWorker {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private startingChild: ChildProcess | null = null;
  private rejectStarting: ((error: Error) => void) | null = null;
  private initTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: PageText) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly dir: string, private readonly threads: number, private readonly options: WorkerOptions = {}) {}

  private start(): Promise<ChildProcess> {
    if (this.starting) return this.starting;
    if (this.child && this.child.connected) return Promise.resolve(this.child);
    const generation = ++this.generation;
    let resolve!: (child: ChildProcess) => void;
    let reject!: (error: Error) => void;
    const starting = new Promise<ChildProcess>((yes, no) => { resolve = yes; reject = no; });
    this.starting = starting;
    this.rejectStarting = reject;
    let child: ChildProcess;
    const fail = (error: Error) => {
      if (this.generation !== generation) return;
      this.stop(error);
    };
    try {
      // The worker runs with the same loader as this process (tsx in tests, plain node in the image).
      const entry = path.join(__dirname, `ocrWorker${path.extname(__filename)}`);
      // Nothing of the server's environment is needed there, the database URL and secrets least of all.
      const opts: ForkOptions = {
        serialization: 'advanced', execArgv: process.execArgv,
        env: { PATH: process.env.PATH ?? '', UCHIYOMI_OCR_WORKER: '1' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      };
      child = this.options.spawn ? this.options.spawn(entry, opts) : fork(entry, [], opts);
      this.startingChild = child;
      try { if (child.pid) os.setPriority(child.pid, 15); } catch { /* not permitted: it runs at normal priority */ }
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
      child.on('message', (m: { type: string; id?: number; message?: string } & Partial<PageText>) => {
        if (this.generation !== generation) return;
        if (m.type === 'ready') {
          if (this.startingChild !== child) return;
          if (this.initTimer) clearTimeout(this.initTimer);
          this.initTimer = null; this.startingChild = null; this.rejectStarting = null;
          this.child = child; this.starting = null; resolve(child); return;
        }
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
      const requested = this.options.initTimeoutMs;
      const initTimeout = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(60_000, requested) : 30_000;
      this.initTimer = setTimeout(() => fail(new Error('OCR initialization took too long')), initTimeout);
      child.send({ type: 'init', dir: this.dir, threads: this.threads });
    } catch (error) { fail(error instanceof Error ? error : new Error('OCR could not start')); }
    return starting;
  }

  /** The text lines of one page (its bytes as stored), in the page's own pixels. */
  async read(bytes: Buffer, lang: string, timeoutMs = 120_000): Promise<PageText> {
    const child = await this.start();
    if (this.child !== child || !child.connected) throw new Error('OCR stopped');
    const id = ++this.seq;
    return new Promise<PageText>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.waiting.has(id)) return;
        this.waiting.delete(id);
        reject(new Error('OCR took too long'));
        this.stop();
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try { child.send({ type: 'ocr', id, bytes, lang }); }
      catch (error) { this.stop(error instanceof Error ? error : new Error('OCR request failed')); }
    });
  }

  get running(): boolean { return !!this.child?.connected; }

  stop(error = new Error('OCR stopped')): void {
    const c = this.child;
    const startingChild = this.startingChild;
    const rejectStarting = this.rejectStarting;
    this.generation++;
    this.child = null; this.starting = null;
    this.startingChild = null; this.rejectStarting = null;
    if (this.initTimer) clearTimeout(this.initTimer);
    this.initTimer = null;
    rejectStarting?.(error);
    for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(error); }
    this.waiting.clear();
    if (c && c.exitCode == null) c.kill();
    if (startingChild && startingChild !== c && startingChild.exitCode == null) startingChild.kill();
  }
}
