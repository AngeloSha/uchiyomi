// @ts-check
'use strict';
/**
 * Ports are chosen ONCE and persisted.
 *
 * The UI port is the web origin, and the origin is what cookies, IndexedDB and the service worker cache are
 * keyed on -- a new port is a signed-out user with no offline data. The engine port (Phase 2) is baked into
 * stored cover URLs. So a port only changes when something else has taken it, and the change is logged.
 */
const net = require('node:net');

/** @returns {Promise<boolean>} */
function canBind(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/** @returns {Promise<number>} */
function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen({ port: 0, host, exclusive: true }, () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Make sure `state[key]` holds a port we can bind right now.
 * @returns {Promise<{ port: number, changedFrom: number | null }>}
 */
async function ensurePort(state, key) {
  const old = Number(state[key]) || 0;
  if (old && (await canBind(old))) return { port: old, changedFrom: null };
  const port = await freePort();
  state[key] = port;
  return { port, changedFrom: old || null };
}

module.exports = { canBind, freePort, ensurePort };
