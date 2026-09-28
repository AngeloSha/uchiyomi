// The extension engine's state, in the four words the admin pages and Health speak (#72).
//
// Kept apart from client.ts on purpose: the client is the transport every engine call goes through, and this is
// only what the pages SAY about the engine -- read from the switch, the address and the last registration,
// never from a request of its own. Nothing here talks to the engine.
import { env } from '../../../env';
import { engineSwitchedOff, suwayomiBase, suwayomiConfigured } from './client';
import { lastSuwayomiLoad } from './register';

/** Why there is no engine to talk to: EXTENSION_ENGINE=0 on the bundled one, or no address at all. */
export type EngineOffReason = 'switch' | 'unset';

/**
 * - `off`: no address (SUWAYOMI_URL empty: CasaOS and Unraid until the engine is added, or turned off by hand);
 * - `switched_off`: EXTENSION_ENGINE=0 with the bundled address;
 * - `unreachable`: set up, and the last registration found nobody there (or none has run yet);
 * - `up`: the last registration reached it.
 */
export type EngineState = 'off' | 'switched_off' | 'unreachable' | 'up';

/**
 * Null while there is an engine to talk to -- the same test as suwayomiConfigured, which is the one the routes
 * and registration use, so the page can never say "off" about an engine that is being called. The raw inputs are
 * parameters for the tests, as in client.ts.
 */
export function engineOffReason(raw: string | undefined = env.SUWAYOMI_URL, on: boolean = env.EXTENSION_ENGINE): EngineOffReason | null {
  if (engineSwitchedOff(raw, on)) return 'switch';
  return raw ? null : 'unset';
}

/**
 * The engine's host and port as the status route shows it ("uchiyomi-suwayomi:4567"), or '' when there is none.
 * Taken from the normalised base, so the userinfo an address may carry is never shown.
 */
export function engineHost(raw: string | undefined = env.SUWAYOMI_URL): string {
  const base = suwayomiBase(raw);
  if (!base) return '';
  try {
    return new URL(base).host;
  } catch {
    return '';
  }
}

/**
 * The engine's state from what is already known: the switch, the address and the last registration.
 *
 * ⚠️ From the REGISTRATION, not a live probe, and that is what the callers need: frozenSeries asks why an
 * extension series has no adapter, and an adapter exists exactly when a registration reached the engine. An
 * engine that went away after registering leaves its adapters in place (they fail per request, and come back by
 * themselves), so for that question it is still `up`.
 */
export function engineState(): EngineState {
  if (!suwayomiConfigured()) return engineOffReason() === 'switch' ? 'switched_off' : 'off';
  return lastSuwayomiLoad()?.reachable ? 'up' : 'unreachable';
}
