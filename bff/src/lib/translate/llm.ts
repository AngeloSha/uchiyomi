import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

/** What the translation model runs from: the downloaded llama-server and model, or a llama.cpp-compatible URL. */
export interface ModelRun {
  /** llama-server from the download; absent when `url` names a server that is already running. */
  bin?: string;
  model?: string;
  /** The vision projector: with it the model can be shown the page (the large model only). */
  mmproj?: string;
  /** The large model carries its own draft heads (multi-token prediction): speculative decoding at no extra memory. */
  mtp?: boolean;
  threads: number;
  url?: string;
}

/** Loading 18 GB from a hard disk took 90 s on the owner's server: the first page waits this long at most. */
const LOAD_TIMEOUT_MS = 5 * 60_000;

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

/**
 * llama-server as a child of the server: started on the first page, kept while pages come, stopped by the engine when
 * idle. It listens on 127.0.0.1 only, on a free port, and runs at low priority so reading and downloading stay quick.
 */
export class TranslationModel {
  private child: ChildProcess | null = null;
  private base: string | null = null;
  private starting: Promise<string> | null = null;
  private stderr = '';

  constructor(private readonly run: ModelRun) {}

  get vision(): boolean { return !!this.run.mmproj; }
  get running(): boolean { return !!this.base && (!!this.run.url || (!!this.child && this.child.exitCode == null)); }

  private async start(): Promise<string> {
    if (this.base && this.running) return this.base;
    if (this.run.url) return (this.base = this.run.url.replace(/\/+$/, ''));
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!this.run.bin || !this.run.model) throw new Error('the translation engine is not installed');
      const port = await freePort();
      const args = ['-m', this.run.model, '--host', '127.0.0.1', '--port', String(port),
        '-t', String(this.run.threads), '-tb', String(this.run.threads), '-c', '8192', '--parallel', '1', '--no-webui'];
      if (this.run.mmproj) args.push('--mmproj', this.run.mmproj);
      if (this.run.mtp) args.push('--spec-type', 'draft-mtp');
      // Nothing of the server's environment goes along: the model needs none of it, the database URL least of all.
      const child = spawn(this.run.bin, args, { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      try { if (child.pid) os.setPriority(child.pid, 15); } catch { /* not permitted: normal priority */ }
      this.stderr = '';
      child.stderr?.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-4000); });
      // ⚠️ Listened to, always: an 'error' with no listener (a binary that cannot be run) would take the server down with it.
      let failed: Error | null = null;
      child.on('error', (e) => { failed = e; });
      this.child = child;
      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + LOAD_TIMEOUT_MS;
      for (;;) {
        if (failed) { this.child = null; throw new Error(`the translation model stopped while loading: ${(failed as Error).message}`); }
        if (child.exitCode != null || child.signalCode) throw new Error(`the translation model stopped while loading: ${this.lastError()}`);
        try {
          const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) break;
        } catch { /* still loading */ }
        if (Date.now() > deadline) { this.stop(); throw new Error('the translation model took too long to load'); }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return (this.base = base);
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  private lastError(): string {
    const lines = this.stderr.trim().split('\n').filter((l) => /error|failed|cannot|unable/i.test(l));
    return (lines.pop() ?? this.stderr.trim().split('\n').pop() ?? 'no output').slice(0, 300);
  }

  /** One chat completion; `content` is the user turn (text, or text and the page image). */
  async chat(system: string, content: unknown, schema: object, timeoutMs = 10 * 60_000): Promise<{ text: string; timings: Record<string, number> }> {
    const base = await this.start();
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
        temperature: 0.2, max_tokens: 2000, cache_prompt: true,
        response_format: { type: 'json_schema', json_schema: { name: 'page', schema } },
        // The models think before answering by default: minutes a page on a CPU for little gain in a translation.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`the translation model answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json() as { choices?: { message?: { content?: string } }[]; timings?: Record<string, number> };
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('the translation model gave no answer');
    return { text, timings: j.timings ?? {} };
  }

  stop(): void {
    const c = this.child;
    this.child = null; this.base = null;
    if (c && c.exitCode == null) c.kill();
  }
}
