'use strict';
/**
 * The bff's entry point inside Electron's utilityProcess. The bff itself runs unchanged.
 *
 * Windows has no SIGTERM: `kill()` there is always an abrupt TerminateProcess, which would cut a chapter
 * download in half. The bff already knows how to stop well -- its SIGTERM handler finishes the current chapter
 * and exits, with a 20 s cap (bff/src/server.ts:543-549) -- so the shell sends a 'shutdown' message and this
 * shim turns it into that same signal.
 */
process.parentPort.on('message', (e) => {
  const m = e && e.data;
  if (m === 'shutdown' || (m && m.type === 'shutdown')) process.emit('SIGTERM');
});

/*
 * ⚠️ Tell the shell which port THIS process actually bound. Loopback TCP cannot say who is listening: another
 * account on the same PC can bind the UI port in the seconds between the shell's free-port check and the bff's
 * listen, answer /livez, and receive the per-launch sign-in secret the shell injects on /auth/desktop. Only our
 * own child can post on this parentPort, so the shell trusts the port -- sends the secret, loads the window,
 * answers the preload bridge -- only after this message names it. Every server this process opens reports
 * (only the bff lives here); the shell compares the port with the one it assigned.
 */
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const a = this.address();
    if (a && typeof a === 'object') process.parentPort.postMessage({ type: 'listening', port: a.port, address: a.address });
  });
  return listen.apply(this, args);
};

require(process.argv[2]);
