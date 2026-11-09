// Suwayomi authentication, verified against upstream d5215280 (JavalinSetup.kt, UserMutation.kt, Jwt.kt).
// Sessions stay in memory. Nothing returned by the engine's login endpoints is included in an error or log.
// Form contract: https://github.com/Suwayomi/Suwayomi-Server/blob/d5215280158b9b78d2e3ca46312e39dccde6b97b/server/src/main/kotlin/suwayomi/tachidesk/server/JavalinSetup.kt
// JWT contract: https://github.com/Suwayomi/Suwayomi-Server/blob/d5215280158b9b78d2e3ca46312e39dccde6b97b/server/src/main/kotlin/suwayomi/tachidesk/graphql/mutations/UserMutation.kt
// Legacy form: https://github.com/Suwayomi/Suwayomi-Server/blob/v2.4.2366/server/src/main/kotlin/suwayomi/tachidesk/server/JavalinSetup.kt
import { readCapped } from '../../safeFetch';
import { AUTH_OPS } from './operations';

export type EngineAuthMode = 'auto' | 'none' | 'basic' | 'simple' | 'ui_login';
export interface EngineAuthConfig { base: string; mode: EngineAuthMode; username: string; password: string }
interface Session { headers: Record<string, string>; expires: number; refresh?: string }
const AUTH_MS = 15_000;
const bearer = (value: unknown): value is string => typeof value === 'string' && value.length <= 16 * 1024 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
const cookieValue = (value: string): boolean => value.length <= 4096 && /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value);

export class EngineAuthError extends Error {
  constructor(readonly status: number, text: string) { super(`suwayomi ${status}: ${text}`); }
}
export class EngineLoginError extends EngineAuthError {
  constructor() { super(401, 'the extension engine refused its configured login'); }
}

function expiry(token: string): number {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
    if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000 - 10_000;
  } catch { /* Opaque tokens on an older engine: refresh on an explicit refusal instead. */ }
  return Date.now() + 4 * 60_000;
}

/** Wait for shared login without letting one aborted reader cancel every other reader's login. */
async function waitFor<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class EngineAuth {
  private session: Session | null = null;
  private pending: Promise<Session> | null = null;
  private readonly sent = new WeakMap<Response, Record<string, string>>();
  readonly mode: Exclude<EngineAuthMode, 'auto'>;
  constructor(private readonly config: EngineAuthConfig) {
    this.mode = config.mode === 'auto' ? (config.username ? 'basic' : 'none') : config.mode;
  }

  private target(raw: string | URL): URL {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.origin !== new URL(this.config.base).origin) {
      throw new Error('suwayomi: refusing credentials outside the configured engine');
    }
    return url;
  }

  async headers(signal?: AbortSignal | null): Promise<Record<string, string>> {
    signal?.throwIfAborted();
    if (this.mode === 'none') return {};
    if (this.mode === 'basic') return { authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}` };
    if (!this.session || this.session.expires <= Date.now()) {
      if (!this.pending) {
        this.pending = this.authenticate().then((s) => (this.session = s)).finally(() => { this.pending = null; });
      }
      await waitFor(this.pending, signal);
    }
    return { ...this.session!.headers };
  }

  /** Invalidate only the rejected generation: concurrent 401s must not throw away a newly refreshed token. */
  invalidate(rejected: Record<string, string>): void {
    if (this.session && JSON.stringify(this.session.headers) === JSON.stringify(rejected)) this.session.expires = 0;
  }

  rejected(response: Response): void {
    const headers = this.sent.get(response);
    if (headers) this.invalidate(headers);
  }

  async fetch(raw: string | URL, init: RequestInit = {}, retryAuth = (init.method ?? 'GET').toUpperCase() === 'GET'): Promise<Response> {
    const url = this.target(raw);
    const credentials = await this.headers(init.signal);
    const request = (auth: Record<string, string>) => {
      const headers = new Headers(init.headers);
      // A previously captured generation must never override the refreshed credentials.
      headers.delete('authorization'); headers.delete('cookie');
      for (const [key, value] of Object.entries(auth)) headers.set(key, value);
      return fetch(url, { ...init, headers, redirect: 'manual' }).then((r) => { this.sent.set(r, auth); return r; });
    };
    const response = await request(credentials);
    if (response.status !== 401 || this.mode === 'none' || this.mode === 'basic') return response;
    this.invalidate(credentials);
    if (!retryAuth) return response;
    await response.body?.cancel().catch(() => {});
    const renewed = await this.headers(init.signal);
    const retry = await request(renewed); // exactly one retry, never on 403, 5xx or transport errors
    if (retry.status === 401) this.invalidate(renewed);
    return retry;
  }

  private async authJson(query: string, input: Record<string, string>, signal: AbortSignal): Promise<any> {
    const response = await fetch(this.target(`${this.config.base}/api/graphql`), {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables: { input } }), redirect: 'manual', signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new EngineLoginError();
      throw new EngineAuthError(response.status, 'authentication endpoint failed');
    }
    let json: any;
    try { json = JSON.parse((await readCapped(response, 64 * 1024)).toString()); }
    catch (error) { if (signal.aborted) signal.throwIfAborted(); throw new Error('suwayomi returned no data from authentication'); }
    if (json?.errors?.length) {
      if (query === AUTH_OPS.login.doc || json.errors.every((e: any) => /unauthorized|token.{0,40}(?:expired|revoked|invalid)|(?:expired|invalid).{0,40}token|signature.{0,40}(?:invalid|verification)/i.test(String(e?.message)))) throw new EngineLoginError();
      throw new Error('suwayomi: authentication operation refused');
    }
    if (!json?.data) throw new Error('suwayomi returned no data from authentication');
    return json.data;
  }

  private async authenticate(): Promise<Session> {
    if (!this.config.username) throw new EngineLoginError();
    const signal = AbortSignal.timeout(AUTH_MS);
    if (this.mode === 'ui_login') {
      // Refresh rejection is explicit GraphQL failure; transport/timeouts must not silently resubmit login.
      if (this.session?.refresh) {
        try {
          const data = await this.authJson(AUTH_OPS.refreshToken.doc, { refreshToken: this.session.refresh }, signal);
          const access = data.refreshToken?.accessToken;
          if (!bearer(access)) throw new EngineAuthError(502, 'authentication returned an invalid token');
          return { headers: { authorization: `Bearer ${access}` }, expires: expiry(access), refresh: this.session.refresh };
        } catch (error) { if (!(error instanceof EngineLoginError)) throw error; }
      }
      const data = await this.authJson(AUTH_OPS.login.doc, { username: this.config.username, password: this.config.password }, signal);
      const { accessToken, refreshToken } = data.login ?? {};
      if (!bearer(accessToken) || !bearer(refreshToken)) throw new EngineAuthError(502, 'authentication returned an invalid token');
      return { headers: { authorization: `Bearer ${accessToken}` }, expires: expiry(accessToken), refresh: refreshToken };
    }
    // SIMPLE_LOGIN is Jetty's session form, not the UI_LOGIN JWT mutation. Obtain the CSRF token and
    // JSESSIONID, then accept only its documented success redirect without following it. Supported
    // v2.3/v2.4 forms predate CSRF and establish JSESSIONID only on POST; newer forms require both.
    const login = this.target(`${this.config.base}/login.html`);
    const jar = new Map<string, string>();
    const cookies = (response: Response) => {
      for (const value of response.headers.getSetCookie()) {
        const pair = /^([!#$%&'*+.^_`|~\w-]+)=([^;\r\n]*)/.exec(value);
        if (pair && pair[1].toUpperCase() === 'JSESSIONID') {
          if (!cookieValue(pair[2])) throw new EngineAuthError(502, 'authentication returned an invalid session');
          jar.set(pair[1], pair[2]);
        }
      }
    };
    const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    const page = await fetch(login, { redirect: 'manual', signal });
    cookies(page);
    if (page.status !== 200) { await page.body?.cancel().catch(() => {}); throw new EngineLoginError(); }
    const html = (await readCapped(page, 256 * 1024)).toString();
    const token = /<input\b[^>]*\bname=["']csrf-token["'][^>]*\bvalue=["']([^"']+)["']/i.exec(html)?.[1];
    if (/\bname=["']csrf-token["']/i.test(html) && (!token || !cookie())) throw new EngineLoginError();
    const form = new URLSearchParams({ user: this.config.username, pass: this.config.password });
    if (token) form.set('csrf-token', token);
    const posted = await fetch(login, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie() ? { cookie: cookie() } : {}) },
      body: form,
      redirect: 'manual', signal,
    });
    cookies(posted);
    await posted.body?.cancel().catch(() => {});
    const location = posted.headers.get('location');
    let destination: URL | undefined;
    try { if (location) destination = new URL(location, login); } catch { /* fail closed */ }
    if (posted.status !== 303 || !location?.startsWith('/') || location.startsWith('//') || !destination
      || destination.origin !== login.origin || destination.username || destination.password || destination.pathname === login.pathname || !cookie()) throw new EngineLoginError();
    return { headers: { cookie: cookie() }, expires: Date.now() + 25 * 60_000 };
  }
}
