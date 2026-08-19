// Full reload: rescan the pack (clears the registry) then re-add the always-on built-ins, the user's config
// sites, and the enabled Suwayomi extension sources. reloadSources() clears EVERYTHING, so all three must be
// re-registered after it.
//
// Async because the Suwayomi sources have to be fetched from that server; it fails soft, so a reload still
// succeeds (and still re-registers everything else) when the extension server is down.
import { reloadSources } from './loader';
import { loadBuiltins } from './builtins';
import { loadCustomSites } from './customSites';
import { loadSuwayomiSources } from './suwayomi/register';

export async function reloadAll(): Promise<{ loaded: number; files: number; suwayomi: number }> {
  const r = reloadSources(); // clears registry + rescans SOURCES_DIR (pack)
  loadBuiltins();
  loadCustomSites();
  const sw = await loadSuwayomiSources().catch(() => ({ registered: 0 }));
  return { ...r, suwayomi: sw.registered };
}
