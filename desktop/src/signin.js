// @ts-check
'use strict';
/**
 * The window signs in without a sign-in screen (contract 2).
 *
 * Each launch makes a fresh 256-bit secret. The bff gets it in its environment (UCHIYOMI_DESKTOP_SECRET, which
 * its desktop.ts reads once and deletes from process.env), and the window's session adds it as the header
 * `X-Uchiyomi-Desktop` -- below the page, in the main process -- to exactly one request:
 * `POST http://127.0.0.1:<ui port>/auth/desktop`. The bff answers that like a password sign-in (the same body,
 * the `yomi_rt` + `yomi_img` cookies), so every other route, the image cookie and refresh work unchanged.
 *
 * Page JavaScript never sees the secret: it is not in the preload bridge, not in a cookie, not in the page's
 * environment. A browser tab pointed at 127.0.0.1 has its own cookie store and no header, so it gets nothing.
 * The secret is not written to disk either; it dies with the process.
 */
const crypto = require('node:crypto');

const HEADER = 'X-Uchiyomi-Desktop';

/** 32 random bytes, base64url: 43 characters (the bff requires at least 32). */
function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Is this THE exchange request? Exact method, scheme, host, port and path -- no prefix match, no query string,
 * no `localhost` alias. Anything looser would hand the secret to a request the page can steer elsewhere.
 * @param {{ method: string, url: string }} details
 * @param {number} port
 */
function isExchange(details, port) {
  return details.method === 'POST' && details.url === `http://127.0.0.1:${port}/auth/desktop`;
}

/**
 * The request headers to send: the secret on the exchange, and on every other request the header REMOVED
 * whatever the page put there (it cannot know the value, but nothing but the shell speaks this header).
 * @param {{ method: string, url: string, requestHeaders: Record<string, string> }} details
 * @param {number} port
 * @param {string} secret
 */
function headersFor(details, port, secret) {
  const h = { ...details.requestHeaders };
  for (const k of Object.keys(h)) if (k.toLowerCase() === HEADER.toLowerCase()) delete h[k];
  if (port > 0 && secret && isExchange(details, port)) h[HEADER] = secret;
  return h;
}

/**
 * Install the header hook on the window's session. ⚠️ A session has ONE onBeforeSendHeaders listener; this
 * is it for the default session (the solver's windows use their own partitions and their own listener).
 * @param {Electron.Session} ses
 * @param {() => number} port  the UI port, read at request time (it is chosen during start-up)
 * @param {string} secret
 */
function installSignIn(ses, port, secret) {
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    cb({ requestHeaders: headersFor(/** @type {any} */ (details), port(), secret) });
  });
}

/**
 * The main process's own session for its own calls (the tray's "Check for new chapters"): the same exchange,
 * from Node, keeping the access token for most of its 15-minute life so a burst of clicks is one sign-in.
 */
class ShellSession {
  /** @param {() => number} port @param {string} secret */
  constructor(port, secret) {
    this.port = port;
    this.secret = secret;
    this.token = '';
    this.until = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.until) return this.token;
    const r = await fetch(`http://127.0.0.1:${this.port()}/auth/desktop`, { method: 'POST', headers: { [HEADER]: this.secret }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`the server refused the app's own sign-in (${r.status})`);
    const j = /** @type {any} */ (await r.json());
    if (!j?.accessToken) throw new Error('the server answered the sign-in without a token');
    this.token = j.accessToken;
    this.until = Date.now() + 10 * 60_000;
    return this.token;
  }

  /** @param {string} path @param {RequestInit} [init] */
  async fetch(path, init = {}) {
    const go = async () => fetch(`http://127.0.0.1:${this.port()}${path}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(30_000) });
    let r = await go();
    // The bff restarted (a new JWT secret after a restore, or the token simply expired): sign in once more.
    if (r.status === 401) { this.token = ''; r = await go(); }
    return r;
  }
}

module.exports = { HEADER, newSecret, isExchange, headersFor, installSignIn, ShellSession };
