// Full reload: rescan the pack (clears the registry) then re-add the always-on built-ins and the user's
// config sites. reloadSources() clears EVERYTHING, so built-ins + custom must be re-registered after it.
import { reloadSources } from './loader';
import { loadBuiltins } from './builtins';
import { loadCustomSites } from './customSites';

export function reloadAll(): { loaded: number; files: number } {
  const r = reloadSources(); // clears registry + rescans SOURCES_DIR (pack)
  loadBuiltins();
  loadCustomSites();
  return r;
}
