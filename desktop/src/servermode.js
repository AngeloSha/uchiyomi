// @ts-check
'use strict';
/**
 * Server mode: the desktop app as a plain window onto the user's OWN Uchiyomi server (the other first-launch
 * choice beside "On this computer"). Nothing runs locally in this mode -- no Postgres, no bff, no solver, no
 * engine, no sign-in secret -- and the window gets no desktop bridge: the server's web app behaves exactly as
 * it does in a browser (its own sign-in page, SSO, offline reading over https).
 *
 * This file is the pure half, so every decision here runs in the tests without Electron:
 *   normaliseOrigin  what the person typed -> an http(s) ORIGIN (sub-paths are not supported: the web app
 *                    uses absolute paths -- /auth/refresh, /sw.js, the manifest's start_url "/")
 *   probeServer      is there an Uchiyomi SERVER at that origin? GET /auth/config through the fetch main.js
 *                    passes in (hopFetch over electron's net.request: Chromium's network stack, so the
 *                    certificate decision is the one the window will make, and every redirect hop is seen);
 *                    a desktop-mode instance (`desktop: true`) is refused
 *   certDecision     self-signed certificates (owner, v0.45.0: ask once, pin, warn loudly on change):
 *                    'accept' only when Chromium trusts it or its SHA-256 equals the pin stored for that host;
 *                    a pinned host presenting anything else is 'changed', never silently accepted or re-pinned
 *                    -- and a server saved while this computer trusted its certificate is pinned as OS_PIN, so
 *                    an untrusted one there later is 'changed' too, never the friendly ask-once prompt
 *   pickStartup      which mode a launch starts in (a v0.44.0 profile -- libraryDir, no mode -- is standalone)
 *   navDecision      what the window may navigate to, per mode
 */
const crypto = require('node:crypto');

/** @param {unknown} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v : '');
/** @param {any} o @param {string} k */
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** Schemes that are never a server address (typed with or without `//`). */
const NOT_WEB = /^(file|ftp|javascript|data|mailto|blob|about|chrome|devtools|ws|wss|tel|smb|ssh)$/i;

/**
 * A host name as pins are keyed: lower case, and an IPv6 literal WITHOUT its brackets. ⚠️ The two sources
 * disagree: Chromium hands the verify proc `fd00::1` (HostPortPair::HostNoBrackets), while
 * new URL('https://[fd00::1]:8443').hostname is `[fd00::1]` -- keyed by the second, a self-signed IPv6 server
 * never matched its own pin, never showed the changed warning, and Forget left the pin behind.
 * @param {unknown} h
 */
const pinHost = (h) => str(h).replace(/^\[|\]$/g, '').toLowerCase();
/** The pin key of a URL's host ('' when it is not a URL). @param {unknown} u */
function originHost(u) {
  try { return pinHost(new URL(str(u)).hostname); } catch { return ''; }
}

/**
 * What the person typed -> the server's origin.
 *   no scheme      -> https:// is added (`schemeAdded`, so an unreachable answer can say "type http:// in full")
 *   a path/query   -> dropped (`path` says what was dropped: the page mentions it when the root is not Uchiyomi)
 *   user:pass@     -> refused: reverse-proxy Basic Auth is not supported in v1, and a password in state.json
 *                     would be a password on disk
 * @param {unknown} input
 * @returns {{ ok: true, origin: string, host: string, path: string, schemeAdded: boolean }
 *   | { ok: false, error: 'empty' | 'invalid' | 'scheme' | 'credentials' }}
 */
function normaliseOrigin(input) {
  const raw = str(input).trim();
  if (!raw) return { ok: false, error: 'empty' };
  if (raw.length > 2048 || /\s/.test(raw)) return { ok: false, error: 'invalid' };
  let s = raw;
  let schemeAdded = false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1] || '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // a full URL: its scheme is checked below
  } else if (/^https?$/i.test(scheme)) {
    return { ok: false, error: 'invalid' }; // `http:host` -- a typo, not a host called "http"
  } else if (NOT_WEB.test(scheme)) {
    return { ok: false, error: 'scheme' };
  } else {
    // `manga.example.com`, `192.168.1.10:8080`, `localhost:8080` (the regex reads "localhost" as a scheme).
    s = `https://${raw}`;
    schemeAdded = true;
  }
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'invalid' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'scheme' };
  if (u.username || u.password) return { ok: false, error: 'credentials' };
  if (!u.hostname) return { ok: false, error: 'invalid' };
  const path = `${u.pathname.replace(/\/+$/, '')}${u.search}`;
  return { ok: true, origin: u.origin, host: u.host, path, schemeAdded };
}

/**
 * Is this /auth/config answer an Uchiyomi SERVER? `serverName` and `oidc` exist on every server since v0.5.0
 * (bff/src/routes/auth.ts); `desktop: true` is only ever sent by a desktop-mode instance -- another copy of
 * this app, which a server-mode window must never be pointed at (its web app would wait for a desktop sign-in
 * that never comes).
 * @param {unknown} j
 * @returns {{ ok: true, name: string } | { ok: false, error: 'desktop' | 'not-uchiyomi' }}
 */
function checkConfig(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: 'not-uchiyomi' };
  const o = /** @type {Record<string, any>} */ (j);
  if (o.desktop === true) return { ok: false, error: 'desktop' };
  if (typeof o.serverName !== 'string' || !o.oidc || typeof o.oidc !== 'object') return { ok: false, error: 'not-uchiyomi' };
  // One line of text for a window title and a tray tooltip.
  const name = o.serverName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return { ok: true, name: name || 'Uchiyomi' };
}

/** Chromium's error name out of whatever net.fetch threw (`net::ERR_CONNECTION_REFUSED`, a timeout...). */
function netError(e) {
  const err = /** @type {any} */ (e);
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'ERR_TIMED_OUT';
  const text = `${str(err?.message)} ${str(err?.cause?.message)} ${str(err?.code)}`;
  return /\b(ERR_[A-Z0-9_]+)\b/.exec(text)?.[1] || '';
}

/** A certificate problem (the ask-once prompt can help), by Chromium error name. */
const isCertErrorName = (name) => /^ERR_CERT(IFICATE)?_/.test(str(name));
/** ... and by net error code (did-fail-load): Chromium's certificate errors are -200 .. -299. */
const isCertErrorCode = (code) => Number.isInteger(code) && code <= -200 && code > -300;

const MAX_HOPS = 10;
/** More than a /auth/config answer ever is; a portal's sign-in page is read no further than this. */
const MAX_BODY = 256 * 1024;

/**
 * GET `url` the way probeServer needs it: redirects followed one hop at a time, and the answer says where it
 * ENDED (`url`) and every address on the way (`hops`, the asked one first).
 * ⚠️ Electron 44's session.fetch / net.fetch follow redirects but answer `url: ''` and `redirected: false`
 * (seen in the real app), so the "final address" was always the one typed: a server behind a sign-in portal
 * read as "not an Uchiyomi server" and could not be added at all, and an http:// address that the server
 * upgrades to https:// was saved as http:// -- plain http at every launch. (net.fetch with redirect: 'manual'
 * never settled in the same test, so this is net.request.)
 * No cookies and no credentials ('omit': a proxy's 401 comes back AS a 401, never a login prompt), and only
 * http(s) hops: a redirect anywhere else is refused before it is followed.
 * @param {(o: { url: string, method: string, redirect: 'manual', credentials: 'omit', headers: Record<string, string> }) => any} request
 *   electron's net.request, bound to the probe's session by main.js
 * @param {string} url
 * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} [init]
 * @returns {Promise<{ url: string, hops: string[], status: number, ok: boolean, headers: { get: (k: string) => string | null }, text: () => Promise<string> }>}
 */
function hopFetch(request, url, init = {}) {
  return new Promise((resolve, reject) => {
    const hops = [url];
    let done = false;
    /** @type {any} */
    let req = null;
    const signal = init.signal;
    const finish = () => { done = true; signal?.removeEventListener('abort', onAbort); };
    /** @param {any} e */
    const fail = (e) => {
      if (done) return;
      finish();
      try { req?.abort(); } catch { /* already over */ }
      const err = /** @type {any} */ (new Error(str(e?.message) || String(e)));
      err.name = str(e?.name) || 'Error';
      err.url = hops[hops.length - 1]; // where it failed: a certificate refused on the 2nd hop is THAT host's
      reject(err);
    };
    const onAbort = () => fail(signal?.reason || new Error('aborted'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort);
    try {
      req = request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', headers: { ...(init.headers || {}) } });
    } catch (e) { fail(e); return; }
    req.on('redirect', (/** @type {number} */ _status, /** @type {string} */ _method, /** @type {string} */ to) => {
      if (done) return;
      let next;
      try { next = new URL(to, hops[hops.length - 1]); } catch { next = null; }
      if (!next || (next.protocol !== 'http:' && next.protocol !== 'https:')) { fail(new Error('net::ERR_UNSAFE_REDIRECT')); return; }
      hops.push(next.href);
      if (hops.length > MAX_HOPS + 1) { fail(new Error('net::ERR_TOO_MANY_REDIRECTS')); return; }
      req.followRedirect(); // synchronously, or Electron cancels the request
    });
    req.on('response', (/** @type {any} */ res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      const status = Number(res.statusCode) || 0;
      const h = res.headers || {};
      const answer = () => {
        if (done) return;
        finish();
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          url: hops[hops.length - 1], hops, status, ok: status >= 200 && status < 300,
          headers: { get: (k) => { const v = h[String(k).toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v); } },
          text: async () => body,
        });
      };
      res.on('data', (/** @type {Buffer} */ d) => {
        if (done) return;
        size += d.length;
        if (size <= MAX_BODY) chunks.push(d);
        else { try { req.abort(); } catch { /* over anyway */ } answer(); }
      });
      res.on('end', answer);
      res.on('error', fail);
    });
    req.on('error', fail);
    req.on('abort', () => fail(new Error('net::ERR_ABORTED')));
    req.end();
  });
}

/**
 * Is there an Uchiyomi server at what the person typed? GET <origin>/auth/config, redirects followed.
 *   ok             { origin, name }  -- the FINAL origin when a redirect only changed scheme/host/port
 *                                      (http -> https, a canonical host): that is where the server really is.
 *                                      A redirect adds `redirectedFrom` (the origin typed) and, when it went to
 *                                      another HOST, `newHost: true`: the page shows that address and waits for
 *                                      a click, so a plain-http answer cannot quietly re-home the app
 *   'cert'         Chromium does not trust the certificate (main.js adds the certificate it saw; `failedHost`
 *                  is the host of the hop that failed)
 *   'portal'       the address sent us somewhere else first (forward-auth sign-in, Authelia-style): the window
 *                  can follow that, so the page offers to continue with the SERVER's origin -- the last hop
 *                  that was still /auth/config (http -> https first, then the portal: the https one)
 *   'basic-auth'   a proxy's password prompt in front (not supported in v1: no `login` handler)
 *   'desktop' / 'not-uchiyomi' / 'http' / 'unreachable' / 'tls' / the normaliseOrigin errors
 * @param {unknown} input
 * @param {{ fetch: (url: string, init?: any) => Promise<any>, timeoutMs?: number }} o
 */
async function probeServer(input, o) {
  const n = normaliseOrigin(input);
  if (!n.ok) return n;
  const base = { origin: n.origin, host: n.host, path: n.path, schemeAdded: n.schemeAdded };
  const asked = `${n.origin}/auth/config`;
  let r;
  try {
    r = await o.fetch(asked, { headers: { accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(o.timeoutMs || 15_000) });
  } catch (e) {
    const code = netError(e);
    const error = isCertErrorName(code) ? 'cert' : /^ERR_(SSL|BAD_SSL)_/.test(code) ? 'tls' : 'unreachable';
    const failedHost = originHost(/** @type {any} */ (e)?.url);
    return { ok: false, ...base, error, detail: code || String(/** @type {any} */ (e)?.message || e).slice(0, 200), ...(failedHost ? { failedHost } : {}) };
  }
  /** @type {URL[]} every address on the way that parses, the asked one first */
  const chain = [];
  for (const u of Array.isArray(r.hops) && r.hops.length ? r.hops : [asked, str(r.url)]) {
    try { if (u) chain.push(new URL(u)); } catch { /* not an address */ }
  }
  if (!chain.length) chain.push(new URL(asked));
  const final = chain[chain.length - 1];
  /** @param {URL} u */
  const moved = (u) => (u.origin === n.origin ? {} : { redirectedFrom: n.origin, ...(pinHost(u.hostname) !== originHost(n.origin) ? { newHost: true } : {}) });
  if (final.pathname !== '/auth/config') {
    const server = [...chain].reverse().find((u) => u.pathname === '/auth/config') || new URL(asked);
    return { ok: false, ...base, origin: server.origin, host: server.host, ...moved(server), error: 'portal', portal: final.host };
  }
  const at = { ...base, origin: final.origin, host: final.host, ...moved(final) };
  if (r.status === 401 && /basic/i.test(str(r.headers?.get?.('www-authenticate')))) return { ok: false, ...at, error: 'basic-auth' };
  // A sign-in portal that ANSWERS instead of redirecting: forward-auth fronts (Authelia and the like) give a
  // request asking for JSON a 401 -- a 403 when a rule needs a sign-in first -- where a browser is sent to their
  // sign-in page. The window is a browser and can follow that, so this is a portal (`portal` empty: its address
  // is unknown). As an HTTP error it was a dead end: no Continue, no way to connect at all (V2 review).
  if (r.status === 401 || r.status === 403) return { ok: false, ...at, error: 'portal', portal: '', status: r.status };
  if (!r.ok) return { ok: false, ...at, error: r.status === 404 ? 'not-uchiyomi' : 'http', status: r.status };
  let j = null;
  try { j = JSON.parse(await r.text()); } catch { /* not JSON: not a server */ }
  const c = checkConfig(j);
  if (!c.ok) return { ok: false, ...at, error: /** @type {{ error: string }} */ (c).error };
  return { ok: true, ...at, name: c.name };
}

// ---------------------------------------------------------------- certificate pins
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
/** @param {unknown} f */
const isFingerprint = (f) => FINGERPRINT.test(str(f));
/** A host name as Chromium hands it to the verify proc; never an Object.prototype key. */
const isPinHost = (h) => typeof h === 'string' && h.length > 0 && h.length <= 253 && /^[a-z0-9._:[\]-]+$/i.test(h)
  && !['__proto__', 'constructor', 'prototype'].includes(h);

/**
 * SHA-256 of the certificate (DER), as `AB:CD:...` -- the form `openssl x509 -fingerprint -sha256` and browsers
 * print, so a person can compare it with their server's. Empty when it cannot be read (never pinnable then).
 * @param {{ data?: string, fingerprint?: string } | null | undefined} cert Electron's Certificate
 */
function fingerprintOf(cert) {
  try {
    if (cert?.data) return new crypto.X509Certificate(cert.data).fingerprint256.toUpperCase();
  } catch { /* fall through */ }
  // Electron's own field is `sha256/<base64>` of the same DER.
  const m = /^sha256\/([A-Za-z0-9+/=]+)$/.exec(str(cert?.fingerprint));
  if (m) {
    const hex = Buffer.from(m[1], 'base64').toString('hex').toUpperCase();
    if (hex.length === 64) return /** @type {string[]} */ (hex.match(/../g)).join(':');
  }
  return '';
}

/**
 * What the prompt shows about a certificate Chromium did not trust.
 * @param {string} host @param {any} cert Electron's Certificate
 */
function certSummary(host, cert) {
  const t = Number(cert?.validExpiry);
  return {
    host,
    fingerprint: fingerprintOf(cert),
    subject: str(cert?.subjectName).slice(0, 200),
    issuer: str(cert?.issuerName).slice(0, 200),
    validTo: Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : '',
  };
}

/** state.json's `certPins` ({ host: fingerprint }), whatever a hand edit left there. @param {any} s */
function pinsOf(s) {
  const p = s?.certPins;
  return p && typeof p === 'object' && !Array.isArray(p) ? /** @type {Record<string, string>} */ (p) : {};
}

/**
 * The pin of a server that was saved while this computer TRUSTED its certificate (a public CA, or one the OS
 * trusts): not a fingerprint, so no certificate ever equals it -- an untrusted certificate on that host is
 * 'changed' (the loud warning), where without it it was 'ask' (the friendly one-click prompt, V1 review S4:
 * someone in the middle with a self-signed certificate was one click from the server's cookies). A browser
 * shows a full-page warning there too. A certificate the computer trusts is still accepted on that host as
 * before (renewals). Only "Forget this server" removes it; "Trust the new certificate" never replaces it.
 */
const OS_PIN = 'os';

/**
 * Saving a server (main.js saveServer, after a probe that ANSWERED): the pins with OS_PIN for its host when it
 * is https and has no pin -- the probe got through with no pin, so this computer trusted the certificate. null
 * when nothing changes (http, or a pin the person set already).
 * @param {Record<string, string>} pins @param {string} origin
 * @returns {Record<string, string> | null}
 */
function serverPins(pins, origin) {
  let u;
  try { u = new URL(origin); } catch { return null; }
  const h = pinHost(u.hostname);
  if (u.protocol !== 'https:' || !isPinHost(h) || (own(pins, h) && str(pins[h]))) return null;
  /** @type {Record<string, string>} */
  const next = {};
  for (const [k, v] of Object.entries(pins || {})) if (isPinHost(k)) next[k] = str(v);
  next[h] = OS_PIN;
  return next;
}

/**
 * The certificate verify proc's decision (session.setCertificateVerifyProc, main.js). There is deliberately no
 * path that accepts a certificate Chromium refused without a stored pin that EQUALS it.
 *   'accept'   Chromium trusts it (a public CA, or one the OS trusts), or it is exactly the pinned one
 *   'ask'      untrusted and nothing pinned for this host: the prompt asks once
 *   'changed'  untrusted and the host HAS a pin that differs -- OS_PIN included: the loud warning, never a
 *              silent re-pin
 * @param {{ host: string, fingerprint: string, chromiumOk: boolean, pins: Record<string, string> }} o
 * @returns {'accept' | 'ask' | 'changed'}
 */
function certDecision({ host, fingerprint, chromiumOk, pins }) {
  if (chromiumOk) return 'accept';
  const h = pinHost(host);
  const pinned = own(pins, h) ? str(pins[h]) : '';
  if (!pinned) return 'ask';
  return isFingerprint(fingerprint) && fingerprint === pinned ? 'accept' : 'changed';
}

/**
 * "Trust this server": the new pins, or why not. Only the certificate the server is presenting RIGHT NOW, as
 * the shell's own verify proc saw it (`presented`) -- never a fingerprint the page made up -- and replacing a
 * different pin needs `replace`, which the page sends only from the changed-certificate warning's second click.
 * An OS_PIN is never replaced here (a server this computer trusted that turns self-signed is not a renewal):
 * the page offers no replace for it, and this refuses one anyway.
 * @param {{ pins: Record<string, string>, host: string, fingerprint: string, presented: { host: string, fingerprint: string } | null | undefined, replace?: boolean }} o
 * @returns {{ ok: true, pins: Record<string, string>, replaced: string } | { ok: false, error: 'invalid' | 'stale' | 'changed' }}
 */
function pinUpdate({ pins, host, fingerprint, presented, replace = false }) {
  const h = pinHost(host);
  if (!isPinHost(h) || !isFingerprint(fingerprint)) return { ok: false, error: 'invalid' };
  if (!presented || pinHost(presented.host) !== h || presented.fingerprint !== fingerprint) return { ok: false, error: 'stale' };
  const had = own(pins, h) ? str(pins[h]) : '';
  if (had === OS_PIN) return { ok: false, error: 'changed' };
  if (had && had !== fingerprint && !replace) return { ok: false, error: 'changed' };
  /** @type {Record<string, string>} */
  const next = {};
  for (const [k, v] of Object.entries(pins || {})) if (isPinHost(k) && k !== h) next[k] = str(v);
  next[h] = fingerprint;
  return { ok: true, pins: next, replaced: had && had !== fingerprint ? had : '' };
}

/**
 * A main-frame load failed in the server-mode window: 'check' asks the server's own origin which certificate it
 * presents (afterServerCheck), 'error' is the error page naming the host that failed.
 * ⚠️ Only a certificate error on the SERVER's name is ever a prompt. The window may go to any https origin
 * (sign-in round trips, a link) -- and offering "Trust this server" for whatever host failed pinned a
 * stranger's certificate in one click (V1 review S2h).
 * @param {{ code: number, host: string, serverHost: string }} o
 * @returns {'check' | 'error'}
 */
function loadFailedStep({ code, host, serverHost }) {
  return isCertErrorCode(code) && !!host && pinHost(host) === pinHost(serverHost) ? 'check' : 'error';
}

/**
 * What the window shows after the window's session refused a certificate for the server's NAME (or a main-frame
 * load there failed, `failed`), decided by a probe of the server's OWN origin -- never by the refusal itself:
 * the verify proc sees no port and no requester, so any request the page makes to that name counts (an <img>
 * from another service on another port put up the "certificate has changed" warning with THAT service's
 * certificate, and two clicks pinned it for the whole name -- V1 review S2g/S5).
 *   { step: 'cert' }   the server itself presents a certificate that is not trusted: the probe's own
 *   { step: 'error' }  a failed load, and the server's certificate is not the problem
 *   null               the server is fine: nothing to show (the page's request just failed)
 * @param {{ probe: any, failed?: { code: string, host: string } | null }} o
 */
function afterServerCheck({ probe, failed = null }) {
  if (probe && probe.error === 'cert' && probe.cert) return { step: 'cert', cert: probe.cert };
  if (failed) return { step: 'error', error: failed };
  return null;
}

/**
 * The certificate a probe that ended in 'cert' may offer to trust: only one the ASKED host presented (the
 * address typed, or the saved server's), never one met further along a redirect -- the prompt names the host it
 * pins, and "only your server's certificate is ever asked about" must hold for a plain-http answer that sends
 * the probe to a stranger's self-signed host too. The host where it failed otherwise, for the message.
 * @param {any} r probeServer's answer @param {(host: string) => any} seenFor this probe session's sightings
 * @returns {{ cert: any, host: string }}
 */
function promptableCert(r, seenFor) {
  const asked = originHost(r?.origin);
  const at = str(r?.failedHost) || asked;
  return { cert: at && at === asked ? seenFor(at) || null : null, host: at };
}

// ---------------------------------------------------------------- modes
/**
 * Which mode this launch starts in.
 *   state.mode 'server' + a valid origin     server (a broken entry asks again rather than guess)
 *   state.mode 'standalone'                  standalone
 *   no mode, but a libraryDir                standalone -- a v0.44.0 profile never sees the chooser
 *   --server-url (no mode saved yet)         server, after probing it (`probe`: CI's non-interactive choice)
 *   --library-dir (no mode saved yet)        standalone (CI's non-interactive first run, as in v0.44.0)
 *   otherwise (and state.mode 'choose')      the first-launch choice
 * A saved choice always wins over a flag, as an already chosen library does over --library-dir.
 * @param {{ state?: Record<string, any>, serverUrl?: string, libraryDir?: string }} o
 * @returns {{ mode: 'standalone' } | { mode: 'server', origin: string, name: string } | { mode: 'server', probe: string } | { mode: 'choose' }}
 */
function pickStartup({ state = {}, serverUrl = '', libraryDir = '' } = {}) {
  const s = state || {};
  if (s.mode === 'server') {
    const n = normaliseOrigin(s.serverOrigin);
    if (n.ok && n.origin === s.serverOrigin) return { mode: 'server', origin: n.origin, name: str(s.serverName).trim() || n.host };
    return { mode: 'choose' };
  }
  if (s.mode === 'standalone') return { mode: 'standalone' };
  // 'choose' is what "Forget this server" leaves: ask again even though a standalone library exists.
  if (s.mode !== 'choose' && str(s.libraryDir)) return { mode: 'standalone' };
  if (str(serverUrl)) return { mode: 'server', probe: str(serverUrl) };
  if (str(libraryDir)) return { mode: 'standalone' };
  return { mode: 'choose' };
}

/**
 * The origin the desktop bridge answers (bridge.js appOrigin). ⚠️ Only ever the local bff's, and only in
 * standalone: pointing it at a remote server would hand that server's page restore, engine install and
 * update install. Anything else is a port nothing listens on, so every desktop:* call is refused.
 * @param {{ mode: string, uiPort?: number }} o
 */
function appOriginFor({ mode, uiPort = 0 }) {
  return mode === 'standalone' && uiPort > 0 ? `http://127.0.0.1:${uiPort}` : 'http://127.0.0.1:0';
}

/**
 * May the window navigate to `url` itself ('allow'), hand it to the system browser ('external'), or neither?
 *   standalone  the local bff's origin and the shell's own pages; other web links -> the browser
 *   server      the server's origin AND any https origin -- SSO / forward-auth portals (Authelia, an OIDC
 *               provider) are same-window round trips, and there is no bridge to protect in this mode; the
 *               shell's pages only from a shell page (a web page never navigates the window to them)
 * @param {{ mode: string, url: string, own: string, current?: string, isShell: (url: string) => boolean }} o
 * @returns {'allow' | 'external' | 'block'}
 */
function navDecision({ mode, url, own: ownOrigin, current = '', isShell }) {
  let u;
  try { u = new URL(url); } catch { return 'block'; }
  if (u.protocol === 'file:') {
    if (!isShell(url)) return 'block';
    return mode === 'server' && !str(current).startsWith('file:') ? 'block' : 'allow';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'block';
  if (ownOrigin && u.origin === ownOrigin) return 'allow';
  if (mode === 'server' && u.protocol === 'https:') return 'allow';
  return 'external';
}

/**
 * "Forget this server": the state after it -- no server, no pin for its host, and the first-launch choice next
 * time. Everything standalone (libraryDir, ports, the database) is left exactly as it was.
 * @param {Record<string, any>} s @param {string} host
 */
function forgetServerState(s, host) {
  const pins = pinsOf(s);
  const h = pinHost(host);
  if (own(pins, h)) {
    const next = { ...pins };
    delete next[h];
    s.certPins = next;
  }
  delete s.serverOrigin;
  delete s.serverName;
  s.mode = 'choose';
  return s;
}

/**
 * The arguments a mode switch relaunches with: the saved state decides the mode from now on, so the one-shot
 * --server-url goes, and --hidden too (the login item's flag: a switch the person just asked for must show).
 * @param {string[]} argv process.argv
 */
function relaunchArgs(argv) {
  return argv.slice(1).filter((a) => a !== '--hidden' && !/^--server-url(=|$)/.test(a));
}

/**
 * "On this computer" (the first-launch choice) and "Use on this computer instead" (server mode): straight into
 * the library this computer already has ('resume'), or the library-folder page first when it has none
 * ('folder').
 * ⚠️ Never the folder page over an existing library: it offers the DEFAULT folder, and "Use this folder" then
 * re-pointed the existing database at an empty one ("Forget this server", then "On this computer" -- found
 * under Xvfb, V2 review). And never the mode before the folder: "Use on this computer instead" saved
 * 'standalone' with no library, which left a folder page with no way back and a tray whose way back to the
 * server stays disabled until a local library has started.
 * @param {Record<string, any> | null | undefined} s state.json
 * @returns {'resume' | 'folder'}
 */
function localStart(s) {
  return str(s?.libraryDir) ? 'resume' : 'folder';
}

/**
 * A server-mode load that failed with ERR_ABORTED (-3) was REPLACED, not refused: a newer navigation took its
 * place ("Switch server…" while the server was still loading, a second Switch right after Cancel). Treating it
 * as a failure put "Can't reach <server>" (detail "-3") over the address page the person had just asked for --
 * for a server that was fine (V2 review, 1 run in 3 under Xvfb). A certificate refusal is never -3 here: the
 * verify proc's -3 means "Chromium's own verdict", and the load then fails with that verdict's -2xx code.
 * @param {number} code did-fail-load's errorCode
 */
function loadWasReplaced(code) {
  return code === -3;
}

module.exports = {
  normaliseOrigin, checkConfig, probeServer, hopFetch, netError, isCertErrorName, isCertErrorCode,
  fingerprintOf, certSummary, pinsOf, certDecision, pinUpdate, isFingerprint, isPinHost, pinHost, originHost,
  OS_PIN, serverPins, loadFailedStep, afterServerCheck, promptableCert,
  pickStartup, appOriginFor, navDecision, forgetServerState, relaunchArgs, localStart, loadWasReplaced,
};
