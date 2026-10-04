// The walk's deliberate network cuts, as the console sees them (v0.55.1). run.mjs uses it; test/e2eNetworkCut.test.ts
// holds it to its rule.
//
// run.mjs holds the browser offline on purpose (page.setOfflineMode) to test offline reading, and inside such a cut a
// resource that cannot load is the condition under test: noted, not counted. But the console reports a failed request
// a moment after the browser raised it, so one that failed in the cut can arrive on either side of it -- before
// setOfflineMode(true) has answered, or after setOfflineMode(false) has. PR #152's CI counted one that way and went red
// on a green run: `/auth/refresh` failing with net::ERR_INTERNET_DISCONNECTED as the cold boot's cut ended, reported on
// the reader page after the walk had brought the network back.
//
// So for that one error the cut's window opens when the walk asks for the cut and closes CUT_DRAIN_MS after the
// network is back: nothing but the browser's own offline state raises it (127.0.0.1 is never disconnected). Inside the
// cut itself every `Failed to load resource` is noted, as it was. Nothing else is, at any time.

/** How long after the network is back a request the cut failed may still be reported. */
export const CUT_DRAIN_MS = 5000;
const DISCONNECTED = /net::ERR_INTERNET_DISCONNECTED/;

/** One walk's cuts, one after another. `now` is the clock, for the tests. */
export function networkCuts(now = () => Date.now()) {
  let on = false;
  let from = Infinity;
  let to = -Infinity;
  return {
    /** The walk is about to cut the network: before page.setOfflineMode(true). */
    asking() { from = now(); to = Infinity; },
    /** The browser is offline: after page.setOfflineMode(true) answered. */
    cut() { on = true; },
    /** The network is back: after page.setOfflineMode(false) answered. The window closes CUT_DRAIN_MS later. */
    back() { on = false; to = now() + CUT_DRAIN_MS; },
    /** Whether the browser is being held offline right now. */
    get on() { return on; },
    /** Whether a console error's text is the cut's own doing: noted, not counted. */
    noted(text) {
      if (on && /Failed to load resource/.test(text)) return true;
      const t = now();
      return t >= from && t <= to && DISCONNECTED.test(text);
    },
  };
}
