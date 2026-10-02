'use client';
// Extension repositories (v0.45.0, a sheet of its own since v0.53.0): where Admin → Extensions' catalogue comes from.
// Uchiyomi never hosts extensions: the catalogue is what the repositories the operator adds here list, and the
// engine does the fetching. Rarely touched once set, so it is a sheet behind Browse's Repositories key -- except on a
// first visit with none, when the form IS the next step and stands on Browse itself (RepoForm).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type ApiError } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { Sheet } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { Busy, busyKey } from '@/components/ExtensionBits';

/**
 * A refused "Add a repository" in the viewer's language.
 *
 * The server answers a stable `error` code with an English `message` (bff routes/admin.ts, the repos route);
 * the known codes are translated here, and the engine's own `reason` -- never translatable, and the most
 * useful words in the toast -- is appended as it came. An unknown code shows the server's message as it is.
 * ⚠️ Until v0.45.0 the add read neither: every refusal was "Could not add that repository".
 */
export function repoAddError(e: unknown): string {
  let j: { error?: string; reason?: string; removed?: boolean } = {};
  try { j = JSON.parse((e as ApiError)?.body || '{}'); } catch { /* not JSON: the generic line below */ }
  const said = j.reason ? ` ${tr('The engine said: {reason}', { reason: j.reason })}` : '';
  switch (j.error) {
    case 'bad_url': return tr('That doesn’t look like a repository address. It usually ends in index.min.json.');
    case 'github_page': return tr('That is a GitHub page, not the repository itself. Paste the repository’s index.min.json link instead.');
    case 'exists': return tr('That repository is already added.');
    case 'empty':
      return tr('That address gave no extensions, so it was not kept. Check that it is the repository’s index.min.json link, not a web page — or it may only list extensions you already have.')
        + said + (j.removed === false ? ` ${tr('It could not be taken back out — press Remove next to it.')}` : '');
    case 'engine_refused': return tr('The extension engine refused that address: {reason}', { reason: j.reason ?? '' });
    case 'unreachable': return tr('Could not reach the extension engine: {reason}', { reason: j.reason ?? '' });
    default: return msgOf(e, tr('Could not add that repository'));
  }
}

/** Everything a repository change can move: the list, the catalogue, what is installed, and the engine's counts. */
const REPO_KEYS = [['ext-repos'], ['ext-catalog'], ['ext-installed'], ['ext-status'], ['ext-sources']] as const;

/**
 * The address field and its Add. The server decides what a paste means (an Add-to-Mihon link, a missing https://, a
 * GitHub page) and keeps a repository only when it yielded extensions, so a 200 always carries `added` > 0: what THIS
 * repository brought, never the catalogue's size. The add can take a minute (the engine re-reads every repository, up
 * to four times, then tries the one alternative address): it says so while it waits. A refusal stays under the field
 * until the address is edited -- a toast lasts seconds, and its two sentences are needed while fixing the paste.
 */
export function RepoForm({ onAdded }: { onAdded?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [repoUrl, setRepoUrl] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const addRepo = async () => {
    if (!repoUrl.trim() || addingRepo) return;
    setAddingRepo(true);
    setRepoError(null);
    try {
      const r = await api<{ url: string; corrected: boolean; added: number }>('/api/admin/extensions/repos', { json: { url: repoUrl.trim() } });
      setRepoUrl('');
      for (const queryKey of REPO_KEYS) void qc.invalidateQueries({ queryKey: [...queryKey] });
      const file = r.url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? r.url;
      toast((r.added === 1 ? tr('Added — 1 extension from this repository') : tr('Added — {n} extensions from this repository', { n: r.added }))
        + (r.corrected ? ` · ${tr('saved as {file}', { file })}` : ''), 'success');
      onAdded?.();
    } catch (e: unknown) {
      const why = repoAddError(e);
      setRepoError(why);
      toast(why, 'error');
    }
    setAddingRepo(false);
  };
  return (
    <div className="space-y-2" data-repo-form>
      <div className="flex gap-2">
        <input value={repoUrl} onChange={(e) => { setRepoUrl(e.target.value); setRepoError(null); }} placeholder="https://…/index.min.json"
          onKeyDown={(e) => { if (e.key === 'Enter') void addRepo(); }}
          aria-label={tr('Repository address')} autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="url" dir="ltr"
          className="field min-w-0 max-w-none flex-1 font-mono text-[13px]" />
        <button type="button" onClick={() => void addRepo()} disabled={addingRepo || !repoUrl.trim()} className={`btn-key btn-key-primary h-auto self-stretch px-4 ${busyKey(addingRepo)}`}>
          {addingRepo ? <Busy tone="muted">{tr('Checking…')}</Busy> : tr('Add')}
        </button>
      </div>
      {addingRepo && (
        <p role="status" aria-live="polite" className="text-[12px] leading-relaxed text-fog-400">
          {tr('Checking the repository — this can take up to a minute.')}
        </p>
      )}
      {repoError && !addingRepo && (
        <p role="alert" className="text-[12px] leading-relaxed text-red-300">{repoError}</p>
      )}
      <p className="text-[12px] leading-relaxed text-fog-500">
        {tr('Paste the same address you added in Mihon ({path}); a repository’s “Add to Mihon” link works too.', { path: tr('More → Settings → Browse → Extension repos') })}
      </p>
    </div>
  );
}

/** The repositories: each address with its Remove, and the field to add another. */
export function ReposSheet({ repos, onClose }: { repos: string[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);
  const removeRepo = async (url: string) => {
    setRemoving(url);
    try {
      await api('/api/admin/extensions/repos', { method: 'DELETE', json: { url } });
      for (const queryKey of REPO_KEYS) void qc.invalidateQueries({ queryKey: [...queryKey] });
      toast(tr('Repository removed'), 'success');
    } catch (e: unknown) { toast(msgOf(e, tr('Could not remove it')), 'error'); }
    setRemoving(null);
  };
  return (
    <Sheet title={tr('Repositories')} onClose={onClose} overBottomNav>
      <div className="space-y-4 pb-3" data-repos-sheet>
        <p className="text-[12px] leading-relaxed text-fog-400">
          {tr('An extension repository is a list of extensions that someone publishes. Uchiyomi doesn’t host any, so you add one you trust.')}
        </p>
        {repos.length > 0 ? (
          <ul className="divide-y divide-ink-800/70 overflow-hidden rounded-2xl border border-ink-700/60 bg-ink-900/40">
            {repos.map((u) => (
              <li key={u} className="flex min-w-0 items-center gap-3 px-3 py-2.5" data-repo={u}>
                <span dir="ltr" className="min-w-0 flex-1 truncate text-start font-mono text-[12px] text-fog-300" title={u}>{u}</span>
                <button type="button" onClick={() => void removeRepo(u)} disabled={removing === u} className="btn-key btn-key-danger">
                  {removing === u ? <Busy tone="muted">{tr('Remove')}</Busy> : tr('Remove')}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fog-300">{tr('No extension repository yet — add one to see extensions')}</p>
        )}
        <RepoForm />
      </div>
    </Sheet>
  );
}
