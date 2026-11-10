'use client';
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { additionVisibility, contentPrivacyOf, type ContentPrivacy, type ContentSelection, type ContentVisibility } from '@/lib/contentScope';
import { t as tr } from '@/lib/i18n';
import { SwitchRow } from '@/components/settings';
import { PrivateLibraryManager } from '@/components/PrivateLibraryManager';

const privacyKey = (ownerId: string | null) => ['content-privacy', ownerId] as const;

function useContentPrivacy() {
  const { user } = useAuth();
  const ownerId = user?.id ?? null;
  const query = useQuery({
    queryKey: privacyKey(ownerId),
    queryFn: async () => contentPrivacyOf(await api<unknown>('/api/personal/privacy')),
    enabled: !!ownerId, retry: false, staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false,
  });
  return { ownerId, query };
}

export function useContentScope() {
  const { ownerId, query } = useContentPrivacy();
  const [selection, setSelection] = useState<ContentSelection | null>(null);
  const visibility = additionVisibility(ownerId, query.data, selection);
  // An old cached setting may be shown while it refreshes, but it cannot authorize a new addition.
  const ready = visibility !== null && query.isFetchedAfterMount && !query.isFetching && !query.isError;
  return {
    visibility: visibility ?? 'shared' as ContentVisibility,
    ready,
    supported: query.data?.supported ?? false,
    loading: !query.isError && !ready,
    error: query.isError,
    ownerId,
    retry: () => { void query.refetch(); },
    setVisibility: (next: ContentVisibility) => { if (ownerId) setSelection({ ownerId, visibility: next }); },
  };
}

export type ContentScopeControl = ReturnType<typeof useContentScope>;

export function ContentScopePicker({ scope, disabled = false }: { scope: ContentScopeControl; disabled?: boolean }) {
  const id = useId();
  if (scope.error) return <p role="alert" className="text-xs text-amber-300" data-content-scope-error>
    {tr('Could not load privacy choices. Your files have not been added.')}{' '}
    <button type="button" onClick={scope.retry} className="underline underline-offset-2">{tr('Try again')}</button>
  </p>;
  if (scope.loading) return <p role="status" className="text-xs text-fog-500">{tr('Loading privacy choices…')}</p>;
  if (!scope.supported) return null;
  return <div data-content-scope>
    <label htmlFor={id} className="mb-1 block text-xs font-semibold text-fog-300">{tr('Library visibility')}</label>
    <select id={id} value={scope.visibility} disabled={disabled || !scope.ready}
      onChange={(e) => scope.setVisibility(e.target.value as ContentVisibility)} className="field w-full text-sm">
      <option value="private">{tr('Private library')}</option>
      <option value="shared">{tr('Shared library')}</option>
    </select>
    <p className="mt-1 text-xs leading-relaxed text-fog-500">{scope.visibility === 'private'
      ? tr('Only your account can browse and read this copy. Shared copies stay separate.')
      : tr('People with access to this library can browse and read this copy.')}</p>
  </div>;
}

export function PrivateLibraryDefaults() {
  const { ownerId, query } = useContentPrivacy();
  const qc = useQueryClient();
  if (query.isError) return <p role="alert" className="px-3 py-2 text-xs text-amber-300">
    {tr('Could not load privacy choices.')} <button type="button" onClick={() => void query.refetch()} className="underline">{tr('Try again')}</button>
  </p>;
  if (!query.data?.supported) return null;
  return <><SwitchRow id="private-additions" label={tr('Add to my private library by default')}
    help={tr('New additions are visible only to your account. You can choose a shared copy when adding. Existing shared titles stay shared.')}
    on={query.data.defaultPrivate} disabled={!ownerId}
    onChange={async (defaultPrivate) => {
      const saved = await api<{ defaultPrivate: boolean }>('/api/personal/privacy', { method: 'PUT', json: { defaultPrivate } });
      if (typeof saved.defaultPrivate !== 'boolean') throw new Error('Privacy settings unavailable');
      qc.setQueryData(privacyKey(ownerId), { ...query.data, defaultPrivate: saved.defaultPrivate });
    }} /><PrivateLibraryManager /></>;
}
