// @ts-check
'use strict';
/**
 * The shell's Cloudflare solver: a FlareSolverr-v1-compatible HTTP API on 127.0.0.1 behind a per-launch secret
 * path segment, answered by hidden Electron windows (src/solver/*.ts, compiled to out/ by `npm run build`).
 * Neither the bff nor the extension engine changes: both get FLARESOLVERR_URL = http://127.0.0.1:<port>/<token>.
 *
 * The User-Agent is set ONCE for the whole process, before any session exists (setUserAgent, called at the top
 * of main.js): a per-session UA leaked the native one on the challenge frame's own requests (sim#8192), and
 * Cloudflare ties cf_clearance to the UA it saw. Mode B, "chrome", is the default: Electron's UA minus the
 * `Uchiyomi/x` and `Electron/y` tokens, so the app does not announce itself to every manga site. It tied with
 * the native UA (A) on every measure in the spike (13/16 each; S4 12/12 each); A stays a setting
 * (state.json `solverUserAgent: "native"`) in case a site ever prefers it.
 *
 * Escape hatch (spike recommendation): state.json `flaresolverrUrl` points both clients at an external
 * FlareSolverr instead, and this solver is not started at all.
 */
const path = require('node:path');
const crypto = require('node:crypto');

/** @param {import('electron').App} app @param {string | undefined} mode */
function setUserAgent(app, mode) {
  const { parseUaMode, userAgentFor } = require(path.join(__dirname, '..', 'out', 'src', 'solver', 'userAgent.js'));
  const m = parseUaMode(mode, 'chrome');
  const native = app.userAgentFallback;
  app.userAgentFallback = userAgentFor(m, native);
  return { mode: m, userAgent: app.userAgentFallback };
}

/**
 * @param {{
 *   version: string,
 *   log: { info: Function, warn: Function, error: Function },
 *   onNeedsHuman?: (host: string) => void,
 * }} o
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, stats: () => any }>}
 */
async function startSolver(o) {
  const { startSolverServer } = require(path.join(__dirname, '..', 'out', 'src', 'solver', 'server.js'));
  const { ElectronSolverBackend } = require(path.join(__dirname, '..', 'out', 'src', 'solver', 'browser.js'));
  const backend = new ElectronSolverBackend({
    humanCheck: 'show',
    onNeedsHuman: o.onNeedsHuman,
    log: (event, data) => {
      // One line per notable event; the per-press chatter stays out of the log.
      if (event !== 'verify-input' && event !== 'client-hints') o.log.info(`solver: ${event}`, data);
    },
  });
  // 128 bits in the path. The token only has to be unguessable by a web page; it is not a credential on disk.
  const token = crypto.randomBytes(16).toString('hex');
  const srv = await startSolverServer({
    backend,
    token,
    appVersion: o.version,
    onEvent: (/** @type {any} */ e) => {
      if (e.type === 'solve-end') {
        o.log[e.ok ? 'info' : 'warn'](`solver: ${e.ok ? 'solved' : 'failed'} #${e.id} in ${e.ms} ms`, e.ok ? { origin: e.originStatus, challenged: e.challenged } : { error: e.error });
      } else if (e.type === 'rejected') {
        o.log.warn('solver: rejected a request', { status: e.status, reason: e.reason });
      }
    },
  });
  o.log.info('solver: listening', { port: srv.port });
  return {
    url: srv.url,
    port: srv.port,
    stats: () => backend.stats(),
    close: async () => { await srv.close(); await backend.shutdown(); },
  };
}

module.exports = { startSolver, setUserAgent };
