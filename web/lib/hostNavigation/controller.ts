import { actionAllowed, type NavigationAction, type NavigationPresentation } from './model';

export type WebNavigationMessage = {
  version: 1; session: string; revision: number;
} & ({ kind: 'hello' | 'state'; state: NavigationPresentation }
  | { kind: 'stop' }
  | { kind: 'result'; request: string; accepted: boolean });

/** Only the adapter knows how its host exchanges messages. Inbound data is untrusted. */
export interface NavigationTransport {
  send(message: WebNavigationMessage): void;
  subscribe(receive: (message: unknown) => void): () => void;
}
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A single document's navigation session; independent of React, WebKit and cache ownership. */
export class NavigationController {
  private state: NavigationPresentation;
  private revision = 1;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private started = false;
  private active = false;
  private requests = new Set<string>();

  constructor(private readonly transport: NavigationTransport, private readonly session: string,
    initial: NavigationPresentation,
    private readonly action: (action: NavigationAction) => void,
    private readonly ownership: (active: boolean) => void,
    private readonly timeoutMs = 3000) {
    if (!token(session)) throw new Error('Invalid navigation session');
    this.state = initial;
  }
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.timer = setTimeout(() => this.dispose(), this.timeoutMs);
    try {
      const unsubscribe = this.transport.subscribe(message => this.receive(message));
      // An adapter can synchronously reset us while installing its listener.
      if (this.disposed) { unsubscribe(); return; }
      this.unsubscribe = unsubscribe;
      this.send({ kind: 'hello', state: this.state });
    } catch { this.dispose(); }
  }
  update(state: NavigationPresentation): void {
    if (this.disposed || JSON.stringify(this.state) === JSON.stringify(state)) return;
    this.state = state;
    this.revision++;
    if (this.active) this.send({ kind: 'state', state });
  }
  private send(message: { kind: 'hello' | 'state'; state: NavigationPresentation } | { kind: 'stop' } | { kind: 'result'; request: string; accepted: boolean }): boolean {
    try {
      this.transport.send({ ...message, version: 1, session: this.session, revision: this.revision });
      return true;
    } catch { this.dispose(); return false; }
  }
  private receive(message: unknown): void {
    if (this.disposed || !object(message) || message.version !== 1 || message.session !== this.session) return;
    if (message.kind === 'ready' && !this.active) {
      clearTimeout(this.timer);
      this.active = true;
      // This state confirms the handshake on the host; a send failure keeps web chrome.
      if (this.send({ kind: 'state', state: this.state }) && !this.disposed) this.ownership(true);
    } else if (message.kind === 'action' && this.active && token(message.request)) {
      if (this.requests.has(message.request)) return;
      this.requests.add(message.request);
      if (this.requests.size > 128) this.requests.delete(this.requests.values().next().value!);
      const accepted = message.revision === this.revision && actionAllowed(this.state, message.action);
      if (accepted) {
        try { this.action(message.action as NavigationAction); }
        catch { this.send({ kind: 'result', request: message.request, accepted: false }); return; }
      }
      this.send({ kind: 'result', request: message.request, accepted });
    } else if (message.kind === 'reset') this.dispose();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    try { this.unsubscribe?.(); } catch { /* A disconnected host must still restore web chrome. */ }
    this.unsubscribe = undefined;
    this.requests.clear();
    this.active = false;
    this.ownership(false);
    // Best effort: disposal must be safe even when the native process is gone.
    try { this.transport.send({ kind: 'stop', version: 1, session: this.session, revision: this.revision }); } catch {}
  }
}
