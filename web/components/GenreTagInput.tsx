'use client';
// The genre tag box: chips with a remove button and an inline field. Enter, a comma or leaving the field adds,
// Backspace on an empty field removes the last chip, Escape clears the field. While typing, the genres already
// in the library are offered (arrow keys + Enter, or tap).
import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { IcX } from './icons';
import { suggestGenres, withGenre } from '@/lib/genreTags';

export function GenreTagInput({ genres, onChange, id }: { genres: string[]; onChange: (next: string[]) => void; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const listId = `${fid}-list`;
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const known = useQuery({
    queryKey: ['genre-names'], staleTime: 10 * 60_000,
    queryFn: () => api<{ content: string[] }>('/api/genres').then((r) => (Array.isArray(r.content) ? r.content : [])),
  });
  const suggestions = useMemo(() => suggestGenres(draft, known.data ?? [], genres), [draft, known.data, genres]);

  const add = (raw: string) => {
    setDraft(''); setActive(-1); setOpen(false);
    const next = withGenre(genres, raw, known.data ?? []);
    if (next !== genres) onChange(next);
  };

  return (
    <div className="relative w-full">
      <div className="flex w-full flex-wrap gap-1.5 rounded-xl border border-ink-700 bg-ink-850 p-1.5 transition-colors focus-within:border-accent">
        {genres.map((g) => (
          <span key={g} className="inline-flex min-w-0 items-center gap-0.5 rounded-md bg-ink-700/80 py-0.5 pe-0.5 ps-2 text-xs text-fog-100">
            <bdi dir="auto" className="truncate">{g}</bdi>
            <button type="button" onClick={() => onChange(genres.filter((x) => x !== g))} aria-label={tr('Remove {name}', { name: g })}
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-fog-500 transition-colors hover:text-rose-300">
              <IcX width={12} height={12} />
            </button>
          </span>
        ))}
        <input id={fid} value={draft} dir="auto" maxLength={60} placeholder={tr('Add a genre…')}
          role="combobox" aria-expanded={open && suggestions.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          className="min-w-[8rem] flex-1 bg-transparent px-1.5 py-1 text-sm text-fog-50 outline-hidden focus-visible:outline-accent focus-visible:outline-offset-0 placeholder:text-fog-500"
          onChange={(e) => {
            if (e.target.value.endsWith(',')) { add(e.target.value); return; }
            setDraft(e.target.value); setActive(-1); setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => add(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(active >= 0 && suggestions[active] ? suggestions[active] : draft); }
            else if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); setOpen(true); setActive((a) => (a + 1) % suggestions.length); }
            else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1)); }
            else if (e.key === 'Backspace' && !draft && genres.length) onChange(genres.slice(0, -1));
            else if (e.key === 'Escape' && draft) { e.preventDefault(); e.stopPropagation(); setDraft(''); setActive(-1); }
          }} />
      </div>
      {open && suggestions.length > 0 && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-lg">
          {suggestions.map((g, i) => (
            <li key={g} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); add(g); }}
              className={`cursor-pointer px-3 py-2 text-sm text-fog-100 ${i === active ? 'bg-ink-700' : 'hover:bg-ink-700/60'}`}>
              <bdi dir="auto">{g}</bdi>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
