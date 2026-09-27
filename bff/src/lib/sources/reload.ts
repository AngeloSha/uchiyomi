// Full reload: rescan the pack (clears the registry) then re-add the always-on built-ins, the user's config
// sites, and the enabled Suwayomi extension sources. reloadSources() clears EVERYTHING, so all three must be
// re-registered after it.
//
// Async because the Suwayomi sources have to be fetched from that server; it fails soft, so a reload still
// succeeds (and still re-registers everything else) when the extension server is down.
import { reloadSources } from './loader';
import { loadBuiltins } from './builtins';
import { loadCustomSites } from './customSites';
import { loadSuwayomiSources, scheduleSuwayomiRetry } from './suwayomi/register';

export async function reloadAll(): Promise<{ loaded: number; files: number; suwayomi: number }> {
  const r = reloadSources(); // clears registry + rescans SOURCES_DIR (pack)
  loadBuiltins();
  loadCustomSites();
  const sw = await loadSuwayomiSources().catch(() => null);
  // ⚠️ The registry was just cleared, so an engine that is down right now takes every extension source with
  // it -- and before v0.49.0 nothing registered them again when it came back: a reload during an outage lost
  // them until someone reloaded by hand. The same retry the boot starts brings them back (#72); it is one loop,
  // so a reload while it already runs changes nothing.
  if (sw?.configured && !sw.reachable) scheduleSuwayomiRetry();
  return { ...r, suwayomi: sw?.registered ?? 0 };
}
