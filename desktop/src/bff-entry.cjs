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
require(process.argv[2]);
