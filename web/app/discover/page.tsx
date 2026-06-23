'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { IcSearch, IcSparkle } from '@/components/icons';

interface SourceResult { sourceId: string; source: string; title: string; coverUrl?: string; inLibrary?: boolean }
interface Job { folder: string; title: string; total: number; done: number; status: string }
interface Trending { title: string; cover: string | null; description: string; genres: string[]; score: number | null; chapters: number | null; status: string | null }
interface Provider { source: string; name: string; sourceId: string; title: string; coverUrl?: string }
interface Detail { source: string; sourceId: string; title: string; summary: string; coverUrl: string | null; genres: string[]; status: string; count: number; first: number | null; last: number | null }
interface AddModal { title: string; fallbackDesc?: string; providers?: Provider[]; picked?: Provider; detail?: Detail; loading: boolean; count: number; autoUpdate: boolean; adding: boolean; dup?: string }

const cover = (source: string | undefined, u?: string | null) => (u ? `/img/sources/cover?${source ? `source=${source}&` : ''}u=${encodeURIComponent(u)}` : '');
// never render a swept-up <style>/<script> block as a description (defensive — the BFF also guards this)
const looksCss = (s: string) => s.length > 2500 || /<\/?(?:style|script)\b|\.[a-z][\w-]*\s*[{,]|@import|gtag\(|wp-manga|woocommerce|settings-page|datalayer/i.test(s);

export default function DiscoverPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: () => api<{ content: { id: string; name: string; status?: string }[] }>('/api/sources'), refetchInterval: 30000 });
  // Always pull fresh trending when Discover is opened or refocused (installed PWAs have no manual refresh,
  // and a stale/empty cached result must never get pinned for the session).
  const { data: trending } = useQuery({
    queryKey: ['trending'],
    queryFn: () => api<{ content: Trending[] }>('/api/discover/trending'),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const [source, setSource] = useState('mangadex');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SourceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [modal, setModal] = useState<AddModal | null>(null);
  const { data: jobs } = useQuery({ queryKey: ['source-jobs'], queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'), refetchInterval: 4000 });

  const search = async (e?: React.FormEvent, query?: string) => {
    e?.preventDefault();
    const term = (query ?? q).trim();
    if (!term) return;
    setSearching(true);
    setResults([]);
    try {
      const r = await api<{ content: SourceResult[] }>(`/api/sources/search?source=${source}&q=${encodeURIComponent(term)}`);
      setResults(r.content);
    } catch { toast('Search failed', 'error'); } finally { setSearching(false); }
  };

  const patch = (p: Partial<AddModal>) => setModal((m) => (m ? { ...m, ...p } : m));

  const loadDetail = async (pk: Provider) => {
    try {
      const d = await api<Detail>(`/api/sources/detail?source=${pk.source}&sourceId=${encodeURIComponent(pk.sourceId)}`);
      setModal((m) => (m ? { ...m, detail: d, loading: false } : m));
    } catch { setModal((m) => (m ? { ...m, loading: false } : m)); }
  };

  // Trending → find across providers (Aqua first), then choose one
  const openTrending = async (t: Trending) => {
    setModal({ title: t.title, fallbackDesc: t.description, loading: true, count: 0, autoUpdate: true, adding: false });
    try {
      const r = await api<{ content: Provider[] }>(`/api/sources/find?q=${encodeURIComponent(t.title)}`);
      setModal((m) => (m && m.title === t.title ? { ...m, providers: r.content, loading: false } : m));
    } catch { setModal((m) => (m ? { ...m, providers: [], loading: false } : m)); }
  };

  // Search result → straight to the detail/options step (source already chosen)
  const openResult = (r: SourceResult) => {
    const pk: Provider = { source: r.source, name: '', sourceId: r.sourceId, title: r.title, coverUrl: r.coverUrl };
    setModal({ title: r.title, picked: pk, loading: true, count: 0, autoUpdate: true, adding: false });
    loadDetail(pk);
  };

  const pickProvider = (p: Provider) => { setModal((m) => (m ? { ...m, picked: p, loading: true } : m)); loadDetail(p); };

  const doAdd = async (force = false) => {
    if (!modal?.picked) return;
    patch({ adding: true, dup: undefined });
    try {
      const res = await api<{ title: string; chapters: number }>('/api/sources/add', {
        json: { source: modal.picked.source, sourceId: modal.picked.sourceId, chapterCount: modal.count || undefined, autoUpdate: modal.autoUpdate, force },
      });
      toast(`Adding “${res.title}” — downloading ${res.chapters} chapter${res.chapters === 1 ? '' : 's'}`, 'success');
      qc.invalidateQueries({ queryKey: ['source-jobs'] });
      setModal(null);
    } catch (e: any) {
      let parsed: any = {};
      try { parsed = JSON.parse(e?.body || '{}'); } catch {}
      if (parsed.error === 'duplicate') patch({ adding: false, dup: parsed.message || 'You already have this title.' });
      else { toast(parsed.message || 'Add failed — try another source', 'error'); patch({ adding: false }); }
    }
  };

  const activeJobs = (jobs?.content || []).filter((j) => j.status === 'downloading');
  const recs = (trending?.content || []).slice(0, 18);
  const presets = (n: number) => [10, 25, 50, 100, 200].filter((x) => x < n);

  return (
    <div className="min-h-screen-d">
      <header className="safe-top px-5 pb-3 lg:static lg:px-0 lg:pt-4">
        <h1 className="font-display text-2xl font-bold lg:text-3xl">Discover</h1>
        <p className="text-sm text-fog-400">Search your sources and add new series to the library.</p>
      </header>

      <div className="px-4 lg:px-0">
        {sources && sources.content.length === 0 ? (
          <div className="glass rounded-2xl p-6 text-center">
            <p className="font-display text-lg font-semibold text-fog-100">No sources installed</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-fog-400">
              Yomi reads the library you already own. To search and add new series, mount a source pack at{' '}
              <code className="rounded bg-ink-800 px-1.5 py-0.5 text-[12px]">SOURCES_DIR</code> and reload it from Admin → Providers.
            </p>
          </div>
        ) : (
          <form onSubmit={search} className="flex flex-wrap gap-2">
            <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-sm text-fog-100 outline-none focus:border-accent">
              {(sources?.content || []).map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'blocked' ? ' ⛔ blocked' : s.status === 'rate_limited' ? ' ⚠ rate-limited' : s.status === 'disabled' ? ' (off)' : ''}</option>)}
            </select>
            <div className="flex min-w-[180px] flex-1 items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 focus-within:border-accent">
              <IcSearch width={18} height={18} className="text-fog-500" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a title…" className="w-full bg-transparent py-2.5 text-sm text-fog-50 outline-none placeholder:text-fog-500" />
            </div>
            <button className="btn-accent px-6">Search</button>
          </form>
        )}

        {activeJobs.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-fog-500">Downloading</p>
            {activeJobs.map((j) => (
              <div key={j.folder} className="glass rounded-xl px-4 py-2.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate text-fog-100">{j.title}</span>
                  <span className="shrink-0 pl-3 text-fog-400">{j.done}/{j.total}</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-700">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round((j.done / Math.max(1, j.total)) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Trending recommendations — shown until the user runs a search */}
        {!searching && results.length === 0 && recs.length > 0 && (
          <section className="mt-6">
            <div className="mb-3 flex items-center gap-2">
              <IcSparkle width={18} height={18} className="text-accent" />
              <h2 className="font-display text-lg font-semibold">Trending manhwa</h2>
              <span className="text-xs text-fog-500">not in your library</span>
            </div>
            <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {recs.map((t) => (
                <button key={t.title} onClick={() => openTrending(t)} className="group w-36 shrink-0 snap-start text-left">
                  <div className="relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 bg-ink-800">
                    {t.cover ? (
                      // Serve SAME-ORIGIN (proxy) — reliable in standalone iOS PWA where cross-origin imgs are flaky;
                      // fall back to AniList's CDN directly only if the proxy errors.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={cover(undefined, t.cover)}
                        alt={t.title}
                        referrerPolicy="no-referrer"
                        onError={(e) => { const el = e.currentTarget; if (el.dataset.fb !== '1' && t.cover) { el.dataset.fb = '1'; el.src = t.cover; } }}
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
                      />
                    ) : <div className="grid h-full place-items-center text-ink-500"><IcSparkle width={24} height={24} /></div>}
                    {t.score != null && <span className="absolute right-1.5 top-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-accent backdrop-blur">{t.score}%</span>}
                    {t.chapters != null && <span className="absolute left-1.5 top-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-medium text-fog-200 backdrop-blur">{t.chapters} ch</span>}
                    <span className="absolute inset-x-0 bottom-0 bg-accent/90 py-1.5 text-center text-[11px] font-semibold text-white opacity-0 backdrop-blur transition group-hover:opacity-100">Find &amp; add</span>
                  </div>
                  <p className="mt-1.5 line-clamp-1 text-xs font-medium text-fog-100">{t.title}</p>
                  {t.description && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fog-400">{t.description}</p>}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="mt-5 grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-9">
          {searching && Array.from({ length: 12 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)}
          {!searching && results.map((r) => (
            <div key={r.sourceId} className="group">
              <div className={`relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 bg-ink-800 ${r.inLibrary ? 'opacity-55' : ''}`}>
                {r.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={cover(r.source, r.coverUrl)} alt={r.title} loading="lazy" className="h-full w-full object-cover" />
                ) : <div className="grid h-full place-items-center text-ink-500"><IcSparkle width={28} height={28} /></div>}
                {r.inLibrary ? (
                  <span className="absolute inset-x-0 bottom-0 bg-emerald-600/85 py-2 text-center text-xs font-semibold text-white backdrop-blur">✓ In library</span>
                ) : (
                  <button onClick={() => openResult(r)} className="absolute inset-x-0 bottom-0 bg-accent/90 py-2 text-xs font-semibold text-white opacity-0 backdrop-blur transition group-hover:opacity-100">+ Add to library</button>
                )}
              </div>
              <p className="mt-1.5 line-clamp-2 text-xs text-fog-200">{r.title}</p>
            </div>
          ))}
        </div>

        {!searching && q && results.length === 0 && (
          <p className="py-16 text-center text-sm text-fog-500">No results — try another source or title.</p>
        )}
      </div>

      {modal && <AddDialog modal={modal} patch={patch} close={() => setModal(null)} pickProvider={pickProvider} doAdd={doAdd} presets={presets} />}
    </div>
  );
}

function AddDialog({ modal, patch, close, pickProvider, doAdd, presets }: {
  modal: AddModal; patch: (p: Partial<AddModal>) => void; close: () => void;
  pickProvider: (p: Provider) => void; doAdd: (force?: boolean) => void; presets: (n: number) => number[];
}) {
  const d = modal.detail;
  const srcSum = d?.summary && !looksCss(d.summary) ? d.summary : '';
  const desc = (srcSum.length > 30 ? srcSum : '') || modal.fallbackDesc || srcSum || '';
  const chooseProvider = modal.providers && !modal.picked;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" onClick={close}>
      <div className="glass max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-ink-700 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold leading-tight">{modal.title}</h3>
          <button onClick={close} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>

        {modal.loading && (
          <div className="flex items-center gap-3 py-8 text-sm text-fog-400">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
            {chooseProvider ? 'Searching providers…' : modal.providers ? 'Loading chapters…' : 'Finding sources…'}
          </div>
        )}

        {/* Step 1: choose a provider (trending flow) */}
        {!modal.loading && chooseProvider && (
          modal.providers!.length === 0 ? (
            <p className="py-8 text-center text-sm text-fog-500">Not found on any source yet — try searching manually.</p>
          ) : (
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">Available on — pick a source</p>
              <div className="space-y-2">
                {modal.providers!.map((p, i) => (
                  <button key={p.source} onClick={() => pickProvider(p)} className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850/60 p-2 text-left transition hover:border-accent">
                    {p.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={cover(p.source, p.coverUrl)} alt="" className="h-12 w-9 shrink-0 rounded-md object-cover" />
                    ) : <div className="h-12 w-9 shrink-0 rounded-md bg-ink-800" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-fog-100">{p.name}{i === 0 && <span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">preferred</span>}</p>
                      <p className="truncate text-xs text-fog-500">{p.title}</p>
                    </div>
                    <span className="shrink-0 text-fog-500">›</span>
                  </button>
                ))}
              </div>
            </div>
          )
        )}

        {/* Step 2: options */}
        {!modal.loading && d && (
          <div className="mt-4 space-y-4">
            {modal.providers && (
              <button onClick={() => patch({ picked: undefined, detail: undefined })} className="text-xs text-accent hover:underline">‹ change source ({modal.picked?.name})</button>
            )}
            <div className="flex gap-3">
              {d.coverUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={cover(d.source, d.coverUrl)} alt="" className="h-28 w-20 shrink-0 rounded-lg border border-ink-700 object-cover" />
              )}
              <div className="min-w-0 text-xs text-fog-300">
                <p className="font-semibold text-fog-100">{d.count} chapter{d.count === 1 ? '' : 's'}{d.first != null && d.last != null ? ` · ${d.first}–${d.last}` : ''}</p>
                {d.status && !looksCss(d.status) && <p className="mt-0.5 text-fog-500">{d.status}</p>}
                {d.genres?.length > 0 && <p className="mt-0.5 line-clamp-1 text-fog-500">{d.genres.slice(0, 4).join(' · ')}</p>}
              </div>
            </div>
            {desc && <p className="max-h-20 overflow-y-auto pr-1 text-[13px] leading-relaxed text-fog-300">{desc}</p>}

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">Chapters to download</span>
              <select value={modal.count} onChange={(e) => patch({ count: Number(e.target.value) })} className="w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-sm text-fog-100 outline-none focus:border-accent">
                <option value={0}>All ({d.count})</option>
                {presets(d.count).map((n) => <option key={n} value={n}>First {n}</option>)}
              </select>
            </label>

            {(modal.count === 0 ? d.count : modal.count) > 40 && (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-300">⚠ Grabbing many chapters quickly can get you temporarily rate-limited by this source. It pauses automatically if that happens — you can resume later, or download fewer to start.</p>
            )}

            <button onClick={() => patch({ autoUpdate: !modal.autoUpdate })} className="flex w-full items-center justify-between rounded-xl border border-ink-700 bg-ink-850/60 px-3 py-2.5 text-left">
              <span className="text-sm text-fog-100">Auto-update new chapters</span>
              <span className={`relative h-6 w-11 rounded-full transition ${modal.autoUpdate ? 'bg-accent' : 'bg-ink-700'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${modal.autoUpdate ? 'left-[1.375rem]' : 'left-0.5'}`} />
              </span>
            </button>

            {modal.dup && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{modal.dup}</p>}
            <button onClick={() => doAdd(!!modal.dup)} disabled={modal.adding} className="btn-accent w-full py-2.5 text-sm disabled:opacity-60">
              {modal.adding ? 'Adding…' : modal.dup ? 'Add anyway' : `Add to library${modal.count ? ` (${modal.count})` : ''}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
