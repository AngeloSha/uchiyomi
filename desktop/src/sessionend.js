// @ts-check
'use strict';
/**
 * Windows ending the session -- shut down, restart, sign out -- with Uchiyomi running in the tray.
 *
 * ⚠️ Electron does NOT emit before-quit then ("On Windows, this event will not be emitted if the app is closed due
 * to a shutdown/restart of the system or a user logout", electron.d.ts), and a tray app is usually closed exactly
 * that way. Until v0.44.0's review nothing listened for it, so Windows simply terminated the app: postgres killed
 * instead of fast-stopped (WAL crash recovery on the next boot), the engine's last H2 write lost, the refresh
 * cookie the bff had just rotated never flushed. So, on the main window:
 *
 *   query-session-end  Windows asks first. Hold it (preventDefault: "Uchiyomi is preventing shutdown" shows for
 *                      the second or so the ordered stop takes -- 0.6 s measured on Linux), run the same quit() as
 *                      the tray's Quit, which ends in app.exit(); Windows carries on by itself once we are gone.
 *   session-end        Windows is ending the session regardless (someone chose "Shut down anyway", or a forced
 *                      restart). If the ordered stop has not finished, fast-stop postgres SYNCHRONOUSLY: the event
 *                      loop may never get another turn, and a clean postgres is the part worth the last second.
 *
 * A downloaded update is NOT installed on the way out (updates.js installOnQuit: 'session-end' is not a reason to):
 * an installer started while Windows tears the session down can be killed half-way, leaving a broken app. It
 * installs on the next Quit instead; electron-updater keeps the download.
 * @param {{ on: (event: string, cb: (e: { preventDefault: () => void }) => void) => unknown }} win
 * @param {{
 *   log: { info: Function, warn: Function, error: Function },
 *   quit: (reason: string) => unknown,
 *   stopped: () => boolean,          // has the ordered stop finished?
 *   stopPostgresNow: () => unknown,  // synchronous
 * }} o
 */
function installSessionEnd(win, o) {
  win.on('query-session-end', (e) => {
    e.preventDefault();
    o.log.info('session end: Windows asked to end the session; stopping everything in order first');
    void o.quit('session-end');
  });
  win.on('session-end', () => {
    if (o.stopped()) return;
    o.log.warn('session end: Windows is ending the session before the ordered stop finished; stopping postgres now');
    try {
      o.log.info('session end: postgres', { result: o.stopPostgresNow() });
    } catch (e) {
      o.log.error('session end: could not stop postgres', { error: String(e) });
    }
  });
}

module.exports = { installSessionEnd };
